/**
 * Phase 2 write tools.
 *
 * Contract: preview → confirmation-token → commit.
 *
 *   1. Call the tool WITHOUT `confirmationToken` → server resolves the
 *      target, validates inputs, returns a structured preview
 *      including a single-use, short-lived `confirmationToken`.
 *   2. The assistant relays the preview to the user.
 *   3. Call the tool again WITH the same `confirmationToken` AND the
 *      same payload → server re-resolves the target, re-hashes the
 *      payload, verifies the token (including a binding check against
 *      target id + payload hash + signed-in account), consumes the
 *      nonce, then issues the actual write.
 *
 * Stateless `confirm: boolean` is intentionally NOT accepted.
 */
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";
import type { YammerClient } from "../clients/yammerClient.js";
import type { MsalAuth } from "../auth/msalAuth.js";
import type { ConfirmationManager } from "../safety/confirmation.js";
import type { AuditLog } from "../safety/auditLog.js";
import { resolveCommunity } from "../utils/resolve.js";
import { validateBody, validateTitle } from "../safety/writeGuards.js";
import { payloadHash } from "../safety/payloadHash.js";
import { normalizeMessageList } from "../clients/normalize.js";
import type { EngageMessage } from "../models/index.js";

const idOrName = z.string().min(1).max(200);

export interface BuildWriteToolsDeps {
  client: YammerClient;
  auth: MsalAuth;
  confirmation: ConfirmationManager;
  audit: AuditLog;
}

export function buildWriteTools(deps: BuildWriteToolsDeps): ToolDefinition[] {
  const { client, auth, confirmation, audit } = deps;

  const postMessageInput = z
    .object({
      communityIdOrName: idOrName,
      body: z.string(),
      title: z.string().optional(),
      confirmationToken: z.string().min(1).optional(),
    })
    .strict();

  const replyToThreadInput = z
    .object({
      threadId: z.string().min(1).max(64),
      body: z.string(),
      confirmationToken: z.string().min(1).optional(),
    })
    .strict();

  return [
    {
      name: "engage_post_message",
      description:
        "Post a new message to a community. " +
        "First call returns a preview with a `confirmationToken`. " +
        "Re-call with the same `confirmationToken` AND identical payload to commit. " +
        "Attachments are not supported in this build.",
      inputSchema: postMessageInput,
      handler: async (input) => {
        const body = validateBody(input.body);
        const title = validateTitle(input.title);
        const community = await resolveCommunity(client, input.communityIdOrName);
        const accountId = await auth.getCurrentAccountId();
        const canonicalPayload: Record<string, unknown> = {
          body,
          communityId: community.id,
        };
        if (title !== undefined) canonicalPayload["title"] = title;
        const hash = payloadHash(canonicalPayload);
        const tool = "engage_post_message";

        if (!input.confirmationToken) {
          const issued = confirmation.issue({
            tool,
            accountId,
            targetId: community.id,
            payloadHash: hash,
          });
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "community",
            targetId: community.id,
            payloadHash: hash,
            status: "preview",
          });
          return {
            requiresConfirmation: true,
            action: tool,
            target: {
              kind: "community",
              id: community.id,
              name: community.name,
              webUrl: community.webUrl,
            },
            payload: { body, ...(title !== undefined ? { title } : {}) },
            summary: summarizePostPreview(community.name, body, title),
            confirmationToken: issued.token,
            expiresAt: issued.expiresAt,
          };
        }

        confirmation.verifyAndConsume(input.confirmationToken, {
          tool,
          accountId,
          targetId: community.id,
          payloadHash: hash,
        });

        try {
          const raw = await client.postMessage({
            body,
            groupId: community.id,
            ...(title !== undefined ? { title } : {}),
          });
          const { messages } = normalizeMessageList(raw);
          const posted: EngageMessage | undefined = messages[0];
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "community",
            targetId: community.id,
            payloadHash: hash,
            status: "committed",
            extra: posted ? { messageId: posted.id, threadId: posted.threadId } : undefined,
          });
          return {
            committed: true,
            action: tool,
            community: { id: community.id, name: community.name },
            message: posted,
          };
        } catch (err) {
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "community",
            targetId: community.id,
            payloadHash: hash,
            status: "failed",
            errorCode: (err as { code?: string }).code,
          });
          throw err;
        }
      },
    },

    {
      name: "engage_reply_to_thread",
      description:
        "Reply to an existing thread. " +
        "First call returns a preview with a `confirmationToken`. " +
        "Re-call with the same `confirmationToken` AND identical payload to commit.",
      inputSchema: replyToThreadInput,
      handler: async (input) => {
        const body = validateBody(input.body);
        const accountId = await auth.getCurrentAccountId();
        const canonicalPayload = { body, threadId: input.threadId };
        const hash = payloadHash(canonicalPayload);
        const tool = "engage_reply_to_thread";

        if (!input.confirmationToken) {
          const issued = confirmation.issue({
            tool,
            accountId,
            targetId: input.threadId,
            payloadHash: hash,
          });
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "thread",
            targetId: input.threadId,
            payloadHash: hash,
            status: "preview",
          });
          return {
            requiresConfirmation: true,
            action: tool,
            target: { kind: "thread", id: input.threadId },
            payload: { body },
            summary: summarizeReplyPreview(input.threadId, body),
            confirmationToken: issued.token,
            expiresAt: issued.expiresAt,
          };
        }

        confirmation.verifyAndConsume(input.confirmationToken, {
          tool,
          accountId,
          targetId: input.threadId,
          payloadHash: hash,
        });

        try {
          const raw = await client.postMessage({ body, repliedToId: input.threadId });
          const { messages } = normalizeMessageList(raw);
          const posted: EngageMessage | undefined = messages[0];
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "thread",
            targetId: input.threadId,
            payloadHash: hash,
            status: "committed",
            extra: posted ? { messageId: posted.id } : undefined,
          });
          return {
            committed: true,
            action: tool,
            threadId: input.threadId,
            message: posted,
          };
        } catch (err) {
          await audit.append({
            ts: new Date().toISOString(),
            tool,
            accountId,
            targetKind: "thread",
            targetId: input.threadId,
            payloadHash: hash,
            status: "failed",
            errorCode: (err as { code?: string }).code,
          });
          throw err;
        }
      },
    },
  ];
}

function summarizePostPreview(
  communityName: string,
  body: string,
  title: string | undefined,
): string {
  const prefix = title ? `[${title}] ` : "";
  const snippet = body.length > 120 ? `${body.slice(0, 117)}…` : body;
  return `Post to "${communityName}": ${prefix}${snippet}`;
}

function summarizeReplyPreview(threadId: string, body: string): string {
  const snippet = body.length > 120 ? `${body.slice(0, 117)}…` : body;
  return `Reply to thread ${threadId}: ${snippet}`;
}
