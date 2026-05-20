/**
 * Phase 4 moderation tools.
 *
 * All write/destructive tools follow the same
 * preview → confirmation-token → commit contract as Phase 2:
 *
 *   - `engage_like_message` / `engage_unlike_message`: low-risk; standard
 *     preview that includes a snapshot of the resolved message.
 *   - `engage_delete_message`: destructive, hardened with:
 *       * required `reason` (≥ 8 chars);
 *       * preview fetches the message and embeds it in the response;
 *       * the confirmation token is bound to `{messageId, updatedAt}`
 *         so an edit between preview and commit invalidates the token;
 *       * audit log captures sender/thread/community + body hash, NOT
 *         the body itself.
 *
 * 403/404 from the underlying API is mapped to UNSUPPORTED_CAPABILITY
 * by ModerationService so the assistant can degrade gracefully.
 */
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import type { YammerClient } from "../clients/yammerClient.js";
import type { MsalAuth } from "../auth/msalAuth.js";
import type { ConfirmationManager } from "../safety/confirmation.js";
import type { AuditLog } from "../safety/auditLog.js";
import { ModerationService } from "../services/moderationService.js";
import { validateReason } from "../safety/writeGuards.js";
import { payloadHash } from "../safety/payloadHash.js";

export interface BuildModerationToolsDeps {
  client: YammerClient;
  auth: MsalAuth;
  confirmation: ConfirmationManager;
  audit: AuditLog;
}

export function buildModerationTools(deps: BuildModerationToolsDeps): ToolDefinition[] {
  const { client, auth, confirmation, audit } = deps;
  const moderation = new ModerationService(client);

  const messageIdInput = z.string().min(1).max(64);

  const likeInput = z
    .object({
      messageId: messageIdInput,
      confirmationToken: z.string().min(1).optional(),
    })
    .strict();

  const deleteInput = z
    .object({
      messageId: messageIdInput,
      reason: z.string(),
      confirmationToken: z.string().min(1).optional(),
    })
    .strict();

  return [
    likeTool("engage_like_message", "like", moderation.like.bind(moderation)),
    likeTool("engage_unlike_message", "unlike", moderation.unlike.bind(moderation)),
    {
      name: "engage_delete_message",
      description:
        "Delete a message (preview→token→commit). Requires `reason` (≥ 8 chars). " +
        "Preview returns the full resolved message so the user can confirm. " +
        "The confirmation token is bound to the message's updatedAt, so any edit " +
        "between preview and commit invalidates the token and forces a re-preview.",
      inputSchema: deleteInput,
      handler: async (input) => {
        const reason = validateReason(input.reason);
        const accountId = await auth.getCurrentAccountId();
        const message = await moderation.getMessage(input.messageId);
        const snapshot = moderation.buildDeleteSnapshot(message);
        const tool = "engage_delete_message";

        const canonicalPayload = {
          messageId: message.id,
          updatedAt: message.updatedAt ?? null,
          reason,
        };
        const hash = payloadHash(canonicalPayload);
        const targetId = `${message.id}@${message.updatedAt ?? "unknown"}`;

        if (!input.confirmationToken) {
          const issued = confirmation.issue({
            tool,
            accountId,
            targetId,
            payloadHash: hash,
          });
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "message",
            targetId: message.id,
            payloadHash: hash,
            status: "preview",
            reason,
            extra: { snapshot },
          });
          return {
            requiresConfirmation: true,
            action: tool,
            target: {
              kind: "message",
              id: message.id,
              webUrl: message.webUrl,
              threadId: message.threadId,
              communityId: message.communityId,
              senderName: message.senderName,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            },
            message,
            reason,
            confirmationToken: issued.token,
            expiresAt: issued.expiresAt,
          };
        }

        confirmation.verifyAndConsume(input.confirmationToken, {
          tool,
          accountId,
          targetId,
          payloadHash: hash,
        });

        try {
          await moderation.delete(input.messageId);
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "message",
            targetId: message.id,
            payloadHash: hash,
            status: "committed",
            reason,
            extra: { snapshot },
          });
          return { committed: true, action: tool, messageId: message.id, snapshot };
        } catch (err) {
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "message",
            targetId: message.id,
            payloadHash: hash,
            status: "failed",
            reason,
            errorCode: (err as { code?: string }).code,
            extra: { snapshot },
          });
          throw err;
        }
      },
    },
  ];

  function likeTool(
    name: string,
    verb: "like" | "unlike",
    fn: (id: string) => Promise<void>,
  ): ToolDefinition {
    return {
      name,
      description:
        `${verb === "like" ? "Like" : "Remove like from"} a message. ` +
        "Preview returns a confirmation token; re-call with the same token to commit. " +
        "Mapped to UNSUPPORTED_CAPABILITY if the tenant or your account doesn't permit it.",
      inputSchema: likeInput,
      handler: async (input) => {
        const accountId = await auth.getCurrentAccountId();
        const canonicalPayload = { messageId: input.messageId, verb };
        const hash = payloadHash(canonicalPayload);

        if (!input.confirmationToken) {
          const issued = confirmation.issue({
            tool: name,
            accountId,
            targetId: input.messageId,
            payloadHash: hash,
          });
          await audit.append({
            ts: new Date().toISOString(),
            tool: name,
            accountId,
            targetKind: "message",
            targetId: input.messageId,
            payloadHash: hash,
            status: "preview",
          });
          return {
            requiresConfirmation: true,
            action: name,
            target: { kind: "message", id: input.messageId },
            confirmationToken: issued.token,
            expiresAt: issued.expiresAt,
          };
        }

        confirmation.verifyAndConsume(input.confirmationToken, {
          tool: name,
          accountId,
          targetId: input.messageId,
          payloadHash: hash,
        });

        try {
          await fn(input.messageId);
          await audit.append({
            ts: new Date().toISOString(),
            tool: name,
            accountId,
            targetKind: "message",
            targetId: input.messageId,
            payloadHash: hash,
            status: "committed",
          });
          return { committed: true, action: name, messageId: input.messageId };
        } catch (err) {
          await audit.append({
            ts: new Date().toISOString(),
            tool: name,
            accountId,
            targetKind: "message",
            targetId: input.messageId,
            payloadHash: hash,
            status: "failed",
            errorCode: (err as { code?: string }).code,
          });
          throw err;
        }
      },
    };
  }
}
