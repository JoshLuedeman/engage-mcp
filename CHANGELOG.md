# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-06-02

### Fixed
- First successful publish to **npmjs.org**. v0.1.0 made it to GitHub
  Packages but the npmjs.org publish failed because the configured
  token didn't have 2FA bypass enabled. No code changes from v0.1.0.

## [0.1.0] — 2026-06-02

First published release. All 5 phases of the implementation plan are
complete; the package is now published to npm and GitHub Packages.

### Added
- **Zero-config startup**: if `AZURE_CLIENT_ID` is unset the server
  falls back to the Microsoft Azure CLI public client id; if
  `AZURE_TENANT_ID` is unset it falls back to the MSAL multi-tenant
  authority `organizations`, which resolves to the signed-in user's
  home tenant during device-code login. Either default emits a
  one-line stderr notice. Override via env or `.env` for clean
  attribution.
- **`npm run setup`**: interactive wizard that auto-detects the user's
  tenant from `dsregcmd /status` (Windows AAD-joined) and `az account
  show`, asks for confirmation, and writes a gitignored `.env`.
- **`npm run smoke`**: CI startup smoke that spawns the built server,
  performs an MCP `initialize` + `tools/list` over stdio, and asserts
  the well-known tools are registered. Runs in the standard CI matrix
  with no Azure values required.
- **Release pipeline**: GitHub Actions workflow tagged `v*` builds,
  tests, smokes, then publishes the package to npmjs.org (with
  provenance) and GitHub Packages, and creates a GitHub Release with
  notes extracted from this changelog.
- **Auth**: MSAL public-client device-code flow (primary) with optional
  interactive browser fallback. Encrypted on-disk token cache
  (AES-256-GCM, machine-derived key, atomic writes, file-locked).
  Tools: `auth_login`, `auth_status`, `auth_clear_tokens`.
- **Capability probe**: one-shot post-auth read-capability probe whose
  results are surfaced via `engage_get_capabilities`.
- **Read tools** (Phase 1): `engage_get_networks`,
  `engage_list_communities`, `engage_get_community`,
  `engage_get_community_messages`, `engage_get_thread`,
  `engage_search_messages`, `engage_get_feed`.
- **Safety framework** (Phase 2):
  - Canonical-JSON + SHA-256 payload hashing.
  - HMAC-SHA-256 confirmation tokens bound to
    `{tool, accountId, targetId, payloadHash, nonce, exp}`;
    single-use, 10-minute TTL.
  - Append-only JSONL audit log with size-based rotation (bodies are
    hashed, never logged in full).
- **Write tools** (Phase 2): `engage_post_message`,
  `engage_reply_to_thread` — each implements the
  preview → confirmation-token → commit contract; stateless
  `confirm: boolean` is intentionally rejected.
- **Community management helpers** (Phase 3):
  - `engage_find_unanswered_questions` — heuristic scan with
    transparent reasons (no prose composition).
  - `engage_get_community_health` — counts + top threads over a
    configurable lookback window.
  - `engage_summarize_recent_activity` — bounded-concurrency
    multi-community scan with wall-clock budget and per-community
    failure isolation as warnings.
- **Moderation tools** (Phase 4): `engage_like_message`,
  `engage_unlike_message`, `engage_delete_message`. Delete is
  hardened with a required reason (≥ 8 chars), full-message preview,
  and a confirmation token bound to the fetched message's
  `updatedAt` so an edit between preview and commit invalidates the
  token. 403/404 from the underlying API is mapped to
  `UNSUPPORTED_CAPABILITY` so the assistant can degrade gracefully.
- **Infrastructure**: strict TypeScript ESM, ESLint, Prettier, Vitest
  (unit + MSW-backed integration), pino structured logging with
  aggressive token redaction.

### Known gaps

- `engage_pin_or_feature_message` deferred — requires confirmation of
  the underlying Yammer API surface via the Phase 0.5 spike script.
- Attachment uploads not yet supported; v1 posts plain text + title
  only.
- OS keyring (DPAPI / Keychain / libsecret) migration tracked for a
  future release; AES-256-GCM file cache is the v1 compromise.
- Real-tenant fixtures (`test/fixtures/yammer/`) are not yet captured.
  Tests use synthesized fixtures derived from the documented response
  shapes; run `scripts/spike.ts` against your tenant to confirm the
  exact scope set and response shapes before relying on the server
  in production.
