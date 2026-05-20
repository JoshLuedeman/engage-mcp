/**
 * Normalize raw Yammer REST responses into the domain models in
 * `src/models/index.ts`.
 *
 * Defensive design: references are *opportunistic*. We never fail
 * normalization when an id is missing from `references[]`, when a
 * reference has an unknown type, or when a user/group is deleted —
 * we just leave the enriched name fields undefined and preserve the
 * raw ids.
 *
 * Body text preference: `body.plain` → `body.parsed` → fall back to
 * HTML stripping on `body.rich`. `bodyDerivedFromHtml` flags the
 * fallback so consumers can warn the user if the conversion is lossy.
 */
import type {
  EngageAttachment,
  EngageCommunity,
  EngageMessage,
  EngageNetwork,
  EngageParticipant,
  EngageThread,
  ReferenceIndex,
} from "../models/index.js";
import { emptyReferenceIndex } from "../models/index.js";
import { htmlToPlainText } from "../utils/html.js";
import { logger } from "../utils/logger.js";

interface RawBody {
  plain?: string | null;
  parsed?: string | null;
  rich?: string | null;
}

interface RawReference {
  id?: string | number;
  type?: string;
  name?: string;
  full_name?: string;
  web_url?: string;
}

interface RawAttachment {
  id?: string | number;
  type?: string;
  name?: string;
  content_type?: string;
  size?: number;
  web_url?: string;
}

interface RawMessage {
  id?: string | number;
  thread_id?: string | number;
  group_id?: string | number;
  sender_id?: string | number;
  sender_type?: string;
  created_at?: string;
  updated_at?: string;
  web_url?: string;
  body?: RawBody | string | null;
  replied_to_id?: string | number;
  liked_by?: { count?: number };
  attachments?: RawAttachment[];
}

interface RawListResponse<T> {
  messages?: T[];
  references?: RawReference[];
  threaded_extended?: Record<string, T[]>;
  meta?: Record<string, unknown>;
}

function toStringId(v: string | number | undefined | null): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function pickBodyText(body: RawBody | string | null | undefined): {
  text: string;
  html?: string;
  fromHtml: boolean;
} {
  if (body === undefined || body === null) {
    return { text: "", fromHtml: false };
  }
  if (typeof body === "string") {
    return { text: body, fromHtml: false };
  }
  if (typeof body.plain === "string" && body.plain.length > 0) {
    const result: { text: string; html?: string; fromHtml: boolean } = {
      text: body.plain,
      fromHtml: false,
    };
    if (typeof body.rich === "string") result.html = body.rich;
    return result;
  }
  if (typeof body.parsed === "string" && body.parsed.length > 0) {
    const result: { text: string; html?: string; fromHtml: boolean } = {
      text: body.parsed,
      fromHtml: false,
    };
    if (typeof body.rich === "string") result.html = body.rich;
    return result;
  }
  if (typeof body.rich === "string" && body.rich.length > 0) {
    return { text: htmlToPlainText(body.rich), html: body.rich, fromHtml: true };
  }
  return { text: "", fromHtml: false };
}

/**
 * Build a reference index from a Yammer list response. Unknown
 * reference types are logged at debug and ignored.
 */
export function indexReferences(refs: RawReference[] | undefined): ReferenceIndex {
  const idx = emptyReferenceIndex();
  if (!refs || refs.length === 0) return idx;
  for (const ref of refs) {
    const id = toStringId(ref.id);
    if (!id) continue;
    const type = (ref.type ?? "").toLowerCase();
    switch (type) {
      case "user":
      case "guest":
      case "bot":
        idx.users.set(id, { id, name: ref.full_name ?? ref.name, type });
        break;
      case "group": {
        const group: { id: string; name?: string; fullName?: string; webUrl?: string } = { id };
        if (ref.name !== undefined) group.name = ref.name;
        if (ref.full_name !== undefined) group.fullName = ref.full_name;
        if (ref.web_url !== undefined) group.webUrl = ref.web_url;
        idx.groups.set(id, group);
        break;
      }
      case "thread": {
        const thread: { id: string; webUrl?: string } = { id };
        if (ref.web_url !== undefined) thread.webUrl = ref.web_url;
        idx.threads.set(id, thread);
        break;
      }
      default:
        logger.debug({ refType: ref.type, id }, "ignoring unknown reference type");
    }
  }
  return idx;
}

