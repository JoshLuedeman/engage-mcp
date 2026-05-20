import { describe, it, expect } from "vitest";
import { paginateOlderThan, isoToEpoch } from "../../src/utils/pagination.js";

describe("isoToEpoch", () => {
  it("parses ISO strings", () => {
    expect(isoToEpoch("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });
  it("returns undefined for invalid or empty input", () => {
    expect(isoToEpoch(undefined)).toBeUndefined();
    expect(isoToEpoch("")).toBeUndefined();
    expect(isoToEpoch("not a date")).toBeUndefined();
  });
});

describe("paginateOlderThan", () => {
  const makePage = (offset: number, size: number) =>
    Array.from({ length: size }, (_, i) => ({ id: String(offset + i), v: offset + i }));

  it("returns all items if maxItems is not reached", async () => {
    let calls = 0;
    const res = await paginateOlderThan<{ id: string; v: number }>({
      maxItems: 100,
      maxPages: 5,
      fetchPage: async () => {
        calls++;
        if (calls === 1) return makePage(0, 5);
        return []; // exhausted
      },
      cursorId: (m) => m.id,
    });
    expect(res.items).toHaveLength(5);
    expect(res.truncated).toBe(false);
    expect(res.nextOlderThan).toBeUndefined();
  });

  it("stops at maxItems and reports truncation with cursor", async () => {
    let calls = 0;
    const res = await paginateOlderThan<{ id: string; v: number }>({
      maxItems: 7,
      maxPages: 10,
      fetchPage: async () => {
        calls++;
        return makePage((calls - 1) * 5, 5);
      },
      cursorId: (m) => m.id,
    });
    expect(res.items).toHaveLength(7);
    expect(res.truncated).toBe(true);
    expect(res.nextOlderThan).toBeDefined();
  });

  it("stops at maxPages and reports truncation", async () => {
    let calls = 0;
    const res = await paginateOlderThan<{ id: string; v: number }>({
      maxItems: 1000,
      maxPages: 2,
      fetchPage: async () => {
        calls++;
        return makePage((calls - 1) * 5, 5);
      },
      cursorId: (m) => m.id,
    });
    expect(res.items).toHaveLength(10);
    expect(calls).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it("applies a filter without affecting maxItems counting until matched", async () => {
    const res = await paginateOlderThan<{ id: string; v: number }>({
      maxItems: 3,
      maxPages: 5,
      fetchPage: async () => makePage(0, 10),
      cursorId: (m) => m.id,
      filter: (m) => m.v % 2 === 0,
    });
    expect(res.items.map((i) => i.v)).toEqual([0, 2, 4]);
  });
});
