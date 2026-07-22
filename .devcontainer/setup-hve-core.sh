#!/usr/bin/env bash
# Best-effort, idempotent installer for the hve-core-all GitHub Copilot CLI
# plugin (from github.com/microsoft/hve-core).
#
# Shared by:
#   - .github/workflows/copilot-setup-steps.yml (Copilot cloud sandbox)
#   - .devcontainer/devcontainer.json           (dev container postCreate)
#
# This script is intentionally NON-FATAL: every step tolerates failure so the
# sandbox / dev container still starts even without network access or when the
# Copilot CLI is unavailable. Failures are surfaced as GitHub Actions warnings
# (the `::warning::` prefix is inert outside Actions).
set -euo pipefail

echo "==> Ensuring the GitHub Copilot CLI is available"
command -v copilot >/dev/null 2>&1 || npm install -g @github/copilot || echo "::warning::copilot CLI install failed"

echo "==> Registering the microsoft/hve-core plugin marketplace"
copilot plugin marketplace add microsoft/hve-core || echo "::warning::marketplace add failed"

echo "==> Installing the hve-core-all plugin"
copilot plugin install hve-core-all@hve-core || echo "::warning::hve-core-all install failed"

echo "==> Installed Copilot plugins:"
copilot plugin list || true
