# Spike Runbook — Phase 0.5

This is the **hard gate** before Phase 1 implementation. Run it once
against your tenant and lock in the scope set.

## Why this exists

Yammer REST (`https://www.yammer.com/api/v1`) historically used
Yammer-issued OAuth tokens, and some of the delegated permissions
listed in our README look more Graph-shaped than classic-Yammer
shaped. This spike confirms — empirically — that an MSAL-issued token
is accepted, what scope set actually works, and what the live response
shapes look like.

If the spike fails, the auth plan changes substantially. So we run it
before investing in the full client stack.

## Prerequisites

1. Azure app registration created per `README.md → Azure App
   Registration`.
2. `.env` populated with `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.
3. Optional but recommended:
   - `SPIKE_TARGET_GROUP_ID` — a community id you belong to (to probe
     `/messages/in_group/{id}.json`). Find it in the URL when you open
     a community in the browser.
   - `SPIKE_TARGET_THREAD_ID` — a thread id you can read.
   - `SPIKE_TEST_GROUP_ID` — a **private** test community where it's
     safe to post a throwaway message (only used with `--post`).

## Run

### Read-only probe (always start here)

```powershell
npm run spike
```

Follow the device-code prompt. The script will:

1. Acquire an MSAL token with `https://api.yammer.com/user_impersonation`
   (override via `YAMMER_SCOPES`).
2. Decode the JWT and print `aud`, `iss`, `tid`, `scp`, `appid`, `upn`.
3. Call a fixed list of read endpoints.
4. Save JSON fixtures under `test/fixtures/yammer/*.spike.json`.
5. Write `SPIKE-NOTES.local.md` (git-ignored) with a results table and
   a decision checklist.

### Write probe (optional, gated)

```powershell
npm run spike -- --post
```

Requires `SPIKE_TEST_GROUP_ID`. The script will prompt `y/N` before
posting and will refuse without explicit confirmation.

## Interpreting results

### All read endpoints returned 200

Great — the MSAL → Yammer REST path works. Proceed:

1. Open `SPIKE-NOTES.local.md` and verify:
   - `body.{plain,parsed,rich}` presence in `in-group.spike.json` /
     `in-thread.spike.json`.
   - `references[]` shape — what types appear (user, group, thread)?
   - Pagination cursor behavior.
2. Sanitize fixtures (replace usernames/IDs with synthetic values if
   needed), drop the `.spike.json` suffix to promote them to test
   fixtures.
3. Lock the working scope set in `.env.example` and the default in
   `src/config.ts`.
4. Mark the following SQL todos `done`:
   `p05-spike-write-probe` (if you ran `--post`),
   `p05-spike-fixtures`, `p05-decision-gate`.
5. Unblock Phase 1 todos.

### 401 / 403 on read endpoints

- Try broader scopes one at a time:
  ```powershell
  $env:YAMMER_SCOPES = "https://api.yammer.com/user_impersonation https://api.yammer.com/Community.Read.All"
  npm run spike
  ```
- If still 401, the audience is likely wrong — the token's `aud` claim
  should be `https://api.yammer.com` or similar. Check the spike's
  decoded JWT output.
- If 403 with `Community.Read.All` etc., your tenant likely requires
  admin consent for those permissions — request it via the Entra
  portal "API permissions → Grant admin consent" or via your admin.

### Token rejected entirely / unrecoverable

Stop. The auth path must pivot to either:
- Yammer's own OAuth flow (classic, no MSAL), or
- Microsoft Graph Engage endpoints (`/employeeExperience` + Engage
  resources, native-mode only).

Re-open the plan and re-scope Phase 1 auth before continuing.

## Cleanup

After completing the spike:

- Delete the test post manually (or via a future delete tool).
- `SPIKE-NOTES.local.md` is git-ignored — keep it locally for
  reference or delete it.
- Sanitized fixtures (without `.spike.json` suffix) are committed.
