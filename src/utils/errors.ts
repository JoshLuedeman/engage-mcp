/**
 * Typed error hierarchy and MCP envelope mapper.
 *
 * Every external-facing failure mode the server emits should map to one of
 * these codes. Tools catch typed errors and map them to the MCP error
 * envelope via `toErrorEnvelope`.
 *
 * NOTE: Error messages are user-facing. Never put secrets (tokens, raw
 * MSAL blobs, full request/response bodies) into `message` or `details`.
 */

export type EngageErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "AMBIGUOUS_COMMUNITY"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_MISMATCH"
  | "VALIDATION_ERROR"
  | "CACHE_ERROR"
  | "UNSUPPORTED_CAPABILITY"
  | "API_ERROR";

export interface EngageErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class EngageError extends Error {
  public readonly code: EngageErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: EngageErrorCode, message: string, opts: EngageErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "EngageError";
    this.code = code;
    if (opts.details !== undefined) {
      this.details = opts.details;
    }
  }
}

export class EngageAuthError extends EngageError {
  constructor(message = "Authentication required.", opts: EngageErrorOptions = {}) {
    super("AUTH_REQUIRED", message, opts);
    this.name = "EngageAuthError";
  }
}

export class EngagePermissionError extends EngageError {
  constructor(message = "Permission denied.", opts: EngageErrorOptions = {}) {
    super("PERMISSION_DENIED", message, opts);
    this.name = "EngagePermissionError";
  }
}

