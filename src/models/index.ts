/**
 * Domain models — the shapes the MCP tools expose to assistants.
 *
 * Design rules:
 *  - Always preserve raw ids alongside any enriched names so consumers
 *    can recover when references are missing/unknown.
 *  - `raw` carries an opportunistic copy of the upstream JSON for
 *    debugging; tools should NOT rely on its shape.
 */

export interface EngageNetwork {
  id: string;
  name: string;
  permalink?: string;
  webUrl?: string;
  isHome?: boolean;
}

export type CommunityPrivacy = "public" | "private" | "unknown";

export interface EngageCommunity {
  id: string;
  name: string;
  fullName?: string;
  description?: string;
  privacy: CommunityPrivacy;
  webUrl?: string;
  memberCount?: number;
  archived?: boolean;
  createdAt?: string;
  /** Opaque upstream payload — do not depend on shape. */
  raw?: unknown;
}

export interface EngageAttachment {
  id: string;
  type?: string;
  name?: string;
  contentType?: string;
  sizeBytes?: number;
  webUrl?: string;
}

export interface EngageMessage {
  id: string;
  threadId?: string;
  communityId?: string;
  communityName?: string;
  senderId?: string;
  senderName?: string;
  createdAt: string;
  updatedAt?: string;
  webUrl?: string;
  /** Plain text body. Prefer this for assistant display. */
  bodyPlain: string;
  /** Original HTML body if upstream provided one. */
  bodyHtml?: string;
  replyCount?: number;
  likedByCount?: number;
  attachments?: EngageAttachment[];
  /** True when normalization had to fall back to HTML→text conversion. */
  bodyDerivedFromHtml?: boolean;
  /** Opaque upstream payload — do not depend on shape. */
  raw?: unknown;
}

export interface EngageParticipant {
  id: string;
  name?: string;
  type?: "user" | "guest" | "bot" | "unknown";
}

export interface EngageThread {
  id: string;
  communityId?: string;
  communityName?: string;
  webUrl?: string;
  starter?: EngageMessage;
  replies: EngageMessage[];
  participants?: EngageParticipant[];
}

/**
 * A reference index built from Yammer's `references[]` arrays. Values
 * are deliberately permissive — references can be incomplete, of
 * unknown type, or refer to deleted entities.
 */
export interface ReferenceIndex {
  users: Map<string, { id: string; name?: string; type?: string }>;
  groups: Map<string, { id: string; name?: string; fullName?: string; webUrl?: string }>;
  threads: Map<string, { id: string; webUrl?: string }>;
}

export function emptyReferenceIndex(): ReferenceIndex {
  return {
    users: new Map(),
    groups: new Map(),
    threads: new Map(),
  };
}

/**
 * Generic paged tool response. `truncated` true means the call hit
 * either `maxItems` or `maxPages` before exhausting the upstream feed;
 * callers can issue another call with `nextOlderThan` to continue.
 */
export interface PagedResult<T> {
  items: T[];
  truncated: boolean;
  nextOlderThan?: string;
}

/**
 * Health metrics returned by `engage_get_community_health` (Phase 3a).
 */
export interface CommunityHealth {
  communityId: string;
  communityName: string;
  windowDays: number;
  postCount: number;
  replyCount: number;
  unansweredCount: number;
  activeAuthors: number;
  topThreads: Array<{
    threadId: string;
    starterId: string;
    snippet: string;
    replyCount: number;
    likedByCount: number;
    webUrl?: string;
  }>;
}

/**
 * Result envelope returned by `engage_summarize_recent_activity`
 * (Phase 3b multi-community scan).
 */
export interface RecentActivityResult {
  hoursAgo: number;
  communities: Array<{
    communityId: string;
    communityName: string;
    messageCount: number;
    replyCount: number;
    topThreads: Array<{ threadId: string; snippet: string; replyCount: number }>;
  }>;
  warnings: Array<{
    code: string;
    communityId?: string;
    message: string;
  }>;
  truncated?: boolean;
}
