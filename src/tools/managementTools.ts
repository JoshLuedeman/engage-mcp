/**
 * Phase 3 tools — community management helpers backed by DigestService.
 *
 * Phase 3a: single-community helpers (`unanswered_questions`, `community_health`).
 * Phase 3b: multi-community recent-activity scan with bounded concurrency
 *           and partial-result tolerance.
 */
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import type { YammerClient } from "../clients/yammerClient.js";
import { DigestService } from "../services/digestService.js";
import { resolveCommunity } from "../utils/resolve.js";
import type { EngageCommunity } from "../models/index.js";

const idOrName = z.string().min(1).max(200);

export function buildManagementTools(client: YammerClient): ToolDefinition[] {
  const digest = new DigestService(client);

  const findUnansweredInput = z
    .object({
      communityIdOrName: idOrName,
      since: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
      keywords: z.array(z.string().min(1).max(50)).max(50).optional(),
    })
    .strict();

  const healthInput = z
    .object({
      communityIdOrName: idOrName,
      days: z.number().int().positive().max(60).optional(),
    })
    .strict();

  const summarizeInput = z
    .object({
      communityIdsOrNames: z.array(idOrName).min(1).max(25),
      hoursAgo: z.number().int().positive().max(24 * 14).optional(),
      budgetMs: z.number().int().positive().max(5 * 60_000).optional(),
      concurrency: z.number().int().positive().max(5).optional(),
    })
    .strict();

  return [
    {
      name: "engage_find_unanswered_questions",
      description:
        "Heuristic scan of a single community for posts that look like unanswered questions. " +
        "Returns structured candidates with the reasons each was flagged. " +
        "Does NOT compose prose — the assistant is expected to summarize.",
      inputSchema: findUnansweredInput,
      handler: async (input) => {
        const community = await resolveCommunity(client, input.communityIdOrName);
        const opts: Parameters<typeof digest.findUnansweredQuestions>[1] = {};
        if (input.since !== undefined) opts.since = input.since;
        if (input.limit !== undefined) opts.limit = input.limit;
        if (input.keywords !== undefined) opts.keywords = input.keywords;
        return digest.findUnansweredQuestions(community, opts);
      },
    },
    {
      name: "engage_get_community_health",
      description:
        "Counts + top-engagement threads for a single community over the lookback window (default 7 days). " +
        "Returns counts and references only — no body content.",
      inputSchema: healthInput,
      handler: async (input) => {
        const community = await resolveCommunity(client, input.communityIdOrName);
        const opts: Parameters<typeof digest.computeCommunityHealth>[1] = {};
        if (input.days !== undefined) opts.days = input.days;
        return digest.computeCommunityHealth(community, opts);
      },
    },
    {
      name: "engage_summarize_recent_activity",
      description:
        "Multi-community scan: returns structured per-community counts + top threads " +
        "in the time window (default 24h). Failures on individual communities are surfaced as " +
        "warnings; the call returns partial results rather than failing the whole scan. " +
        "Bounded concurrency and a wall-clock budget protect against runaway scans.",
      inputSchema: summarizeInput,
      handler: async (input) => {
        const communities: EngageCommunity[] = [];
        const warnings: Array<{ code: string; message: string }> = [];
        for (const idOrNameValue of input.communityIdsOrNames) {
          try {
            communities.push(await resolveCommunity(client, idOrNameValue));
          } catch (err) {
            warnings.push({
              code: (err as { code?: string }).code ?? "NOT_FOUND",
              message: `Could not resolve "${idOrNameValue}": ${(err as Error).message}`,
            });
          }
        }
        const opts: Parameters<typeof digest.getRecentActivity>[0] = { communities };
        if (input.hoursAgo !== undefined) opts.hoursAgo = input.hoursAgo;
        if (input.budgetMs !== undefined) opts.budgetMs = input.budgetMs;
        if (input.concurrency !== undefined) opts.concurrency = input.concurrency;
        const result = await digest.getRecentActivity(opts);
        return { ...result, warnings: [...warnings, ...result.warnings] };
      },
    },
  ];
}
