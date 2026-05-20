# mcp-yammer-engage

A local TypeScript MCP server that gives MCP-compatible assistants
(e.g., Clawpilot) controlled read/write access to Viva Engage / Yammer
under the signed-in user's delegated Microsoft identity.

> **Status:** v0.1.0 — all 5 phases complete. Auth, read tools, safe
> writes, community-management helpers, and gated moderation are
> implemented and tested. See `CHANGELOG.md` for details. Phase 0.5
> spike script (`scripts/spike.ts`) must be run against a real tenant
> to confirm the exact Yammer scope set required for *your* tenant.

## What you can do (once complete)

- **Auth** — `auth_login`, `auth_status`, `auth_clear_tokens`. Device-code
  flow returns the verification URL and user code as structured tool data
  so the assistant can relay it.
- **Read** — list networks, communities, and recent posts you can already
  see. Read full conversation threads. Search messages. Read your feed.
- **Write** — post and reply with a **preview → confirmation-token →
  commit** flow so nothing leaves your machine without explicit
  approval.
- **Helpers** — `engage_find_unanswered_questions`,
  `engage_get_community_health`, `engage_summarize_recent_activity`.
  The server returns *structured data*; the assistant writes any prose.
- **Moderation (gated)** — `engage_like_message`,
  `engage_unlike_message`, `engage_delete_message`. Delete requires a
  reason and an `updatedAt`-bound confirmation token so an edit
  between preview and commit invalidates the token. 403/404 maps to
  `UNSUPPORTED_CAPABILITY`.

### Tool inventory

| Phase | Tools |
|---|---|
| Auth | `auth_login`, `auth_status`, `auth_clear_tokens` |
| Capability | `engage_get_capabilities` |
| Read | `engage_get_networks`, `engage_list_communities`, `engage_get_community`, `engage_get_community_messages`, `engage_get_thread`, `engage_search_messages`, `engage_get_feed` |
| Write | `engage_post_message`, `engage_reply_to_thread` |
| Helpers | `engage_find_unanswered_questions`, `engage_get_community_health`, `engage_summarize_recent_activity` |
| Moderation | `engage_like_message`, `engage_unlike_message`, `engage_delete_message` |

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

MIT — see `LICENSE`.

## When to use Engage tools (vs. other MCP servers)

- Reach for **engage-mcp** when the question is about Viva Engage
  communities, posts, threads, feeds, or activity — *not* when the
  question is about Outlook mail, Teams chats, SharePoint documents,
  or other Microsoft 365 surfaces (use the M365/Graph MCP for those).
- For unanswered-question scans across a community, prefer
  `engage_find_unanswered_questions`; for cross-community pulse
  checks prefer `engage_summarize_recent_activity` (it's the one
  with bounded concurrency and partial-result tolerance).
- The server **never** generates prose — it returns structured data
  and lets your assistant compose. If you want a written digest,
  ask the assistant to summarize the data it received back from
  `engage_summarize_recent_activity` or `engage_get_community_health`.

## Manual smoke checklist

See `scripts/manual-smoke.md` for the end-to-end checklist to run
against a real tenant after upgrading or making infrastructure
changes.
