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

10. **Post preview**
    - `engage_post_message { communityIdOrName: "<test-community>", body: "smoke test" }`
    - Expect `requiresConfirmation: true`, a `confirmationToken`, `expiresAt`, and the resolved community.
    - Verify no message appeared in the community.

11. **Confirm a test post**
    - Call again with the same `body` AND `confirmationToken`.
    - Expect `{ committed: true }` and the returned message id.
    - Verify it appears in the community.

12. **Confirmation invalidation**
    - Repeat steps 10–11 but tamper the body before commit → expect `CONFIRMATION_MISMATCH`.
    - Repeat with the same token twice → second commit should fail (single-use).

13. **Reply preview + confirm**
    - `engage_reply_to_thread { threadId: <from step 7>, body: "smoke reply" }` → preview.
    - Re-call with `confirmationToken` → committed.

## Phase 3 — Helpers

14. **Unanswered scan**
    - `engage_find_unanswered_questions { communityIdOrName: "<test-community>", limit: 5 }`
    - Inspect `candidates[].reasons` — each candidate should explain why it was flagged.

15. **Community health**
    - `engage_get_community_health { communityIdOrName: "<test-community>", days: 7 }`
    - Verify counts, `activeAuthors`, and `topThreads`.

16. **Multi-community summary**
    - Pick 2–3 communities (use ids; resolve them first).
    - `engage_summarize_recent_activity { communityIdsOrNames: [...], hoursAgo: 168 }`
    - Should return per-community blocks. If one of the communities is unreachable, expect a warning entry — the rest still come back.

## Phase 4 — Moderation

17. **Like → preview/commit/unlike**
    - `engage_like_message { messageId: <id from step 11> }` → preview.
    - Re-call with token → committed.
    - `engage_unlike_message { messageId }` → preview + commit.

18. **Delete a test message (hardest path)**
    - Post a throwaway test message (steps 10–11) and capture its id.
    - `engage_delete_message { messageId, reason: "manual smoke test" }` → preview returns the full resolved message.
    - Re-call with the matching `confirmationToken` → `{ committed: true }`, message disappears.
    - Verify `audit.log` in the cache directory has a `committed` entry with a `snapshot` but **no** body text.

19. **Edit-in-flight invalidation (manual)**
    - Post a fresh test message, run `engage_delete_message` preview, then edit the message in the Engage UI before confirming.
    - The commit should fail with `CONFIRMATION_MISMATCH` ("Confirmation token was issued for a different target.").

## Reporting issues

Capture, for any failure:
- The tool name and input.
- The error envelope returned (`code`, `message`, `details`).
- The relevant stderr log lines (`pino` output, level ≥ `warn`).
