/**
 * Phase 4 moderation service.
 *
 * Wraps the YammerClient moderation endpoints with two extra responsibilities:
 *   1. Map 403/404 from these endpoints to UNSUPPORTED_CAPABILITY so the
 *      assistant gets a stable, distinct signal from a per-tenant
 *      permission gap vs. a transient API failure.
 *   2. Capture a metadata snapshot of any deleted message (sender,
 *      thread, community, body hash) for the audit log — never the
 *      full body.
 *
 * Tools are registered unconditionally because Yammer's REST API does
 * not expose a non-destructive way to probe like/delete capability up
 * front. Per-call gating via mapped errors is the practical compromise.
 */
import * as crypto from "node:crypto";
import type { YammerClient } from "../clients/yammerClient.js";
import {
  EngageNotFoundError,
  EngagePermissionError,
  EngageUnsupportedCapabilityError,
} from "../utils/errors.js";
import { normalizeMessage } from "../clients/normalize.js";
import type { EngageMessage } from "../models/index.js";
import { emptyReferenceIndex } from "../models/index.js";

export interface DeletedMessageSnapshot {
  messageId: string;
  threadId?: string;
  communityId?: string;
  senderId?: string;
  bodyHash: string;
  bodyLength: number;
  updatedAt?: string;
}

export class ModerationService {
  constructor(private readonly client: YammerClient) {}

  /**
   * Fetch and normalize a single message by id. Used by Phase 4 preview
   * to show the user exactly what they're about to delete.
   *
   * Yammer doesn't expose a single-message GET in the public API the way
   * Graph does; the closest reliable shape is `/messages/in_thread`,
   * which we filter client-side.
   */
  async getMessage(messageId: string): Promise<EngageMessage> {
    const raw = await this.client.getThread(messageId);
    const messages = (raw as { messages?: unknown[] }).messages ?? [];
    for (const m of messages) {
      const candidate = normalizeMessage(
        m as Parameters<typeof normalizeMessage>[0],
        emptyReferenceIndex(),
      );
      if (String(candidate.id) === String(messageId)) {
        return candidate;
      }
    }
    throw new EngageNotFoundError(`Message ${messageId} not found or not visible.`);
  }

  async like(messageId: string): Promise<void> {
    await this.callOrTranslate("like_message", () => this.client.likeMessage(messageId));
  }

  async unlike(messageId: string): Promise<void> {
    await this.callOrTranslate("unlike_message", () => this.client.unlikeMessage(messageId));
  }

  async delete(messageId: string): Promise<void> {
    await this.callOrTranslate("delete_message", () => this.client.deleteMessage(messageId));
  }

  buildDeleteSnapshot(message: EngageMessage): DeletedMessageSnapshot {
    const body = message.bodyPlain ?? "";
    const snapshot: DeletedMessageSnapshot = {
      messageId: message.id,
      bodyHash: crypto.createHash("sha256").update(body, "utf8").digest("hex"),
      bodyLength: body.length,
    };
    if (message.threadId !== undefined) snapshot.threadId = message.threadId;
    if (message.communityId !== undefined) snapshot.communityId = message.communityId;
    if (message.senderId !== undefined) snapshot.senderId = message.senderId;
    if (message.updatedAt !== undefined) snapshot.updatedAt = message.updatedAt;
    return snapshot;
  }

  private async callOrTranslate(capability: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // 403/404 from a moderation endpoint typically means the user
      // doesn't have permission to act on this message in this tenant.
      // Surface it as a distinct capability error so the assistant can
      // recover gracefully.
      if (err instanceof EngagePermissionError || err instanceof EngageNotFoundError) {
        throw new EngageUnsupportedCapabilityError(
          capability,
          `Operation "${capability}" is not available for this account on the target message.`,
          { cause: err },
        );
      }
      throw err;
    }
  }
}
