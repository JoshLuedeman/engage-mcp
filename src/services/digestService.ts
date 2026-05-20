/**
 * Phase 3 — community management helpers.
 *
 * This service is the data layer for the assistant-oriented tools.
 * It does NOT compose prose; it returns structured data that the
 * assistant or another caller can summarize.
 *
 * Phase 3a covers the single-community helpers. Phase 3b will add a
 * multi-community recent-activity scan with bounded concurrency and
 * partial-result tolerance.
 */
import type { YammerClient } from "../clients/yammerClient.js";
import { normalizeMessageList } from "../clients/normalize.js";
import type {
  EngageCommunity,
  EngageMessage,
  CommunityHealth,
  RecentActivityResult,
} from "../models/index.js";
import { isoToEpoch, paginateOlderThan } from "../utils/pagination.js";
import pLimit from "p-limit";
import { logger, sanitizeError } from "../utils/logger.js";
import {
  EngageRateLimitError,
  EngageValidationError,
} from "../utils/errors.js";

const DEFAULT_QUESTION_KEYWORDS = [
  "help",
  "anyone",
  "any one",
  "how do i",
  "how to",
  "stuck",
  "support",
  "where do i",
  "troubleshoot",
  "issue",
  "error",
];

export interface FindUnansweredOptions {
  /** Inclusive ISO-8601 lower bound for createdAt. */
  since?: string;
  /** Optional cap on number of candidates returned. */
  limit?: number;
  /** Override the keyword heuristic. */
  keywords?: string[];
}

export interface UnansweredCandidate {
  message: EngageMessage;
  reasons: string[];
}

export interface FindUnansweredResult {
  community: { id: string; name: string };
  candidates: UnansweredCandidate[];
  scanned: number;
  truncated: boolean;
}

export interface ComputeHealthOptions {
  /** Lookback window in days; default 7. */
  days?: number;
}

export interface RecentActivityOptions {
  /** Communities to scan. If omitted, the user's joined communities (capped by maxCommunities). */
  communities?: EngageCommunity[];
  /** Time window. Default 24h. */
  hoursAgo?: number;
  /** Refuse > this many communities without an explicit list. Default 25. */
  maxCommunities?: number;
  /** Wall-clock budget in ms; on timeout return partial results. Default 60_000. */
  budgetMs?: number;
  /** Concurrency cap. Default 2. */
  concurrency?: number;
}

export class DigestService {
  constructor(private readonly client: YammerClient) {}

  /**
   * Heuristic scan for messages that look like unanswered questions.
   * Server-side data only — no prose composition.
   *
   * Heuristics (combine — any one is enough to surface; multiple
   * reasons surfaced for transparency):
   *   - body ends with `?` or contains a `?`
   *   - body contains a configurable support keyword
   *   - replyCount === 0
   *
   * Messages older than `since` are skipped. Pagination is capped to
   * avoid runaway scans on busy communities.
   */
  async findUnansweredQuestions(
    community: EngageCommunity,
    opts: FindUnansweredOptions = {},
  ): Promise<FindUnansweredResult> {
    const limit = opts.limit ?? 25;
    const sinceEpoch = isoToEpoch(opts.since);
    const keywords = (opts.keywords ?? DEFAULT_QUESTION_KEYWORDS).map((k) => k.toLowerCase());

    let scanned = 0;
    const page = await paginateOlderThan<EngageMessage>({
      maxItems: Math.max(limit * 4, 100),
      maxPages: 5,
      fetchPage: async (cursor) => {
        const raw = await this.client.getGroupMessages(community.id, {
          limit: 50,
          ...(cursor.olderThan !== undefined ? { olderThan: cursor.olderThan } : {}),
        });
        const { messages } = normalizeMessageList(raw);
        scanned += messages.length;
        return messages;
      },
      cursorId: (m) => m.id,
      filter: (m) => {
        if (sinceEpoch === undefined) return true;
        const t = isoToEpoch(m.createdAt);
        return t === undefined ? true : t >= sinceEpoch;
      },
    });

    const candidates: UnansweredCandidate[] = [];
    for (const m of page.items) {
      const reasons = scoreMessageAsUnanswered(m, keywords);
      if (reasons.length === 0) continue;
      candidates.push({ message: m, reasons });
      if (candidates.length >= limit) break;
    }

    return {
      community: { id: community.id, name: community.name },
      candidates,
      scanned,
      truncated: page.truncated || candidates.length >= limit,
    };
  }

