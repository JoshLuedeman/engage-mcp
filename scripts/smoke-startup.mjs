#!/usr/bin/env node
/**
 * CI startup smoke test.
 *
 * Spawns the built server, performs an MCP `initialize` handshake +
 * `tools/list` request over stdio, asserts a basic shape, then exits
 * cleanly. No network calls reach Yammer/Azure — the server only
 * contacts those when a tool that needs auth is invoked.
 *
 * Required env: AZURE_CLIENT_ID, AZURE_TENANT_ID (any non-empty values
 * are fine; CI plumbs real-ish defaults via secrets-with-fallback).
 *
 * Exit codes:
 *   0  smoke passed
 *   1  smoke failed (assertion / timeout / server crash)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.resolve(__dirname, "..", "dist", "server.js");
const TIMEOUT_MS = 10_000;

function fail(msg) {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      // Force a writable, ephemeral cache dir so the test doesn't
      // collide with a developer's real cache.
      TOKEN_CACHE_DIR: path.join(process.cwd(), ".ci-smoke-cache"),
      LOG_LEVEL: "error",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  let buffer = "";
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        fail(`invalid JSON line from server: ${err.message} — ${line.slice(0, 120)}`);
      }
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });

  child.on("error", (err) => fail(`spawn error: ${err.message}`));
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      fail(`server exited unexpectedly with code ${code} (signal ${signal})`);
    }
  });

  function send(method, params, id) {
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(body + "\n", "utf8", (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}#${id}`));
        }
      }, TIMEOUT_MS);
    });
  }

  try {
    const initRes = await send(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ci-smoke", version: "0.0.0" },
      },
      1,
    );
    if (!initRes.result?.serverInfo?.name) {
      fail(`initialize missing serverInfo: ${JSON.stringify(initRes)}`);
    }
    process.stderr.write(
      `[smoke] initialize OK — server: ${initRes.result.serverInfo.name}@${initRes.result.serverInfo.version}\n`,
    );

    const listRes = await send("tools/list", {}, 2);
    const tools = listRes.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      fail(`tools/list returned no tools: ${JSON.stringify(listRes)}`);
    }
    const names = tools.map((t) => t.name).sort();
    process.stderr.write(`[smoke] tools/list OK — ${tools.length} tools registered\n`);

    // Sanity: a few well-known tools must be present.
    const expected = [
      "auth_status",
      "engage_list_communities",
      "engage_post_message",
      "engage_summarize_recent_activity",
      "engage_delete_message",
    ];
    for (const name of expected) {
      if (!names.includes(name)) {
        fail(`expected tool "${name}" not registered. got: ${names.join(", ")}`);
      }
    }
    process.stderr.write(`[smoke] all expected tools present\n`);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }

  process.stderr.write(`[smoke] PASS\n`);
  process.exit(0);
}

main().catch((err) => fail(err.stack ?? err.message));
