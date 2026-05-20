import { describe, it, expect } from "vitest";
import { canonicalJson, payloadHash } from "../../src/safety/payloadHash.js";

describe("canonicalJson", () => {
  it("orders object keys deterministically", () => {
    const a = canonicalJson({ b: 2, a: 1, c: { y: 2, x: 1 } });
    const b = canonicalJson({ c: { x: 1, y: 2 }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"c":{"x":1,"y":2}}');
  });

  it("skips undefined values", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("preserves arrays in order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects functions and symbols", () => {
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson(Symbol("x"))).toThrow();
  });

  it("payloadHash is stable across key orderings", () => {
    const h1 = payloadHash({ body: "hi", communityId: "1", title: "T" });
    const h2 = payloadHash({ title: "T", body: "hi", communityId: "1" });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("payloadHash changes when payload changes", () => {
    const a = payloadHash({ body: "hi", communityId: "1" });
    const b = payloadHash({ body: "hi!", communityId: "1" });
    expect(a).not.toBe(b);
  });
});
