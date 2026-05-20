/**
 * Confirmation-token issue and verify.
 *
 * A confirmation token is an HMAC-SHA-256 signed record that binds:
 *   { tool, accountId, targetId, payloadHash, nonce, exp }
 *
 * Tokens are single-use (nonce tracked in an in-memory LRU set with
 * cap on size) and short-lived (default 10 minutes). The HMAC key is
 * generated once at process start and kept only in memory — process
 * restart invalidates every outstanding token, which is desired.
 *
 * The commit path MUST re-resolve targets and re-hash the payload,
 * then call `verifyToken` with the recomputed values. Any deviation
 * yields `CONFIRMATION_MISMATCH`; expiry yields `CONFIRMATION_EXPIRED`.
 *
 * Token wire format (URL-safe base64):
 *   base64url(JSON({ v:1, t, a, g, h, n, x })).base64url(hmac)
 *
 * Field names are intentionally terse to keep the token short.
 */
import * as crypto from "node:crypto";
import {
  EngageConfirmationExpiredError,
  EngageConfirmationMismatchError,
} from "../utils/errors.js";

export interface ConfirmationClaims {
  tool: string;
  accountId: string;
  targetId: string;
  payloadHash: string;
}

interface InternalClaims extends ConfirmationClaims {
  nonce: string;
  exp: number; // epoch ms
}

export interface ConfirmationManagerOptions {
  ttlMs?: number;
  maxNonces?: number;
  /** Override for tests. */
  hmacKey?: Buffer;
  /** Override for tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_NONCES = 1000;

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

export class ConfirmationManager {
  private readonly key: Buffer;
  private readonly ttlMs: number;
  private readonly maxNonces: number;
  private readonly now: () => number;
  // Insertion-ordered set acts as an LRU; Map gives O(1) consumption.
  private readonly consumedNonces = new Map<string, number>();

  constructor(opts: ConfirmationManagerOptions = {}) {
    this.key = opts.hmacKey ?? crypto.randomBytes(32);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxNonces = opts.maxNonces ?? DEFAULT_MAX_NONCES;
    this.now = opts.now ?? (() => Date.now());
  }

  issue(claims: ConfirmationClaims): { token: string; expiresAt: string; nonce: string } {
    const nonce = b64urlEncode(crypto.randomBytes(16));
    const exp = this.now() + this.ttlMs;
    const internal: InternalClaims = { ...claims, nonce, exp };
    const header = b64urlEncode(Buffer.from(JSON.stringify(this.compactClaims(internal)), "utf8"));
    const sig = b64urlEncode(this.sign(header));
    return {
      token: `${header}.${sig}`,
      expiresAt: new Date(exp).toISOString(),
      nonce,
    };
  }

  /**
   * Verify a token against expected claims AND mark its nonce consumed.
   *
   * On any mismatch throws `EngageConfirmationMismatchError`; on expiry
   * throws `EngageConfirmationExpiredError`. The nonce is consumed
   * **before** the caller's API write, so a transient failure on commit
   * forces a re-preview rather than allowing a silent replay.
   *
   * IMPORTANT: pass the expected claims (recomputed from current state),
   * NOT the claims the assistant relayed back.
   */
  verifyAndConsume(token: string, expected: ConfirmationClaims): void {
    const claims = this.decodeAndVerifySignature(token);
    if (claims.exp < this.now()) {
      throw new EngageConfirmationExpiredError();
    }
    if (claims.tool !== expected.tool) {
      throw new EngageConfirmationMismatchError(
        "Confirmation token was issued for a different tool.",
        { details: { expected: "matching tool", actual: claims.tool } },
      );
    }
    if (claims.accountId !== expected.accountId) {
      throw new EngageConfirmationMismatchError(
        "Confirmation token was issued for a different signed-in account.",
      );
    }
    if (claims.targetId !== expected.targetId) {
      throw new EngageConfirmationMismatchError(
        "Confirmation token was issued for a different target.",
      );
    }
    if (claims.payloadHash !== expected.payloadHash) {
      throw new EngageConfirmationMismatchError(
        "Payload has changed since the preview was issued. Re-preview before confirming.",
      );
    }
    if (this.consumedNonces.has(claims.nonce)) {
      throw new EngageConfirmationMismatchError(
        "This confirmation token has already been used. Re-preview to obtain a fresh one.",
      );
    }
    this.consumeNonce(claims.nonce);
  }

  private decodeAndVerifySignature(token: string): InternalClaims {
    const parts = token.split(".");
    if (parts.length !== 2) {
      throw new EngageConfirmationMismatchError("Malformed confirmation token.");
    }
    const [header, sig] = parts as [string, string];
    const expectedSig = b64urlEncode(this.sign(header));
    if (
      sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expectedSig, "utf8"))
    ) {
      throw new EngageConfirmationMismatchError("Confirmation token signature is invalid.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(b64urlDecode(header).toString("utf8"));
    } catch {
      throw new EngageConfirmationMismatchError("Confirmation token payload is unreadable.");
    }
    return this.expandClaims(parsed);
  }

  private compactClaims(c: InternalClaims): Record<string, unknown> {
    return {
      v: 1,
      t: c.tool,
      a: c.accountId,
      g: c.targetId,
      h: c.payloadHash,
      n: c.nonce,
      x: c.exp,
    };
  }

  private expandClaims(raw: unknown): InternalClaims {
    if (!raw || typeof raw !== "object") {
      throw new EngageConfirmationMismatchError("Confirmation token has invalid shape.");
    }
    const o = raw as Record<string, unknown>;
    if (o["v"] !== 1) {
      throw new EngageConfirmationMismatchError("Confirmation token version is unsupported.");
    }
    const required: Record<string, "string" | "number"> = {
      t: "string",
      a: "string",
      g: "string",
      h: "string",
      n: "string",
      x: "number",
    };
    for (const [k, kind] of Object.entries(required)) {
      if (typeof o[k] !== kind) {
        throw new EngageConfirmationMismatchError("Confirmation token has invalid shape.");
      }
    }
    return {
      tool: o["t"] as string,
      accountId: o["a"] as string,
      targetId: o["g"] as string,
      payloadHash: o["h"] as string,
      nonce: o["n"] as string,
      exp: o["x"] as number,
    };
  }

  private sign(header: string): Buffer {
    return crypto.createHmac("sha256", this.key).update(header, "utf8").digest();
  }

  private consumeNonce(nonce: string): void {
    this.consumedNonces.set(nonce, this.now());
    while (this.consumedNonces.size > this.maxNonces) {
      const first = this.consumedNonces.keys().next();
      if (first.done) break;
      this.consumedNonces.delete(first.value);
    }
  }
}
