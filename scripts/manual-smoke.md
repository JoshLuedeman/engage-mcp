# Manual smoke checklist

End-to-end smoke against a real tenant. Run after every phase ships.
Each step lists the MCP tool to invoke and what to look for.

## Prerequisites

- `.env` populated (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`).
- Phase 0.5 spike has succeeded — confirmed scope set in `.env.example`.
- A non-production Engage community you can post to safely.

## Phase 1 — Read tools

1. **Auth from clean state**
   - `auth_clear_tokens` → `{ ok: true }`
   - `auth_status` → `account: null`
   - `auth_login` → returns a device-code challenge; complete in browser.
   - `auth_status` → returns your account, scopes, cacheDir; no token.

2. **Capability probe**
   - `engage_get_capabilities` (first call → probes; cached after).
   - Expect `read.networks`, `read.groups`, `read.myFeed`, `read.search` = true.

3. **List networks**
   - `engage_get_networks` → returns at least one network with your home network's name.

4. **List communities**
   - `engage_list_communities { limit: 20 }` → array of communities you belong to.
   - Pick one as `<test-community>` for the remaining steps.

5. **Resolve by name**
   - `engage_get_community { communityIdOrName: "<test-community>" }` → returns the same community.
   - Try a non-existent name → expect `NOT_FOUND`.
   - If you have two communities with the same name, expect `AMBIGUOUS_COMMUNITY` with candidates.

6. **Read community messages**
   - `engage_get_community_messages { communityIdOrName: "<test-community>", limit: 10 }`
   - Verify `bodyPlain` is populated, `senderName` enriched, `webUrl` present.

7. **Read a thread**
   - Pick a `threadId` from the previous result (or any reply's `threadId`).
   - `engage_get_thread { threadId }` → returns `starter`, `replies`, `participants`.

8. **Search**
   - `engage_search_messages { query: "<term you've posted before>", limit: 5 }`
   - Verify matches are returned. Try with `communityIdOrName` to narrow.

9. **Feed**
   - `engage_get_feed { feedType: "my_feed", limit: 10 }` → returns recent feed items.

## Phase 2 — Write tools (preview/confirm)

_(not yet implemented as of this checklist)_

## Phase 3 — Helpers

_(not yet implemented)_

## Phase 4 — Moderation

_(not yet implemented)_

## Reporting issues

Capture, for any failure:
- The tool name and input.
- The error envelope returned (`code`, `message`, `details`).
- The relevant stderr log lines (`pino` output, level ≥ `warn`).
