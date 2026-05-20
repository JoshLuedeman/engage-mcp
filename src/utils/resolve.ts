/**
 * Community resolver: turn an id-or-name string into a concrete
 * community. Used by every tool that accepts `communityIdOrName`.
 *
 * Resolution rules:
 *  - Numeric input → fetch by id, normalize, return.
 *  - String input → list groups, exact case-insensitive match on
 *    `name` then `fullName`. Multiple matches throw an ambiguous
 *    error carrying all candidates so the caller can present them.
 */
import type { YammerClient } from "../clients/yammerClient.js";
import { normalizeCommunity } from "../clients/normalize.js";
import {
  EngageAmbiguousCommunityError,
  EngageNotFoundError,
  type CommunityCandidate,
} from "./errors.js";
import type { EngageCommunity } from "../models/index.js";

export interface ResolveOptions {
  /** Limit how many group-list pages to scan when matching by name. */
  maxPages?: number;
}

const NUMERIC_ID = /^[0-9]+$/;

export async function resolveCommunity(
  client: YammerClient,
  idOrName: string,
  opts: ResolveOptions = {},
): Promise<EngageCommunity> {
  const trimmed = idOrName.trim();
  if (trimmed.length === 0) {
    throw new EngageNotFoundError("Community identifier was empty.");
  }
  if (NUMERIC_ID.test(trimmed)) {
    const raw = await client.getGroup(trimmed);
    return normalizeCommunity(raw as Parameters<typeof normalizeCommunity>[0]);
  }

  const needle = trimmed.toLowerCase();
  const maxPages = opts.maxPages ?? 10;
  const matches: EngageCommunity[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const groups = await client.listGroups({ page });
    if (groups.length === 0) break;
    for (const raw of groups) {
      const c = normalizeCommunity(raw as Parameters<typeof normalizeCommunity>[0]);
      if (c.name.toLowerCase() === needle || (c.fullName?.toLowerCase() ?? "") === needle) {
        matches.push(c);
      }
    }
    if (groups.length < 20) break; // heuristic: last page
  }

  if (matches.length === 0) {
    throw new EngageNotFoundError(`No community matched "${idOrName}".`);
  }
  if (matches.length > 1) {
    const candidates: CommunityCandidate[] = matches.map((m) => {
      const c: CommunityCandidate = { id: m.id, name: m.name };
      if (m.fullName !== undefined) c.fullName = m.fullName;
      return c;
    });
    throw new EngageAmbiguousCommunityError(idOrName, candidates);
  }
  return matches[0] as EngageCommunity;
}
