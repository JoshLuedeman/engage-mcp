#!/usr/bin/env node
/**
 * Phase 0.5 — Auth & API Spike
 * ============================================================================
 *
 * THIS IS A THROWAWAY SCRIPT. Its job is to answer:
 *
 *   1. Does an MSAL-issued delegated access token (audience
 *      `https://api.yammer.com`) actually authenticate against
 *      `https://www.yammer.com/api/v1`?
 *   2. What is the minimum scope set we need on the app registration?
 *   3. What do real responses look like for the endpoints we plan to
 *      consume in Phase 1?
 *
 * Run it manually. Don't import from `src/` — the spike must be runnable
 * before the real code stabilizes.
 *
 * Usage:
 *   npm run spike
 *   npm run spike -- --post   # additionally probe a write (interactive y/N)
 *
 * Output:
 *   - human-readable status to stderr
 *   - SPIKE-NOTES.local.md (git-ignored) summarizing findings
 *   - test/fixtures/yammer/<endpoint>.spike.json — captured responses
 *     (review for PII before promoting to non-`.spike.json` fixtures)
 *
 * Requires (in .env or shell env):
 *   AZURE_CLIENT_ID, AZURE_TENANT_ID
 * Optional:
 *   YAMMER_SCOPES (defaults to https://api.yammer.com/user_impersonation)
 *   SPIKE_TARGET_GROUP_ID — a community id you belong to (skipped if unset)
 *   SPIKE_TARGET_THREAD_ID — a thread id you can read (skipped if unset)
 *   SPIKE_TEST_GROUP_ID — a PRIVATE test community for the write probe
 */
import { PublicClientApplication, type Configuration } from "@azure/msal-node";
import * as dotenv from "dotenv";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";

dotenv.config();

const log = (msg: string): void => {
  process.stderr.write(`[spike] ${msg}\n`);
};

interface SpikeResult {
  endpoint: string;
  status: number;
  ok: boolean;
  bytes: number;
  durationMs: number;
  rateLimitHeaders: Record<string, string>;
  bodySnippet?: string;
  error?: string;
}

const results: SpikeResult[] = [];
const FIXTURES_DIR = path.join(process.cwd(), "test", "fixtures", "yammer");

function envOrFail(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return undefined;
    const payload = parts[1];
    if (!payload) return undefined;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function acquireToken(): Promise<{ token: string; account: string }> {
  const clientId = envOrFail("AZURE_CLIENT_ID");
  const tenantId = envOrFail("AZURE_TENANT_ID");
  const scopesRaw =
    process.env.YAMMER_SCOPES ?? "https://api.yammer.com/user_impersonation";
  const scopes = scopesRaw.split(/\s+/).filter(Boolean);

  const config: Configuration = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  };
  const pca = new PublicClientApplication(config);

  log(`Acquiring token via device code (scopes: ${scopes.join(", ")})...`);
  const result = await pca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (info) => {
      process.stderr.write(`\n${info.message}\n\n`);
    },
  });
  if (!result || !result.accessToken) {
    throw new Error("Token acquisition returned no access token.");
  }
  log("Token acquired.");

  const claims = decodeJwtPayload(result.accessToken);
  if (claims) {
    const interesting = {
      aud: claims.aud,
      iss: claims.iss,
      tid: claims.tid,
      scp: claims.scp,
      appid: claims.appid,
      upn: claims.upn ?? claims.preferred_username,
    };
    log(`JWT claims: ${JSON.stringify(interesting, null, 2)}`);
  } else {
    log("WARNING: could not decode JWT payload. Token may be opaque (not a JWT).");
  }

  return {
    token: result.accessToken,
    account: result.account?.username ?? "(unknown)",
  };
}

function extractRateLimitHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (
      lk.startsWith("x-rate") ||
      lk === "retry-after" ||
      lk.startsWith("x-ratelimit") ||
      lk === "x-request-id"
    ) {
      out[lk] = value;
    }
  });
  return out;
}

async function call(
  token: string,
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
  saveFixture?: string,
): Promise<SpikeResult> {
  const url = `https://www.yammer.com/api/v1${endpoint}`;
  const start = Date.now();
  let res: Response;
  try {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    res = await fetch(url, init);
  } catch (err) {
    const result: SpikeResult = {
      endpoint,
      status: 0,
      ok: false,
      bytes: 0,
      durationMs: Date.now() - start,
      rateLimitHeaders: {},
      error: (err as Error).message,
    };
    results.push(result);
    log(`  ${method} ${endpoint} -> NETWORK ERROR (${result.error})`);
    return result;
  }

  const text = await res.text();
  const durationMs = Date.now() - start;
  const result: SpikeResult = {
    endpoint,
    status: res.status,
    ok: res.ok,
    bytes: text.length,
    durationMs,
    rateLimitHeaders: extractRateLimitHeaders(res.headers),
  };

  if (!res.ok) {
    result.bodySnippet = text.slice(0, 500);
  }

  results.push(result);
  log(
    `  ${method} ${endpoint} -> ${res.status} ${res.ok ? "OK" : "FAIL"} (${text.length} bytes, ${durationMs}ms)`,
  );
  if (!res.ok && result.bodySnippet) {
    log(`    body: ${result.bodySnippet.replace(/\s+/g, " ")}`);
  }
  if (Object.keys(result.rateLimitHeaders).length > 0) {
    log(`    rate-limit headers: ${JSON.stringify(result.rateLimitHeaders)}`);
  }

  if (saveFixture && res.ok) {
    await fs.mkdir(FIXTURES_DIR, { recursive: true });
    const fixturePath = path.join(FIXTURES_DIR, `${saveFixture}.spike.json`);
    try {
      const parsed: unknown = JSON.parse(text);
      await fs.writeFile(fixturePath, JSON.stringify(parsed, null, 2));
      log(`    saved fixture -> ${fixturePath}`);
    } catch {
      log(`    WARN: response was not valid JSON; skipping fixture save`);
    }
  }
  return result;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ans = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}

