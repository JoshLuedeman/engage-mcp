/**
 * Shared HTTP client with timeouts, exponential backoff for 429/5xx,
 * Retry-After honoring, and a bounded concurrency limiter.
 *
 * Used by the Yammer client (and any future Graph client).
 *
 * Design points:
 *  - Bearer token comes from a callback so refresh logic stays in the
 *    auth layer; this client never touches MSAL.
 *  - Errors map to typed `EngageError` subclasses via
 *    `mapHttpStatusToError`; the caller can pattern-match on `.code`.
 *  - Logs are sanitized via `sanitizeError`; we never log Authorization
 *    headers or response bodies by default.
 */
import pLimit from "p-limit";
import {
  EngageNetworkError,
  EngageRateLimitError,
  EngageTimeoutError,
  mapHttpStatusToError,
} from "../utils/errors.js";
import { logger, sanitizeError } from "../utils/logger.js";

export interface HttpClientOptions {
  /** Returns a fresh bearer token. Called per request. */
  getBearerToken: () => Promise<string>;
  /** Base URL prefix prepended to relative paths (e.g. https://www.yammer.com/api/v1). */
  baseUrl: string;
  /** Max concurrent in-flight requests. */
  maxConcurrent?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Max retry attempts for 429/5xx (initial attempt + N retries). */
  maxRetries?: number;
  /** User-Agent string. */
  userAgent?: string;
  /** Override fetch (mostly for tests). */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Optional per-request timeout override. */
  timeoutMs?: number;
  /** Force a specific Accept header (default application/json). */
  accept?: string;
  /** When true, response body is returned as text not parsed JSON. */
  asText?: boolean;
  /** Additional request headers. */
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;

function buildUrl(base: string, pathOrUrl: string, query?: RequestOptions["query"]): string {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl.startsWith("/") ? pathOrUrl.slice(1) : pathOrUrl, ensureTrailingSlash(base));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : `${s}/`;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const numeric = Number(header);
  if (Number.isFinite(numeric)) return Math.max(0, Math.round(numeric));
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  return undefined;
}

function backoffMs(attempt: number, retryAfterSeconds: number | undefined): number {
  if (retryAfterSeconds !== undefined) return retryAfterSeconds * 1000;
  // Exponential with jitter: base 500ms, doubling, max 8s.
  const base = Math.min(8000, 500 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  private readonly opts: Required<Omit<HttpClientOptions, "fetchImpl" | "userAgent">> & {
    userAgent: string;
    fetchImpl: typeof fetch;
  };
  private readonly limit: ReturnType<typeof pLimit>;

  constructor(opts: HttpClientOptions) {
    this.opts = {
      getBearerToken: opts.getBearerToken,
      baseUrl: opts.baseUrl,
      maxConcurrent: opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      userAgent: opts.userAgent ?? "mcp-yammer-engage/0.1.0-dev",
      fetchImpl: opts.fetchImpl ?? fetch,
    };
    this.limit = pLimit(this.opts.maxConcurrent);
  }

  async request<T = unknown>(pathOrUrl: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(pathOrUrl, options);
    return response.body as T;
  }

  async requestRaw(pathOrUrl: string, options: RequestOptions = {}): Promise<RawResponse> {
    return this.limit(() => this.executeWithRetry(pathOrUrl, options));
  }

  private async executeWithRetry(
    pathOrUrl: string,
    options: RequestOptions,
  ): Promise<RawResponse> {
    const url = buildUrl(this.opts.baseUrl, pathOrUrl, options.query);
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const token = await this.opts.getBearerToken();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: options.accept ?? "application/json",
          "User-Agent": this.opts.userAgent,
          ...(options.headers ?? {}),
        };
        const init: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };
        if (options.body !== undefined) {
          headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
          init.body =
            typeof options.body === "string" ? options.body : JSON.stringify(options.body);
        }

        const res = await this.opts.fetchImpl(url, init);
        clearTimeout(timeoutHandle);

        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          if (attempt < this.opts.maxRetries) {
            const waitMs = backoffMs(attempt, retryAfter);
            logger.warn(
              { url, status: res.status, attempt, waitMs },
              "HTTP retry due to status",
            );
            await sleep(waitMs);
            continue;
          }
          // Out of retries.
          if (res.status === 429) {
            throw new EngageRateLimitError(retryAfter);
          }
          const text = await safeText(res);
          throw mapHttpStatusToError(res.status, text, retryAfter);
        }

        if (!res.ok) {
          const text = await safeText(res);
          throw mapHttpStatusToError(res.status, text);
        }

        const body = options.asText ? await res.text() : await safeJson(res);
        return { status: res.status, headers: res.headers, body };
      } catch (err) {
        clearTimeout(timeoutHandle);
        lastError = err;

        // Abort due to timeout
        if (err instanceof Error && err.name === "AbortError") {
          if (attempt < this.opts.maxRetries) {
            const waitMs = backoffMs(attempt, undefined);
            logger.warn({ url, attempt, waitMs }, "HTTP timeout, retrying");
            await sleep(waitMs);
            continue;
          }
          throw new EngageTimeoutError(`Request timed out after ${timeoutMs}ms: ${url}`);
        }

        // Typed errors thrown above propagate as-is.
        if (
          err instanceof EngageRateLimitError ||
          (err as { code?: string })?.code === "RATE_LIMITED" ||
          (err as { code?: string })?.code === "API_ERROR" ||
          (err as { code?: string })?.code === "AUTH_REQUIRED" ||
          (err as { code?: string })?.code === "PERMISSION_DENIED" ||
          (err as { code?: string })?.code === "NOT_FOUND" ||
          (err as { code?: string })?.code === "CONFLICT"
        ) {
          throw err;
        }

        // Network-level failure (DNS, ECONNRESET, etc.)
        if (attempt < this.opts.maxRetries) {
          const waitMs = backoffMs(attempt, undefined);
          logger.warn(
            { url, attempt, waitMs, err: sanitizeError(err) },
            "HTTP network error, retrying",
          );
          await sleep(waitMs);
          continue;
        }
        throw new EngageNetworkError(
          `Network error talking to ${url}: ${(err as Error).message ?? String(err)}`,
          { cause: err },
        );
      }
    }
    /* istanbul ignore next */
    throw lastError ?? new EngageNetworkError("Unreachable retry loop");
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}
