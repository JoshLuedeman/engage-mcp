import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { HttpClient } from "../../src/clients/httpClient.js";
import { YammerClient } from "../../src/clients/yammerClient.js";
import { ConfirmationManager } from "../../src/safety/confirmation.js";
import { AuditLog } from "../../src/safety/auditLog.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { buildModerationTools } from "../../src/tools/moderationTools.js";

const BASE = "https://www.yammer.com/api/v1";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface FakeAuth {
  getCurrentAccountId: () => Promise<string>;
}

function buildRegistry(): {
  registry: ToolRegistry;
  audit: AuditLog;
  dir: string;
} {
  const dir = path.join(os.tmpdir(), `mod-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  void fs.mkdir(dir, { recursive: true });
  const yc = new YammerClient(
    new HttpClient({
      baseUrl: BASE,
      getBearerToken: async () => "t",
      maxRetries: 0,
      timeoutMs: 2000,
    }),
  );
  const fakeAuth: FakeAuth = { getCurrentAccountId: async () => "user-1" };
  const audit = new AuditLog({ filePath: path.join(dir, "audit.log") });
  const confirmation = new ConfirmationManager({ hmacKey: Buffer.alloc(32, 0x33) });
  const registry = new ToolRegistry();
  for (const t of buildModerationTools({
    client: yc,
    auth: fakeAuth as unknown as Parameters<typeof buildModerationTools>[0]["auth"],
    confirmation,
    audit,
  })) {
    registry.register(t);
  }
  return { registry, audit, dir };
}

function parseResult(res: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(res.content[0]!.text);
}

const sampleThreadResponse = {
  messages: [
    {
      id: 42,
      thread_id: 42,
      sender_id: "u1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      body: { plain: "hello world" },
      web_url: "https://www.yammer.com/network/threads/42",
    },
  ],
  references: [],
};

describe("engage_like_message / engage_unlike_message", () => {
  it("preview does not call POST and returns a confirmationToken", async () => {
    let called = false;
    server.use(
      http.post(`${BASE}/messages/liked_by/current.json`, () => {
        called = true;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const { registry } = buildRegistry();
    const res = await registry.call("engage_like_message", { messageId: "42" });
    const out = parseResult(res) as Record<string, unknown>;
    expect(out["requiresConfirmation"]).toBe(true);
    expect(out["confirmationToken"]).toBeTypeOf("string");
    expect(called).toBe(false);
  });

  it("commit with matching token calls the like endpoint", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/messages/liked_by/current.json`, () => {
        calls++;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const { registry } = buildRegistry();
    const preview = parseResult(
      await registry.call("engage_like_message", { messageId: "42" }),
    ) as Record<string, unknown>;
    const commit = parseResult(
      await registry.call("engage_like_message", {
        messageId: "42",
        confirmationToken: preview["confirmationToken"],
      }),
    ) as Record<string, unknown>;
    expect(commit["committed"]).toBe(true);
    expect(calls).toBe(1);
  });

  it("maps 403 from like endpoint to UNSUPPORTED_CAPABILITY", async () => {
    server.use(
      http.post(`${BASE}/messages/liked_by/current.json`, () =>
        new HttpResponse(JSON.stringify({ error: "denied" }), { status: 403 }),
      ),
    );
    const { registry } = buildRegistry();
    const preview = parseResult(
      await registry.call("engage_like_message", { messageId: "42" }),
    ) as Record<string, unknown>;
    const res = await registry.call("engage_like_message", {
      messageId: "42",
      confirmationToken: preview["confirmationToken"],
    });
    expect(res.isError).toBe(true);
    const env = parseResult(res) as { error: { code: string } };
    expect(env.error.code).toBe("UNSUPPORTED_CAPABILITY");
  });
});