function normalizeAttachments(atts: RawAttachment[] | undefined): EngageAttachment[] | undefined {
  if (!atts || atts.length === 0) return undefined;
  const out: EngageAttachment[] = [];
  for (const a of atts) {
    const id = toStringId(a.id);
    if (!id) continue;
    const att: EngageAttachment = { id };
    if (a.type !== undefined) att.type = a.type;
    if (a.name !== undefined) att.name = a.name;
    if (a.content_type !== undefined) att.contentType = a.content_type;
    if (typeof a.size === "number") att.sizeBytes = a.size;
    if (a.web_url !== undefined) att.webUrl = a.web_url;
    out.push(att);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Normalize a single raw message + the reference index for context.
 */
export function normalizeMessage(raw: RawMessage, refs: ReferenceIndex): EngageMessage {
  const id = toStringId(raw.id) ?? "";
  const threadId = toStringId(raw.thread_id);
  const senderId = toStringId(raw.sender_id);
  const communityId = toStringId(raw.group_id);

  const { text, html, fromHtml } = pickBodyText(raw.body);

  const message: EngageMessage = {
    id,
    createdAt: raw.created_at ?? "",
    bodyPlain: text,
    raw,
  };
  if (threadId !== undefined) message.threadId = threadId;
  if (senderId !== undefined) message.senderId = senderId;
  if (communityId !== undefined) message.communityId = communityId;
  if (raw.updated_at) message.updatedAt = raw.updated_at;
  if (raw.web_url) message.webUrl = raw.web_url;
  if (html !== undefined) message.bodyHtml = html;
  if (fromHtml) message.bodyDerivedFromHtml = true;

  // Opportunistic enrichment from references.
  if (senderId) {
    const sender = refs.users.get(senderId);
    if (sender?.name) message.senderName = sender.name;
  }
  if (communityId) {
    const grp = refs.groups.get(communityId);
    if (grp?.name) message.communityName = grp.name;
  }

  if (typeof raw.liked_by?.count === "number") message.likedByCount = raw.liked_by.count;

  const attachments = normalizeAttachments(raw.attachments);
  if (attachments) message.attachments = attachments;

  return message;
}

/**
 * Normalize a Yammer list-of-messages response (in_group, my_feed,
 * search, etc.) using the embedded `references[]` for enrichment.
 */
export function normalizeMessageList(payload: unknown): {
  messages: EngageMessage[];
  references: ReferenceIndex;
} {
  if (payload === null || typeof payload !== "object") {
    return { messages: [], references: emptyReferenceIndex() };
  }
  const obj = payload as RawListResponse<RawMessage>;
  const refs = indexReferences(obj.references);
  const raws = Array.isArray(obj.messages) ? obj.messages : [];
  const messages: EngageMessage[] = [];
  for (const raw of raws) {
    messages.push(normalizeMessage(raw, refs));

    // Reply counts come from threaded_extended in some responses.
    const last = messages[messages.length - 1];
    if (last) {
      const tid = last.threadId ?? last.id;
      const extended = obj.threaded_extended?.[tid];
      if (Array.isArray(extended)) {
        last.replyCount = extended.length;
      }
    }
  }
  return { messages, references: refs };
}

/**
 * Normalize a thread response (`/messages/in_thread/{id}.json`).
 * Yammer returns the thread starter and replies interleaved in
 * `messages`; we sort by `created_at` and split.
 */
export function normalizeThread(payload: unknown, threadId: string): EngageThread {
  const { messages, references } = normalizeMessageList(payload);
  const sorted = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  let starter: EngageMessage | undefined;
  const replies: EngageMessage[] = [];
  for (const msg of sorted) {
    if (msg.id === threadId || msg.threadId === undefined || msg.threadId === msg.id) {
      if (!starter) {
        starter = msg;
        continue;
      }
    }
    replies.push(msg);
  }
  if (!starter && sorted.length > 0) {
    starter = sorted[0];
    replies.splice(0, 0, ...sorted.slice(1));
  }

  const participants: EngageParticipant[] = [];
  const seenAuthors = new Set<string>();
  for (const m of sorted) {
    if (!m.senderId || seenAuthors.has(m.senderId)) continue;
    seenAuthors.add(m.senderId);
    const part: EngageParticipant = { id: m.senderId };
    if (m.senderName !== undefined) part.name = m.senderName;
    participants.push(part);
  }

  const thread: EngageThread = {
    id: threadId,
    replies,
    participants,
  };
  if (starter) {
    thread.starter = starter;
    if (starter.communityId !== undefined) thread.communityId = starter.communityId;
    if (starter.communityName !== undefined) thread.communityName = starter.communityName;
  }
  const threadRef = references.threads.get(threadId);
  if (threadRef?.webUrl) thread.webUrl = threadRef.webUrl;
  return thread;
}

interface RawGroup {
  id?: string | number;
  name?: string;
  full_name?: string;
  description?: string;
  privacy?: string;
  web_url?: string;
  stats?: { members?: number };
  state?: string;
  created_at?: string;
}

export function normalizeCommunity(raw: RawGroup): EngageCommunity {
  const id = toStringId(raw.id) ?? "";
  const privacy = (() => {
    const p = (raw.privacy ?? "").toLowerCase();
    if (p === "public") return "public" as const;
    if (p === "private") return "private" as const;
    return "unknown" as const;
  })();
  const community: EngageCommunity = {
    id,
    name: raw.name ?? raw.full_name ?? "",
    privacy,
    raw,
  };
  if (raw.full_name !== undefined) community.fullName = raw.full_name;
  if (raw.description !== undefined) community.description = raw.description;
  if (raw.web_url !== undefined) community.webUrl = raw.web_url;
  if (typeof raw.stats?.members === "number") community.memberCount = raw.stats.members;
  if (raw.state) community.archived = raw.state.toLowerCase() === "archived";
  if (raw.created_at) community.createdAt = raw.created_at;
  return community;
}

interface RawNetwork {
  id?: string | number;
  name?: string;
  permalink?: string;
  web_url?: string;
  is_primary?: boolean;
  is_external?: boolean;
}

export function normalizeNetwork(raw: RawNetwork): EngageNetwork {
  const id = toStringId(raw.id) ?? "";
  const net: EngageNetwork = {
    id,
    name: raw.name ?? "",
  };
  if (raw.permalink !== undefined) net.permalink = raw.permalink;
  if (raw.web_url !== undefined) net.webUrl = raw.web_url;
  if (typeof raw.is_primary === "boolean") net.isHome = raw.is_primary && !raw.is_external;
  return net;
}
