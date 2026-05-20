# mcp-yammer-engage

A local TypeScript MCP server that gives MCP-compatible assistants
(e.g., Clawpilot) controlled read/write access to Viva Engage / Yammer
under the signed-in user's delegated Microsoft identity.

> **Status:** in active development. The current focus is Phase 0/0.5
> (bootstrap + auth spike). See `plan.md` in the session folder for the
> full implementation plan.

## What you can do (once complete)

- List networks, communities, and recent posts you can already see.
- Read full conversation threads.
- Search messages.
- Post and reply with a **preview → confirmation-token → commit** flow
  so nothing leaves your machine without your explicit OK.
- Get structured "what changed this week" data for assistant
  summarization (the server returns data; the assistant writes prose).

## Important limitation: home network only

Microsoft's Yammer REST and Graph APIs only expose your **home
network** — the primary organization tied to your sign-in. External
networks (Engage communities hosted by other tenants) are not
accessible via API and are explicitly out of scope.

## Prerequisites

- Node.js ≥ 18.17
- A Microsoft work/school account with Viva Engage access
- An MCP-compatible assistant (Clawpilot, Claude Desktop, etc.)

## Azure App Registration (one-time, ~10 minutes)

You register your own Entra ID public-client app. Nobody else can use
it; your tokens stay on your machine.

1. Sign in to [portal.azure.com](https://portal.azure.com) with your
   work/school account.
2. **App registrations → New registration**:
   - **Name:** `mcp-yammer-engage` (or anything).
   - **Supported account types:** *Accounts in this organizational
     directory only* (single tenant) is usually correct.
   - **Redirect URI:** Platform = `Public client/native (mobile &
     desktop)`, URI = `http://localhost`.
3. Click **Register**, then on the overview page copy:
   - **Application (client) ID** → goes in `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → goes in `AZURE_TENANT_ID`
4. **API permissions → Add a permission → APIs my organization uses**
   (or *All APIs*) → search for **Yammer** → **Delegated permissions**
   → check at minimum:
   - `user_impersonation`
   - Plus, if your tenant requires them (Phase 0.5 spike will tell us):
     - `Community.Read.All`
     - `EngagementConversation.ReadWrite.All`
     - `Storyline.ReadWrite.All`
5. Click **Add permissions**. If your tenant requires admin consent,
   submit an approval request — the assistant will surface a
   `PERMISSION_DENIED` error with consent guidance on first auth.

## Build

```bash
git clone <this-repo>
cd engage-mcp
npm install
npm run build
cp .env.example .env   # then fill in AZURE_CLIENT_ID and AZURE_TENANT_ID
```

## Run

This server speaks MCP over stdio. You normally do not launch it
directly — instead, configure your MCP client to start it. A direct
run is mostly useful for the MCP Inspector.

```bash
npm start
```

## Auth flow (device-code, recommended)

On first call to any tool that needs network access, the server will
return a tool result containing a device code and verification URL.
Open the URL, enter the code, sign in. The token is cached locally
(encrypted) so subsequent runs are silent until refresh fails.

To clear cached tokens: call the `auth_clear_tokens` tool, or delete
the cache directory printed by `auth_status`.

## MCP client configuration (example)

```json
{
  "mcpServers": {
    "viva-engage": {
      "command": "node",
      "args": [
        "C:\\Users\\<you>\\path\\to\\engage-mcp\\dist\\server.js"
      ],
      "env": {
        "AZURE_CLIENT_ID": "<client-id>",
        "AZURE_TENANT_ID": "<tenant-id>"
      }
    }
  }
}
```

On Windows, prefer an explicit `node` path or a `.cmd` shim — npx
shims can confuse PATH resolution under some MCP clients.

## Security model (short version)

- Delegated identity only. No shared service account, no embedded
  secret. The server only sees what you can already see.
- Tokens are stored encrypted (AES-256-GCM) under your user's local
  cache directory, with the key in a sibling file (mode 0600).
  Protects against casual file inspection; does **not** protect
  against a local-user attacker on the same machine.
- Every write tool requires a two-step **preview → confirmation
  token → commit** flow. The token binds the exact payload, target,
  and account, and is single-use with a short TTL.
- Destructive operations (delete) additionally require a `reason`
  string and the exact message id, and the confirmation token is
  bound to the fetched message's `updatedAt` so an edit-in-flight
  invalidates it.
- All write attempts are recorded in a local append-only audit log
  (`audit.log`, JSON Lines) — bodies hashed, never logged in full.

## License

TBD (see `LICENSE` once finalized).
