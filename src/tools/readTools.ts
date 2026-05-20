/**
 * Phase 1 read tools.
 *
 * Conventions:
 *  - Return structured data only. No prose generation, no
 *    LLM-style summarization — the assistant does that.
 *  - Errors propagate as typed `EngageError` subclasses; the registry
 *    wraps them in the MCP error envelope.
 */
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import type { YammerClient } from "../clients/yammerClient.js";
import {
  normalizeCommunity,
  normalizeMessageList,
  normalizeNetwork,
  normalizeThread,
} from "../clients/normalize.js";
import { resolveCommunity } from "../utils/resolve.js";
import { isoToEpoch, paginateOlderThan } from "../utils/pagination.js";
import type { EngageCommunity, EngageMessage } from "../models/index.js";

const idOrNameInput = z.string().min(1, "communityIdOrName is required").max(200);

export function buildReadTools(client: YammerClient): ToolDefinition[] {
  const getNetworksInput = z.object({}).strict();
  const listCommunitiesInput = z
    .object({
      includeArchived: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    })
    .strict();
  const getCommunityInput = z.object({ communityIdOrName: idOrNameInput }).strict();
  const getCommunityMessagesInput = z
    .object({
      communityIdOrName: idOrNameInput,
      limit: z.number().int().positive().max(200).optional(),
      olderThan: z.string().optional(),
      newerThan: z.string().optional(),
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
    })
    .strict();
  const getThreadInput = z.object({ threadId: z.string().min(1).max(64) }).strict();
  const searchMessagesInput = z
    .object({
      query: z.string().min(1).max(500),
      communityIdOrName: idOrNameInput.optional(),
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    })
    .strict();
  const getFeedInput = z
    .object({
      feedType: z.enum(["my_feed", "storyline"]).optional(),
      limit: z.number().int().positive().max(100).optional(),
    })
    .strict();

  return [
    {
      name: "engage_get_networks",
      description:
        "List Viva Engage networks visible to the signed-in user. External networks are NOT exposed by the API.",
      inputSchema: getNetworksInput,
      handler: async () => {
        const raws = await client.getCurrentNetworks();
        return {
          networks: raws.map((r) => normalizeNetwork(r as Parameters<typeof normalizeNetwork>[0])),
        };
      },
    },
    {
      name: "engage_list_communities",
      description:
        "List communities (groups) the signed-in user can see in the home network. " +
        "Use `includeArchived` to include archived communities.",
      inputSchema: listCommunitiesInput,
      handler: async (input) => {
        const limit = input.limit ?? 100;
        const includeArchived = input.includeArchived ?? false;
        const collected: EngageCommunity[] = [];
        for (let page = 1; page <= 25 && collected.length < limit; page++) {
          const groups = await client.listGroups({ page });
          if (groups.length === 0) break;
          for (const raw of groups) {
            const c = normalizeCommunity(raw as Parameters<typeof normalizeCommunity>[0]);
            if (!includeArchived && c.archived) continue;
            collected.push(c);
            if (collected.length >= limit) break;
          }
          if (groups.length < 20) break;
        }
        return {
          communities: collected,
          truncated: collected.length >= limit,
        };
      },
    },
    {
      name: "engage_get_community",
      description: "Get metadata for a single community by id or exact name.",
      inputSchema: getCommunityInput,
      handler: async (input) => {
        const community = await resolveCommunity(client, input.communityIdOrName);
        return { community };
      },
    },
    {
      name: "engage_get_community_messages",
      description:
        "Get recent messages in a community. Supports `olderThan` for paginating backward " +
        "and `fromDate`/`toDate` for client-side date filtering.",
      inputSchema: getCommunityMessagesInput,
      handler: async (input) => {
        const community = await resolveCommunity(client, input.communityIdOrName);
        const maxItems = input.limit ?? 50;
        const fromEpoch = isoToEpoch(input.fromDate);
        const toEpoch = isoToEpoch(input.toDate);

        const result = await paginateOlderThan<EngageMessage>({
          maxItems,
          maxPages: 5,
          ...(input.olderThan !== undefined ? { initialOlderThan: input.olderThan } : {}),
          fetchPage: async (cursor) => {
            const pageOpts: { limit: number; olderThan?: string; newerThan?: string } = {
              limit: Math.min(50, maxItems),
            };
            if (cursor.olderThan !== undefined) pageOpts.olderThan = cursor.olderThan;
            if (input.newerThan !== undefined) pageOpts.newerThan = input.newerThan;
            const raw = await client.getGroupMessages(community.id, pageOpts);
            return normalizeMessageList(raw).messages;
          },
          cursorId: (m) => m.id,
          filter: (m) => {
            const t = isoToEpoch(m.createdAt);
            if (t === undefined) return true;
            if (fromEpoch !== undefined && t < fromEpoch) return false;
            if (toEpoch !== undefined && t > toEpoch) return false;
            return true;
          },
        });

        return {
          community: { id: community.id, name: community.name },
          messages: result.items,
          truncated: result.truncated,
          nextOlderThan: result.nextOlderThan,
        };
      },
    },
    {
      name: "engage_get_thread",
      description: "Get all messages in a conversation thread, with starter, replies, and participants.",
      inputSchema: getThreadInput,
      handler: async (input) => {
        const raw = await client.getThread(input.threadId);
        const thread = normalizeThread(raw, input.threadId);
        return { thread };
      },
    },
    {
      name: "engage_search_messages",
      description:
        "Search messages across the signed-in user's home network. Supports optional community scoping " +
        "and client-side date filtering.",
      inputSchema: searchMessagesInput,
      handler: async (input) => {
        const numPerPage = Math.min(20, input.limit ?? 20);
        const raw = await client.search({ query: input.query, numPerPage });
        const { messages } = normalizeMessageList(raw);
        let filtered = messages;
        if (input.communityIdOrName) {
          const community = await resolveCommunity(client, input.communityIdOrName);
          filtered = filtered.filter((m) => m.communityId === community.id);
        }
        const fromEpoch = isoToEpoch(input.fromDate);
        const toEpoch = isoToEpoch(input.toDate);
        if (fromEpoch !== undefined || toEpoch !== undefined) {
          filtered = filtered.filter((m) => {
            const t = isoToEpoch(m.createdAt);
            if (t === undefined) return true;
            if (fromEpoch !== undefined && t < fromEpoch) return false;
            if (toEpoch !== undefined && t > toEpoch) return false;
            return true;
          });
        }
        const limited = filtered.slice(0, input.limit ?? 20);
        return { query: input.query, matches: limited, returned: limited.length };
      },
    },
    {
      name: "engage_get_feed",
      description:
        "Get the signed-in user's feed (`my_feed`). `storyline` is reserved for future support.",
      inputSchema: getFeedInput,
      handler: async (input) => {
        const feedType = input.feedType ?? "my_feed";
        if (feedType === "storyline") {
          return {
            feedType,
            messages: [],
            warnings: [
              {
                code: "UNSUPPORTED_CAPABILITY",
                message:
                  "storyline feed is not implemented yet; only `my_feed` is supported in this build.",
              },
            ],
          };
        }
        const opts: { limit?: number } = {};
        if (input.limit !== undefined) opts.limit = input.limit;
        const raw = await client.getMyFeed(opts);
        const { messages } = normalizeMessageList(raw);
        return { feedType, messages };
      },
    },
  ];
}