describe("engage_delete_message", () => {
  it("requires a reason (≥8 chars) before any API call", async () => {
    const { registry } = buildRegistry();
    const res = await registry.call("engage_delete_message", {
      messageId: "42",
      reason: "short",
    });
    expect(res.isError).toBe(true);
    const env = parseResult(res) as { error: { code: string } };
    expect(env.error.code).toBe("VALIDATION_ERROR");
  });

  it("preview fetches the message, embeds it, issues a token, does NOT delete", async () => {
    let deleted = false;
    server.use(
      http.get(`${BASE}/messages/in_thread/42.json`, () => HttpResponse.json(sampleThreadResponse)),
      http.delete(`${BASE}/messages/42.json`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { registry } = buildRegistry();
    const preview = parseResult(
      await registry.call("engage_delete_message", {
        messageId: "42",
        reason: "spam from automated account",
      }),
    ) as Record<string, unknown>;
    expect(preview["requiresConfirmation"]).toBe(true);
    expect(preview["message"]).toBeDefined();
    expect(preview["confirmationToken"]).toBeTypeOf("string");
    expect(deleted).toBe(false);
  });

  it("commit with matching token deletes and audits the snapshot", async () => {
    let deleted = false;
    server.use(
      http.get(`${BASE}/messages/in_thread/42.json`, () => HttpResponse.json(sampleThreadResponse)),
      http.delete(`${BASE}/messages/42.json`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { registry, dir } = buildRegistry();
    const preview = parseResult(
      await registry.call("engage_delete_message", {
        messageId: "42",
        reason: "spam from automated account",
      }),
    ) as Record<string, unknown>;
    const commit = parseResult(
      await registry.call("engage_delete_message", {
        messageId: "42",
        reason: "spam from automated account",
        confirmationToken: preview["confirmationToken"],
      }),
    ) as Record<string, unknown>;
    expect(deleted).toBe(true);
    expect(commit["committed"]).toBe(true);
    const snap = commit["snapshot"] as Record<string, unknown>;
    expect(snap["messageId"]).toBe("42");
    expect(typeof snap["bodyHash"]).toBe("string");
    expect(snap["bodyHash"]).not.toBe("hello world");

    // Audit log content check (without the body).
    await new Promise((r) => setTimeout(r, 50));
    const log = await fs.readFile(path.join(dir, "audit.log"), "utf8");
    expect(log).toContain('"status":"committed"');
    expect(log).not.toContain("hello world");
  });

  it("invalidates token if message was edited (updatedAt changed) between preview and commit", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/messages/in_thread/42.json`, () => {
        calls++;
        const payload = JSON.parse(JSON.stringify(sampleThreadResponse));
        if (calls > 1) {
          payload.messages[0].updated_at = "2026-02-02T00:00:00Z";
        }
        return HttpResponse.json(payload);
      }),
      http.delete(`${BASE}/messages/42.json`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );
    const { registry } = buildRegistry();
    const preview = parseResult(
      await registry.call("engage_delete_message", {
        messageId: "42",
        reason: "spam from automated account",
      }),
    ) as Record<string, unknown>;
    const res = await registry.call("engage_delete_message", {
      messageId: "42",
      reason: "spam from automated account",
      confirmationToken: preview["confirmationToken"],
    });
    expect(res.isError).toBe(true);
    const env = parseResult(res) as { error: { code: string } };
    expect(env.error.code).toBe("CONFIRMATION_MISMATCH");
  });

  it("maps 403 from delete endpoint to UNSUPPORTED_CAPABILITY", async () => {
    server.use(
      http.get(`${BASE}/messages/in_thread/42.json`, () => HttpResponse.json(sampleThreadResponse)),
      http.delete(`${BASE}/messages/42.json`, () =>
        new HttpResponse(JSON.stringify({ error: "denied" }), { status: 403 }),
      ),
    );
    const { registry } = buildRegistry();
    const preview = parseResult(
      await registry.call("engage_delete_message", {
        messageId: "42",
        reason: "spam from automated account",
      }),
    ) as Record<string, unknown>;
    const res = await registry.call("engage_delete_message", {
      messageId: "42",
      reason: "spam from automated account",
      confirmationToken: preview["confirmationToken"],
    });
    expect(res.isError).toBe(true);
    const env = parseResult(res) as { error: { code: string } };
    expect(env.error.code).toBe("UNSUPPORTED_CAPABILITY");
  });
});