async function writeSpikeNotes(account: string, args: string[]): Promise<void> {
  const lines: string[] = [];
  lines.push("# SPIKE-NOTES — Auth & API spike");
  lines.push("");
  lines.push(`Run at: ${new Date().toISOString()}`);
  lines.push(`Account: \`${account}\``);
  lines.push(`Flags: \`${args.join(" ") || "(none)"}\``);
  lines.push("");
  lines.push("## Endpoint probe results");
  lines.push("");
  lines.push("| Endpoint | Status | OK | Bytes | ms |");
  lines.push("|---|---:|:-:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| \`${r.endpoint}\` | ${r.status} | ${r.ok ? "✓" : "✗"} | ${r.bytes} | ${r.durationMs} |`,
    );
  }
  lines.push("");
  const nonOk = results.filter((r) => !r.ok);
  if (nonOk.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const r of nonOk) {
      lines.push(`### \`${r.endpoint}\` — ${r.status}`);
      lines.push("");
      lines.push("```");
      lines.push(r.bodySnippet ?? r.error ?? "(no body)");
      lines.push("```");
      lines.push("");
    }
  }
  const withRateHeaders = results.find((r) => Object.keys(r.rateLimitHeaders).length > 0);
  if (withRateHeaders) {
    lines.push("## Rate-limit headers observed");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(withRateHeaders.rateLimitHeaders, null, 2));
    lines.push("```");
    lines.push("");
  }
  lines.push("## Decision-gate checklist");
  lines.push("");
  lines.push("- [ ] All read endpoints returned 200 with the minimal scope.");
  lines.push("- [ ] (If not) the broader Yammer delegated perms were sufficient.");
  lines.push("- [ ] (If still not) auth must pivot away from MSAL → re-plan needed.");
  lines.push("- [ ] `body.{plain,parsed,rich}` presence noted in the saved fixtures.");
  lines.push("- [ ] `references[]` shape noted (user/group/thread types observed).");
  lines.push("- [ ] Pagination semantics confirmed (`older_than` works, `newer_than` behavior).");
  lines.push("- [ ] Decision recorded below.");
  lines.push("");
  lines.push("## Decision");
  lines.push("");
  lines.push("_Fill in: proceed / broaden scopes / pivot auth path. Lock the scope set in `.env.example` and `src/config.ts` accordingly._");
  lines.push("");

  await fs.writeFile("SPIKE-NOTES.local.md", lines.join("\n"));
  log("Wrote SPIKE-NOTES.local.md");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doPost = args.includes("--post");

  const { token, account } = await acquireToken();
  log(`Signed in as: ${account}`);

  log("\n--- Read probes ---");
  await call(token, "/users/current.json", "GET", undefined, "users-current");
  await call(token, "/networks/current.json?list=all", "GET", undefined, "networks-current");
  await call(token, "/groups.json", "GET", undefined, "groups");
  await call(token, "/messages/my_feed.json?limit=5", "GET", undefined, "my-feed");
  await call(token, "/search.json?search=test&num_per_page=5", "GET", undefined, "search");

  const groupId = process.env.SPIKE_TARGET_GROUP_ID;
  if (groupId) {
    await call(
      token,
      `/messages/in_group/${groupId}.json?limit=10`,
      "GET",
      undefined,
      "in-group",
    );
  } else {
    log("  SKIP /messages/in_group/<id>.json (set SPIKE_TARGET_GROUP_ID to probe)");
  }

  const threadId = process.env.SPIKE_TARGET_THREAD_ID;
  if (threadId) {
    await call(
      token,
      `/messages/in_thread/${threadId}.json`,
      "GET",
      undefined,
      "in-thread",
    );
  } else {
    log("  SKIP /messages/in_thread/<id>.json (set SPIKE_TARGET_THREAD_ID to probe)");
  }

  if (doPost) {
    log("\n--- Write probe ---");
    const testGroupId = process.env.SPIKE_TEST_GROUP_ID;
    if (!testGroupId) {
      log("  SKIP write probe: set SPIKE_TEST_GROUP_ID to a PRIVATE test community first.");
    } else {
      const body = `[spike] auth/API probe at ${new Date().toISOString()} — please disregard. Will be deleted if delete works.`;
      log(`  Would POST to community ${testGroupId}:`);
      log(`    body: ${body}`);
      const ok = await confirm("    Proceed with POST?");
      if (ok) {
        const postResult = await call(
          token,
          "/messages.json",
          "POST",
          { body, group_id: testGroupId },
          "post-message",
        );
        if (postResult.ok) {
          log("  POST succeeded.");
        }
      } else {
        log("  Declined; skipping write.");
      }
    }
  } else {
    log("\n(--post not specified; write probe skipped)");
  }

  await writeSpikeNotes(account, args);

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    log("\n✓ All probed endpoints succeeded. Review SPIKE-NOTES.local.md and lock scopes.");
  } else {
    log(`\n✗ ${failures.length} endpoint(s) failed. See SPIKE-NOTES.local.md for details.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log(`FATAL: ${(err as Error).message}`);
  process.exitCode = 1;
});