  /**
   * Counts + top-engagement threads in the community for the window.
   * Returns ONLY counts and references — no body content.
   */
  async computeCommunityHealth(
    community: EngageCommunity,
    opts: ComputeHealthOptions = {},
  ): Promise<CommunityHealth> {
    const days = opts.days ?? 7;
    const cutoffEpoch = Date.now() - days * 24 * 60 * 60 * 1000;

    let postCount = 0;
    let replyCount = 0;
    let unansweredCount = 0;
    const authors = new Set<string>();
    const threadAgg = new Map<
      string,
      { id: string; replies: number; likes: number; firstSeen: EngageMessage }
    >();

    const page = await paginateOlderThan<EngageMessage>({
      maxItems: 500,
      maxPages: 10,
      fetchPage: async (cursor) => {
        const raw = await this.client.getGroupMessages(community.id, {
          limit: 50,
          ...(cursor.olderThan !== undefined ? { olderThan: cursor.olderThan } : {}),
        });
        const { messages } = normalizeMessageList(raw);
        return messages;
      },
      cursorId: (m) => m.id,
      filter: (m) => {
        const t = isoToEpoch(m.createdAt);
        return t === undefined ? true : t >= cutoffEpoch;
      },
    });

    for (const m of page.items) {
      if (m.senderId) authors.add(m.senderId);
      const isStarter = m.threadId !== undefined && String(m.threadId) === String(m.id);
      if (isStarter) {
        postCount++;
        if ((m.replyCount ?? 0) === 0 && /\?/.test(m.bodyPlain)) unansweredCount++;
      } else {
        replyCount++;
      }
      const threadId = m.threadId ?? m.id;
      const agg = threadAgg.get(threadId) ?? {
        id: threadId,
        replies: 0,
        likes: 0,
        firstSeen: m,
      };
      agg.replies += m.replyCount ?? 0;
      agg.likes += m.likedByCount ?? 0;
      if (!threadAgg.has(threadId)) threadAgg.set(threadId, agg);
    }

    const topThreads: CommunityHealth["topThreads"] = Array.from(threadAgg.values())
      .sort((a, b) => b.replies + b.likes - (a.replies + a.likes))
      .slice(0, 5)
      .map((t) => ({
        threadId: t.id,
        starterId: t.firstSeen.id,
        snippet: snippet(t.firstSeen.bodyPlain),
        replyCount: t.replies,
        likedByCount: t.likes,
        ...(t.firstSeen.webUrl !== undefined ? { webUrl: t.firstSeen.webUrl } : {}),
      }));

    return {
      communityId: community.id,
      communityName: community.name,
      windowDays: days,
      postCount,
      replyCount,
      unansweredCount,
      activeAuthors: authors.size,
      topThreads,
    };
  }

