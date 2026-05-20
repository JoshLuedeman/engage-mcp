/**
 * Canonical JSON serializer + SHA-256.
 *
 * Used to bind a confirmation token to the exact payload the user
 * approved. "Canonical" means: deterministic key ordering, no
 * insignificant whitespace, JSON.stringify-compatible value formatting.
 *
 * The implementation deliberately rejects values that would round-trip
 * unstably (functions, symbols, undefined inside objects), and treats
 * `undefined` values as if the key were absent.
 */
import * as crypto from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError("canonicalJson: non-finite numbers are not allowed");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean") return JSON.stringify(value);
  if (t === "bigint") return (value as bigint).toString();
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value type "${t}"`);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function payloadHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
