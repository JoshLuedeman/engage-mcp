/**
 * Typed Yammer REST client.
 *
 * Returns raw payloads (or lightly-shaped wrappers); normalization
 * happens in `src/clients/normalize.ts`. Tools should not touch raw
 * payloads directly — they should consume normalized models.
 *
 * Endpoint families this client covers:
 *  - GET  /networks/current.json
 *  - GET  /groups.json (paginated)
 *  - GET  /groups/{id}.json
 *  - GET  /messages/in_group/{id}.json
 *  - GET  /messages/in_thread/{id}.json
 *  - GET  /messages/my_feed.json
 *  - GET  /search.json
 *  - POST /messages.json
 *  - POST /messages/liked_by/current.json
 *  - DELETE /messages/{id}.json
 *  - DELETE /messages/liked_by/current.json?message_id={id}
 */
import type { HttpClient } from "./httpClient.js";

export interface YammerListResponse {
  messages?: unknown[];
  references?: unknown[];
  threaded_extended?: Record<string, unknown[]>;
  meta?: Record<string, unknown>;
}

export interface YammerGroupsListResponse {
  groups?: unknown[];
  // some endpoints return a bare array
}

export interface PostMessageInput {
  body: string;
  groupId?: string;
  title?: string;
  repliedToId?: string;
  /** Yammer accepts arbitrary additional fields; we keep this open. */
  extra?: Record<string, string | number | boolean>;
}

export class YammerClient {
  constructor(private readonly http: HttpClient) {}

  // ---- Read ---------------------------------------------------------------

  async getCurrentNetworks(): Promise<unknown[]> {
    const r = await this.http.request<unknown>("networks/current.json", {
      query: { list: "all" },
    });
    return Array.isArray(r) ? r : [];
  }

  async listGroups(opts: { page?: number; reverse?: boolean } = {}): Promise<unknown[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.page !== undefined) query.page = opts.page;
    if (opts.reverse !== undefined) query.reverse = opts.reverse;
    const r = await this.http.request<unknown>("groups.json", { query });
    // Yammer returns a bare array for /groups.json.
    if (Array.isArray(r)) return r;
    const wrapped = r as YammerGroupsListResponse;
    return Array.isArray(wrapped.groups) ? wrapped.groups : [];
  }

  async getGroup(groupId: string): Promise<unknown> {
    return this.http.request<unknown>(`groups/${encodeURIComponent(groupId)}.json`);
  }

  async getGroupMessages(
    groupId: string,
    opts: { limit?: number; olderThan?: string; newerThan?: string; threaded?: boolean } = {},
  ): Promise<YammerListResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.limit !== undefined) query.limit = opts.limit;
    if (opts.olderThan !== undefined) query.older_than = opts.olderThan;
    if (opts.newerThan !== undefined) query.newer_than = opts.newerThan;
    if (opts.threaded !== undefined) query.threaded = opts.threaded ? "true" : undefined;
    return this.http.request<YammerListResponse>(
      `messages/in_group/${encodeURIComponent(groupId)}.json`,
      { query },
    );
  }

  async getThread(threadId: string): Promise<YammerListResponse> {
    return this.http.request<YammerListResponse>(
      `messages/in_thread/${encodeURIComponent(threadId)}.json`,
    );
  }

  async getMyFeed(opts: { limit?: number; olderThan?: string } = {}): Promise<YammerListResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.limit !== undefined) query.limit = opts.limit;
    if (opts.olderThan !== undefined) query.older_than = opts.olderThan;
    return this.http.request<YammerListResponse>("messages/my_feed.json", { query });
  }

  async search(opts: {
    query: string;
    numPerPage?: number;
    page?: number;
  }): Promise<YammerListResponse> {
    const query: Record<string, string | number | boolean | undefined> = {
      search: opts.query,
    };
    if (opts.numPerPage !== undefined) query.num_per_page = opts.numPerPage;
    if (opts.page !== undefined) query.page = opts.page;
    return this.http.request<YammerListResponse>("search.json", { query });
  }

  // ---- Write --------------------------------------------------------------

  async postMessage(input: PostMessageInput): Promise<YammerListResponse> {
    const body: Record<string, string | number | boolean> = { body: input.body };
    if (input.groupId !== undefined) body.group_id = input.groupId;
    if (input.title !== undefined) body.title = input.title;
    if (input.repliedToId !== undefined) body.replied_to_id = input.repliedToId;
    if (input.extra) Object.assign(body, input.extra);
    return this.http.request<YammerListResponse>("messages.json", {
      method: "POST",
      body,
    });
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.http.requestRaw(`messages/${encodeURIComponent(messageId)}.json`, {
      method: "DELETE",
    });
  }

  async likeMessage(messageId: string): Promise<void> {
    await this.http.requestRaw("messages/liked_by/current.json", {
      method: "POST",
      query: { message_id: messageId },
    });
  }

  async unlikeMessage(messageId: string): Promise<void> {
    await this.http.requestRaw("messages/liked_by/current.json", {
      method: "DELETE",
      query: { message_id: messageId },
    });
  }
}
