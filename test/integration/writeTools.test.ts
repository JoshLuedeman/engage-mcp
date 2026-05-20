import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
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
import { buildWriteTools } from "../../src/tools/writeTools.js";

const BASE = "https://www.yammer.com/api/v1";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface FakeAuth {
  getCurrentAccountId: () => Promise<string>;
}

function buildRegistry(opts?: { account?: string }): {
  registry: ToolRegistry;
  audit: AuditLog;
  dir: string;
} {
  // Cannot use top-level await in test setup synchronously; use sync mkdtempSync via os.tmpdir
  const dir = path.join(os.tmpdir(), `wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  void fs.mkdir(dir, { recursive: true });
  const yc = new YammerClient(
    new HttpClient({
      baseUrl: BASE,
      getBearerToken: async () => "t",
      maxRetries: 0,
      timeoutMs: 2000,
    }),
  );
  const fakeAuth: FakeAuth = {
    getCurrentAccountId: async () => opts?.account ?? "user-1",
  };
  const audit = new AuditLog({ filePath: path.join(dir, "audit.log") });
  const confirmation = new ConfirmationManager({ hmacKey: Buffer.alloc(32, 0x11) });
  const registry = new ToolRegistry();
  for (const t of buildWriteTools({
    client: yc,
    auth: fakeAuth as unknown as Parameters<typeof buildWriteTools>[0]["auth"],
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

describe("engage_post_message — preview/commit", () => {
  it("preview does not POST and returns a confirmationToken", async () => {
    let postCalls = 0;
    server.use(
      http.get(`${BASE}/groups/100.json`, () =>
        HttpResponse.json({ id: 100, full_name: "Test Community" }),
      ),
      http.post(`${BASE}/messages.json`, () => {
        postCalls++;
        return HttpResponse.json({ messages: [{ id: 999 }] });
      }),
    );
    const { registry } = buildRegistry();
    const res = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "hello world",
    });
    const out = parseResult(res) as Record<string, unknown>;
    expect(out["requiresConfirmation"]).toBe(true);
    expect(out["confirmationToken"]).toBeTypeOf("string");
    expect(postCalls).toBe(0);
  });

  it("commit with matching token POSTs exactly once", async () => {
    let postBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${BASE}/groups/100.json`, () =>
        HttpResponse.json({ id: 100, full_name: "Test Community" }),
      ),
      http.post(`${BASE}/messages.json`, async ({ request }) => {
        postBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ messages: [{ id: 999, body: { plain: "hello world" } }] });
      }),
    );
    const { registry } = buildRegistry();
    const previewRes = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "hello world",
    });
    const preview = parseResult(previewRes) as Record<string, unknown>;
    const commitRes = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "hello world",
      confirmationToken: preview["confirmationToken"],
    });
    const commit = parseResult(commitRes) as Record<string, unknown>;
    expect(commit["committed"]).toBe(true);
    expect(postBody).toMatchObject({ body: "hello world", group_id: "100" });
  });

  it("rejects when payload is tampered between preview and commit", async () => {
    server.use(
      http.get(`${BASE}/groups/100.json`, () =>
        HttpResponse.json({ id: 100, full_name: "Test Community" }),
      ),
      http.post(`${BASE}/messages.json`, () => {
        throw new Error("must not POST");
      }),
    );
    const { registry } = buildRegistry();
    const previewRes = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "hello",
    });
    const preview = parseResult(previewRes) as Record<string, unknown>;
    const tamperedRes = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "evil edit",
      confirmationToken: preview["confirmationToken"],
    });
    expect(tamperedRes.isError).toBe(true);
    const err = parseResult(tamperedRes) as Record<string, Record<string, unknown>>;
    expect(err.error["code"]).toBe("CONFIRMATION_MISMATCH");
  });

  it("token is single-use", async () => {
    server.use(
      http.get(`${BASE}/groups/100.json`, () =>
        HttpResponse.json({ id: 100, full_name: "Test Community" }),
      ),
      http.post(`${BASE}/messages.json`, () =>
        HttpResponse.json({ messages: [{ id: 999 }] }),
      ),
    );
    const { registry } = buildRegistry();
    const previewRes = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "hi",
    });
    const preview = parseResult(previewRes) as Record<string, unknown>;
    const first = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "hi",
      confirmationToken: preview["confirmationToken"],
    });
    expect(first.isError).toBeUndefined();
    const second = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "hi",
      confirmationToken: preview["confirmationToken"],
    });
    expect(second.isError).toBe(true);
    const err = parseResult(second) as Record<string, Record<string, unknown>>;
    expect(err.error["code"]).toBe("CONFIRMATION_MISMATCH");
  });

  it("ambiguous community in preview is a hard error before token is issued", async () => {
    server.use(
      http.get(`${BASE}/groups.json`, () =>
        HttpResponse.json([
          { id: 1, full_name: "Engineering" },
          { id: 2, full_name: "Engineering" },
        ]),
      ),
    );
    const { registry } = buildRegistry();
    const res = await registry.call("engage_post_message", {
      communityIdOrName: "Engineering",
      body: "hello",
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res) as Record<string, Record<string, unknown>>;
    expect(err.error["code"]).toBe("AMBIGUOUS_COMMUNITY");
  });

  it("validation rejects empty body before resolving community", async () => {
    const grpHandler = vi.fn(() =>
      HttpResponse.json({ id: 100, full_name: "T" }),
    );
    server.use(http.get(`${BASE}/groups/100.json`, grpHandler));
    const { registry } = buildRegistry();
    const res = await registry.call("engage_post_message", {
      communityIdOrName: "100",
      body: "   ",
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res) as Record<string, Record<string, unknown>>;
    expect(err.error["code"]).toBe("VALIDATION_ERROR");
  });
});

describe("engage_reply_to_thread", () => {
  it("commit posts with replied_to_id", async () => {
    let postBody: Record<string, unknown> | null = null;
    server.use(
      http.post(`${BASE}/messages.json`, async ({ request }) => {
        postBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ messages: [{ id: 42 }] });
      }),
    );
    const { registry } = buildRegistry();
    const previewRes = await registry.call("engage_reply_to_thread", {
      threadId: "abc",
      body: "reply text",
    });
    const preview = parseResult(previewRes) as Record<string, unknown>;
    const commitRes = await registry.call("engage_reply_to_thread", {
      threadId: "abc",
      body: "reply text",
      confirmationToken: preview["confirmationToken"],
    });
    expect((parseResult(commitRes) as Record<string, unknown>)["committed"]).toBe(true);
    expect(postBody).toMatchObject({ body: "reply text", replied_to_id: "abc" });
  });
});
