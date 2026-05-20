/**
 * Auth tools: surfaces device-code login, status, and cache-clear to
 * the MCP client. The login result is structured so the assistant can
 * relay the device code + URL to the user without scraping stderr.
 */
import { z } from "zod";
import type { MsalAuth } from "../auth/msalAuth.js";
import type { ToolDefinition } from "./registry.js";

export function buildAuthTools(auth: MsalAuth): ToolDefinition[] {
  const loginInput = z
    .object({
      /** Optional, reserved for future use (e.g. force re-auth). */
      forceReauth: z.boolean().optional(),
    })
    .strict();

  const emptyInput = z.object({}).strict();

  return [
    {
      name: "auth_login",
      description:
        "Begin device-code login. Returns the user code and verification URL to relay to the user. " +
        "Blocks until the user completes the flow or the device code expires.",
      inputSchema: loginInput,
      handler: async () => {
        let challenge: {
          userCode: string;
          verificationUri: string;
          message: string;
          expiresInSeconds: number;
        } | null = null;
        const result = await auth.login((c) => {
          challenge = c;
        });
        const snapshot = await auth.snapshot();
        return {
          ok: !!result?.account,
          account: snapshot.account,
          scopes: snapshot.scopes,
          challenge,
        };
      },
    },
    {
      name: "auth_status",
      description:
        "Returns the current authentication state: signed-in account, scopes, auth mode, cache dir, " +
        "and (if a device-code login is in progress) the pending challenge. Never returns the token.",
      inputSchema: emptyInput,
      handler: async () => {
        const snap = await auth.snapshot();
        return {
          ...snap,
          pendingDeviceCode: auth.getPendingDeviceCode(),
        };
      },
    },
    {
      name: "auth_clear_tokens",
      description:
        "Wipes the encrypted token cache and key. The next API call will require a fresh `auth_login`.",
      inputSchema: emptyInput,
      handler: async () => {
        await auth.clearTokens();
        return { ok: true, message: "Token cache cleared." };
      },
    },
  ];
}