export class EngageRateLimitError extends EngageError {
  public readonly retryAfterSeconds?: number;
  constructor(retryAfterSeconds?: number, opts: EngageErrorOptions = {}) {
    super("RATE_LIMITED", "Yammer API rate limit reached.", opts);
    this.name = "EngageRateLimitError";
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class EngageTimeoutError extends EngageError {
  constructor(message = "Request timed out.", opts: EngageErrorOptions = {}) {
    super("TIMEOUT", message, opts);
    this.name = "EngageTimeoutError";
  }
}

export class EngageNetworkError extends EngageError {
  constructor(message = "Network error talking to Yammer.", opts: EngageErrorOptions = {}) {
    super("NETWORK_ERROR", message, opts);
    this.name = "EngageNetworkError";
  }
}

export class EngageNotFoundError extends EngageError {
  constructor(message = "Resource not found.", opts: EngageErrorOptions = {}) {
    super("NOT_FOUND", message, opts);
    this.name = "EngageNotFoundError";
  }
}

export class EngageConflictError extends EngageError {
  constructor(message = "Conflict with current resource state.", opts: EngageErrorOptions = {}) {
    super("CONFLICT", message, opts);
    this.name = "EngageConflictError";
  }
}

export interface CommunityCandidate {
  id: string;
  name: string;
  fullName?: string;
}

export class EngageAmbiguousCommunityError extends EngageError {
  public readonly candidates: CommunityCandidate[];
  constructor(query: string, candidates: CommunityCandidate[], opts: EngageErrorOptions = {}) {
    super(
      "AMBIGUOUS_COMMUNITY",
      `Multiple communities match "${query}". Disambiguate by id or full name.`,
      { ...opts, details: { ...opts.details, query, candidates } },
    );
    this.name = "EngageAmbiguousCommunityError";
    this.candidates = candidates;
  }
}

export class EngageConfirmationRequiredError extends EngageError {
  constructor(message = "This action requires confirmation.", opts: EngageErrorOptions = {}) {
    super("CONFIRMATION_REQUIRED", message, opts);
    this.name = "EngageConfirmationRequiredError";
  }
}

export class EngageConfirmationExpiredError extends EngageError {
  constructor(message = "Confirmation token has expired. Re-preview the action.", opts: EngageErrorOptions = {}) {
    super("CONFIRMATION_EXPIRED", message, opts);
    this.name = "EngageConfirmationExpiredError";
  }
}

export class EngageConfirmationMismatchError extends EngageError {
  constructor(
    message = "Confirmation token does not match the requested action or payload.",
    opts: EngageErrorOptions = {},
  ) {
    super("CONFIRMATION_MISMATCH", message, opts);
    this.name = "EngageConfirmationMismatchError";
  }
}

export class EngageValidationError extends EngageError {
  constructor(message: string, opts: EngageErrorOptions = {}) {
    super("VALIDATION_ERROR", message, opts);
    this.name = "EngageValidationError";
  }
}

export class EngageCacheError extends EngageError {
  constructor(message = "Token cache error.", opts: EngageErrorOptions = {}) {
    super("CACHE_ERROR", message, opts);
    this.name = "EngageCacheError";
  }
}

export class EngageUnsupportedCapabilityError extends EngageError {
  constructor(
    capability: string,
    message = `This capability is not available for the signed-in user: ${capability}.`,
    opts: EngageErrorOptions = {},
  ) {
    super("UNSUPPORTED_CAPABILITY", message, { ...opts, details: { ...opts.details, capability } });
    this.name = "EngageUnsupportedCapabilityError";
  }
}

export class EngageApiError extends EngageError {
  public readonly status: number;
  constructor(status: number, message: string, opts: EngageErrorOptions = {}) {
    super("API_ERROR", message, { ...opts, details: { ...opts.details, status } });
    this.name = "EngageApiError";
    this.status = status;
  }
}

/**
 * Map a raw HTTP response to the most appropriate typed error.
 *
 * `body` should already be a parsed JSON object (or string), NOT the
 * stream. Callers MUST NOT include the body verbatim in the error
 * `details` if it may contain user content; we summarize instead.
 */
export function mapHttpStatusToError(
  status: number,
  bodySnippet: string | undefined,
  retryAfterSeconds?: number,
): EngageError {
  const snippet =
    typeof bodySnippet === "string" && bodySnippet.length > 0
      ? bodySnippet.slice(0, 200)
      : undefined;

  if (status === 401) {
    return new EngageAuthError(
      "Yammer API returned 401. The cached token is invalid or revoked.",
      snippet ? { details: { snippet } } : {},
    );
  }
  if (status === 403) {
    return new EngagePermissionError(
      "Yammer API returned 403. Your account lacks permission for this operation.",
      snippet ? { details: { snippet } } : {},
    );
  }
  if (status === 404) {
    return new EngageNotFoundError(
      "Yammer API returned 404. The target resource does not exist or is not visible to you.",
    );
  }
  if (status === 409) {
    return new EngageConflictError("Yammer API returned 409.");
  }
  if (status === 429) {
    return new EngageRateLimitError(retryAfterSeconds);
  }
  if (status >= 500 && status < 600) {
    return new EngageApiError(status, `Yammer API returned ${status} (server error).`,
      snippet ? { details: { snippet } } : {},
    );
  }
  return new EngageApiError(status, `Yammer API returned ${status}.`,
    snippet ? { details: { snippet } } : {},
  );
}

export interface ErrorEnvelope {
  error: {
    code: EngageErrorCode;
    message: string;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  };
}

/**
 * Convert any thrown value into the MCP error envelope shape.
 * Always safe — never re-throws.
 */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof EngageError) {
    const env: ErrorEnvelope = {
      error: {
        code: err.code,
        message: err.message,
      },
    };
    if (err instanceof EngageRateLimitError && err.retryAfterSeconds !== undefined) {
      env.error.retryAfterSeconds = err.retryAfterSeconds;
    }
    if (err.details !== undefined) {
      env.error.details = err.details;
    }
    return env;
  }
  if (err instanceof Error) {
    return {
      error: {
        code: "API_ERROR",
        message: err.message || "Unknown error.",
      },
    };
  }
  return {
    error: {
      code: "API_ERROR",
      message: "Unknown error.",
    },
  };
}