  /**
   * Phase 3b multi-community scan. Returns structured per-community
   * counts + top threads in the window. Failures on individual
   * communities are isolated as warnings; the call as a whole does
   * NOT fail unless validation rejects the request.
   *
   * Resource guards:
   *   - bounded concurrency via `p-limit` (default 2);
   *   - hard cap on community count when the caller omits the list
   *     (default 25) — refuses with VALIDATION_ERROR above the cap;
   *   - wall-clock budget (default 60s); partial results returned
   *     with a `TIMEOUT` warning on cutoff.
   */
  async getRecentActivity(opts: RecentActivityOptions): Promise<RecentActivityResult> {
    const hoursAgo = opts.hoursAgo ?? 24;
    const maxCommunities = opts.maxCommunities ?? 25;
    const budgetMs = opts.budgetMs ?? 60_000;
    const concurrency = opts.concurrency ?? 2;
    const cutoffEpoch = Date.now() - hoursAgo * 60 * 60 * 1000;
    const warnings: RecentActivityResult["warnings"] = [];

    if (!opts.communities || opts.communities.length === 0) {
      throw new EngageValidationError(
        "getRecentActivity requires an explicit communities list in this build.",
        { details: { hint: "Resolve communities via engage_list_communities first." } },
      );
    }
    if (opts.communities.length > maxCommunities) {
      throw new EngageValidationError(
        `Refusing to scan ${opts.communities.length} communities (cap is ${maxCommunities}). ` +
          "Pass a smaller list or raise maxCommunities explicitly.",
        { details: { requested: opts.communities.length, max: maxCommunities } },
      );
    }

    const limit = pLimit(concurrency);
    const deadline = Date.now() + budgetMs;
    let truncated = false;

    const tasks = opts.communities.map((community) =>
      limit(async () => {
        if (Date.now() > deadline) {
          truncated = true;
          warnings.push({
            code: "TIMEOUT",
            communityId: community.id,
            message: `Skipped ${community.name}: wall-clock budget exhausted.`,
          });
          return null;
        }
        try {
          const page = await paginateOlderThan<EngageMessage>({
            maxItems: 200,
            maxPages: 5,
            fetchPage: async (cursor) => {
              const raw = await this.client.getGroupMessages(community.id, {
                limit: 50,
                ...(cursor.olderThan !== undefined ? { olderThan: cursor.olderThan } : {}),
              });
              return normalizeMessageList(raw).messages;
            },
            cursorId: (m) => m.id,
            filter: (m) => {
              const t = isoToEpoch(m.createdAt);
              return t === undefined ? true : t >= cutoffEpoch;
            },
          });
          if (page.truncated) truncated = true;
          return summarizeCommunity(community, page.items);
        } catch (err) {
          const code =
            err instanceof EngageRateLimitError
              ? "RATE_LIMITED"
              : ((err as { code?: string }).code ?? "API_ERROR");
          logger.warn(
            { community: community.id, err: sanitizeError(err) },
            "recent-activity scan failed for community",
          );
          warnings.push({
            code,
            communityId: community.id,
            message: `Failed to scan ${community.name}: ${(err as Error).message}`,
          });
          return null;
        }
      }),
    );

    const settled = await Promise.all(tasks);
    const communities = settled.filter(
      (x): x is NonNullable<typeof x> => x !== null,
    );

    return {
      hoursAgo,
      communities,
      warnings,
      truncated,
    };
  }
}

function summarizeCommunity(
  community: EngageCommunity,
  messages: EngageMessage[],
): RecentActivityResult["communities"][number] {
  let messageCount = 0;
  let replyCount = 0;
  const threads = new Map<string, { id: string; first: EngageMessage; replies: number }>();
  for (const m of messages) {
    const isStarter = m.threadId !== undefined && String(m.threadId) === String(m.id);
    if (isStarter) messageCount++;
    else replyCount++;
    const tid = m.threadId ?? m.id;
    const agg = threads.get(tid) ?? { id: tid, first: m, replies: 0 };
    agg.replies += m.replyCount ?? 0;
    if (!threads.has(tid)) threads.set(tid, agg);
  }
  const topThreads = Array.from(threads.values())
    .sort((a, b) => b.replies - a.replies)
    .slice(0, 3)
    .map((t) => ({
      threadId: t.id,
      snippet: snippet(t.first.bodyPlain),
      replyCount: t.replies,
    }));
  return {
    communityId: community.id,
    communityName: community.name,
    messageCount,
    replyCount,
    topThreads,
  };
}

function scoreMessageAsUnanswered(m: EngageMessage, keywords: string[]): string[] {
  const reasons: string[] = [];
  const body = m.bodyPlain.toLowerCase();
  if (/\?/.test(body)) reasons.push("contains_question_mark");
  // Only flag zero_replies when the count is explicitly known to be zero;
  // an undefined replyCount means "we don't know" and shouldn't flag.
  if (m.replyCount === 0) reasons.push("zero_replies");
  for (const kw of keywords) {
    if (body.includes(kw)) {
      reasons.push(`keyword:${kw}`);
      break;
    }
  }
  return reasons;
}

function snippet(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}
