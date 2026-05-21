#!/usr/bin/env node
/**
 * Interactive setup for mcp-yammer-engage.
 *
 * Detects the user's tenant from common sources, asks the user to
 * confirm (or override), and writes a local `.env` if one doesn't
 * already exist. Safe to re-run — it never overwrites existing files
 * without explicit confirmation.
 *
 * Detection order for tenant id:
 *   1. existing .env (do nothing if file exists, just report)
 *   2. process.env.AZURE_TENANT_ID
 *   3. Windows: `dsregcmd /status` → TenantId
 *   4. `az account show --query tenantId -o tsv`
 *   5. fallback: "organizations" (MSAL resolves at sign-in)
 *
 * For client id, defaults to Microsoft Azure CLI's public client id
 * so a fresh install works without an App Registration. Documented
 * caveats live in README § "Reusing an existing Microsoft public
 * client ID".
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example");

const DEFAULT_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"; // Microsoft Azure CLI
const DEFAULT_TENANT = "organizations";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tryDsregcmd() {
  if (process.platform !== "win32") return null;
  const r = spawnSync("dsregcmd", ["/status"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const m = /TenantId\s*:\s*([0-9a-f-]{36})/i.exec(r.stdout);
  return m ? m[1].toLowerCase() : null;
}

function tryAzCli() {
  const cmd = process.platform === "win32" ? "az.cmd" : "az";
  const r = spawnSync(cmd, ["account", "show", "--query", "tenantId", "-o", "tsv"], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) return null;
  const id = r.stdout.trim().toLowerCase();
  return GUID_RE.test(id) ? id : null;
}

function detectTenantId() {
  const sources = [
    { name: "env AZURE_TENANT_ID", value: (process.env.AZURE_TENANT_ID || "").trim() },
    { name: "dsregcmd /status", value: tryDsregcmd() },
    { name: "az account show", value: tryAzCli() },
  ];
  for (const s of sources) {
    if (s.value && GUID_RE.test(s.value)) {
      return { source: s.name, value: s.value };
    }
  }
  return { source: "fallback", value: DEFAULT_TENANT };
}

async function ask(rl, prompt, fallback) {
  const answer = (await rl.question(`${prompt} [${fallback}]: `)).trim();
  return answer.length > 0 ? answer : fallback;
}

function buildEnvBody({ clientId, tenantId }) {
  const example = fs.existsSync(ENV_EXAMPLE_PATH) ? fs.readFileSync(ENV_EXAMPLE_PATH, "utf8") : "";
  // Replace empty AZURE_CLIENT_ID/AZURE_TENANT_ID lines in the example
  // with the discovered values; preserve all comments and structure.
  if (example) {
    return example
      .replace(/^AZURE_CLIENT_ID=.*$/m, `AZURE_CLIENT_ID=${clientId}`)
      .replace(/^AZURE_TENANT_ID=.*$/m, `AZURE_TENANT_ID=${tenantId}`);
  }
  return [
    `AZURE_CLIENT_ID=${clientId}`,
    `AZURE_TENANT_ID=${tenantId}`,
    "",
  ].join("\n");
}

async function main() {
  console.log("mcp-yammer-engage setup");
  console.log("=======================\n");

  if (fs.existsSync(ENV_PATH)) {
    console.log(`✔ .env already exists at ${ENV_PATH}`);
    console.log("  (re-run after deleting it to reconfigure)");
    return;
  }

  const detected = detectTenantId();
  console.log(`Detected tenant id from ${detected.source}: ${detected.value}`);
  console.log(`Using public client id:                     ${DEFAULT_CLIENT_ID}`);
  console.log("  (Microsoft Azure CLI — see README for the trade-offs)\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const tenantId = await ask(rl, "AZURE_TENANT_ID", detected.value);
    const clientId = await ask(rl, "AZURE_CLIENT_ID", DEFAULT_CLIENT_ID);
    const confirm = (await rl.question(`\nWrite .env to ${ENV_PATH}? [Y/n]: `))
      .trim()
      .toLowerCase();
    if (confirm === "n" || confirm === "no") {
      console.log("Aborted. No file written.");
      return;
    }
    fs.writeFileSync(ENV_PATH, buildEnvBody({ clientId, tenantId }), { mode: 0o600 });
    console.log(`\n✔ Wrote ${ENV_PATH}`);
    console.log("  Next: npm run build && npm start (or wire into your MCP client)");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`setup failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
