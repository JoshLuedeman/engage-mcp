import { describe, it, expect } from "vitest";
import {
  validateBody,
  validateTitle,
  validateReason,
  WRITE_LIMITS,
} from "../../src/safety/writeGuards.js";

describe("writeGuards", () => {
  it("validateBody rejects empty/whitespace", () => {
    expect(() => validateBody("")).toThrow();
    expect(() => validateBody("   ")).toThrow();
  });

  it("validateBody rejects over-length", () => {
    expect(() => validateBody("a".repeat(WRITE_LIMITS.bodyMax + 1))).toThrow();
  });

  it("validateBody rejects control characters", () => {
    expect(() => validateBody("hello\u0001world")).toThrow();
  });

  it("validateBody allows newlines and tabs", () => {
    expect(validateBody("hello\nworld\ttab")).toBe("hello\nworld\ttab");
  });

  it("validateTitle is optional and enforces length", () => {
    expect(validateTitle(undefined)).toBeUndefined();
    expect(validateTitle("ok")).toBe("ok");
    expect(() => validateTitle("a".repeat(WRITE_LIMITS.titleMax + 1))).toThrow();
  });

  it("validateReason enforces min and max", () => {
    expect(() => validateReason("short")).toThrow();
    expect(validateReason("good reason here")).toBe("good reason here");
    expect(() => validateReason("a".repeat(WRITE_LIMITS.reasonMax + 1))).toThrow();
  });
});
