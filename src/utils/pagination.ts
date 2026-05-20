/**
 * Pagination utilities for Yammer's id-based cursors.
 *
 * Yammer's `older_than` / `newer_than` are message-id-based, not
 * timestamp-based, and `newer_than` semantics vary by endpoint and
 * are less reliable than `older_than`. So:
 *
 *  - `older_than` is the primary mechanism for backward traversal.
 *  - Date-window queries (`fromDate`, `newerThan`, etc.) over-fetch
 *    using `older_than` and filter client-side.
 *  - Every aggregate call enforces both a `maxItems` and a `maxPages`
 *    cap; when a cap is hit before exhausting the window, the result
 *    carries `truncated: true` plus the cursor for the next page.
 */
import type { PagedResult } from "../models/index.js";

export interface PaginateOptions<T> {
  /** Fetch a single page given an optional cursor. */
  fetchPage: (cursor: { olderThan?: string }) => Promise<T[]>;
  /** Extract the id used as the next `older_than` cursor. */
  cursorId: (item: T) => string | undefined;
  /** Optional client-side filter (e.g. for date windows). */
  filter?: (item: T) => boolean;
  /** Stop after collecting this many filtered items. Default 200. */
  maxItems?: number;
  /** Stop after fetching this many pages. Default 5. */
  maxPages?: number;
  /** Initial cursor (most recent page). */
  initialOlderThan?: string;
}

/**
 * Drive an `older_than`-style cursor to collect up to `maxItems`
 * filtered results, bounded by `maxPages`.
 */
export async function paginateOlderThan<T>(opts: PaginateOptions<T>): Promise<PagedResult<T>> {
  const maxItems = opts.maxItems ?? 200;
  const maxPages = opts.maxPages ?? 5;
  const items: T[] = [];
  let cursor: { olderThan?: string } = {};
  if (opts.initialOlderThan !== undefined) cursor.olderThan = opts.initialOlderThan;
  let pages = 0;
  let lastRawItem: T | undefined;

  while (pages < maxPages && items.length < maxItems) {
    const page = await opts.fetchPage(cursor);
    pages += 1;
    if (page.length === 0) {
      return { items, truncated: false };
    }
    for (const item of page) {
      lastRawItem = item;
      if (opts.filter && !opts.filter(item)) continue;
      items.push(item);
      if (items.length >= maxItems) break;
    }
    const last = page[page.length - 1];
    const nextCursor = last !== undefined ? opts.cursorId(last) : undefined;
    if (!nextCursor) {
      return { items, truncated: false };
    }
    cursor = { olderThan: nextCursor };
  }

  // Hit a cap; report truncation with the next cursor (best effort).
  const nextCursor = lastRawItem !== undefined ? opts.cursorId(lastRawItem) : undefined;
  const result: PagedResult<T> = { items, truncated: true };
  if (nextCursor !== undefined) result.nextOlderThan = nextCursor;
  return result;
}

/**
 * Convert an ISO date string into a numeric epoch ms for client-side
 * filtering. Returns `undefined` for invalid input so callers can
 * skip the filter.
 */
export function isoToEpoch(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : undefined;
}
