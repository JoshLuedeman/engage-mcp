import pino from "pino";

/**
 * Centralized logger. ALWAYS writes to stderr — stdout is reserved for
 * the MCP stdio framing. Use this everywhere; never use `console.log`.
 *
 * Aggressive redaction: anything that could plausibly carry a token,
 * cookie, request body, or sensitive content header is wiped. The list
 * also covers known MSAL internal field names.
 */
const REDACT_PATHS = [
  // Headers (any nesting)
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.Cookie',
  '*.["set-cookie"]',
  '*.["Set-Cookie"]',
  // OAuth / OIDC tokens (any nesting)
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  '*.client_secret',
  '*.assertion',
  '*.code',
  '*.code_verifier',
  // MSAL internals
  '*.tokenCache',
  '*.serializedCache',
  '*.cacheContents',
  '*.account.idTokenClaims',
  // Yammer message bodies (any nesting)
  '*.body.rich',
  '*.body.plain',
  '*.body.parsed',
  'body.rich',
  'body.plain',
  'body.parsed',
];

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { app: "mcp-yammer-engage" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
      remove: false,
    },
  },
  pino.destination(2), // stderr
);

/**
 * Strip token-shaped fields from an arbitrary error/object before logging.
 * Use whenever you're about to log an error that originated from MSAL or
 * an HTTP layer — those objects love to carry the access token along.
 */
export function sanitizeError(err: unknown): unknown {
  if (err === null || err === undefined) return err;
  if (typeof err !== "object") return err;
  const seen = new WeakSet<object>();
  const SENSITIVE = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "assertion",
    "code_verifier",
    "tokenCache",
    "serializedCache",
    "cacheContents",
    "rich",
    "plain",
    "parsed",
  ]);

  const clone = (val: unknown): unknown => {
    if (val === null || val === undefined) return val;
    if (typeof val !== "object") return val;
    if (seen.has(val as object)) return "[Circular]";
    seen.add(val as object);
    if (Array.isArray(val)) return val.map(clone);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = clone(v);
    }
    return out;
  };

  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(clone({ ...(err as unknown as Record<string, unknown>) }) as Record<string, unknown>),
    };
  }
  return clone(err);
}
