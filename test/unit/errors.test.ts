import { describe, it, expect } from "vitest";
import {
  EngageAmbiguousCommunityError,
  EngageApiError,
  EngageAuthError,
  EngageConflictError,
  EngageNotFoundError,
  EngagePermissionError,
  EngageRateLimitError,
  EngageTimeoutError,
  mapHttpStatusToError,
  toErrorEnvelope,
} from "../../src/utils/errors.js";

describe("mapHttpStatusToError", () => {
  it("maps 401 to EngageAuthError", () => {
    const err = mapHttpStatusToError(401, "unauthorized");
    expect(err).toBeInstanceOf(EngageAuthError);
    expect(err.code).toBe("AUTH_REQUIRED");
  });

  it("maps 403 to EngagePermissionError", () => {
    const err = mapHttpStatusToError(403, "forbidden");
    expect(err).toBeInstanceOf(EngagePermissionError);
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  it("maps 404 to EngageNotFoundError", () => {
    expect(mapHttpStatusToError(404, undefined)).toBeInstanceOf(EngageNotFoundError);
  });

  it("maps 409 to EngageConflictError", () => {
    expect(mapHttpStatusToError(409, undefined)).toBeInstanceOf(EngageConflictError);
  });

  it("maps 429 to EngageRateLimitError with retryAfter", () => {
    const err = mapHttpStatusToError(429, undefined, 30);
    expect(err).toBeInstanceOf(EngageRateLimitError);
    expect((err as EngageRateLimitError).retryAfterSeconds).toBe(30);
  });

  it("maps 500/502/503/504 to EngageApiError", () => {
    for (const status of [500, 502, 503, 504]) {
      const err = mapHttpStatusToError(status, undefined);
      expect(err).toBeInstanceOf(EngageApiError);
      expect((err as EngageApiError).status).toBe(status);
    }
  });

  it("truncates body snippets to 200 chars in details", () => {
    const long = "x".repeat(1000);
    const err = mapHttpStatusToError(401, long);
    expect(JSON.stringify(err.details)).toContain("x".repeat(200));
    expect(JSON.stringify(err.details)).not.toContain("x".repeat(201));
  });
});

describe("toErrorEnvelope", () => {
  it("wraps EngageError with code and message", () => {
    const env = toErrorEnvelope(new EngageNotFoundError("nope"));
    expect(env.error.code).toBe("NOT_FOUND");
    expect(env.error.message).toBe("nope");
  });

  it("includes retryAfterSeconds on rate-limit", () => {
    const env = toErrorEnvelope(new EngageRateLimitError(42));
    expect(env.error.retryAfterSeconds).toBe(42);
  });

  it("includes candidates detail on ambiguous community", () => {
    const env = toErrorEnvelope(
      new EngageAmbiguousCommunityError("Foo", [
        { id: "1", name: "Foo" },
        { id: "2", name: "Foo", fullName: "Foo Team" },
      ]),
    );
    expect(env.error.code).toBe("AMBIGUOUS_COMMUNITY");
    const candidates = (env.error.details?.candidates ?? []) as Array<{ id: string }>;
    expect(candidates).toHaveLength(2);
  });

  it("falls back to API_ERROR for non-Engage Error", () => {
    expect(toErrorEnvelope(new Error("oops")).error.code).toBe("API_ERROR");
  });

  it("falls back to API_ERROR for non-Error throwables", () => {
    expect(toErrorEnvelope("string-thrown").error.code).toBe("API_ERROR");
  });

  it("EngageTimeoutError maps to TIMEOUT", () => {
    expect(toErrorEnvelope(new EngageTimeoutError()).error.code).toBe("TIMEOUT");
  });
});
