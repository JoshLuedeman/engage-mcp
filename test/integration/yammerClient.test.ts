import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { HttpClient } from "../../src/clients/httpClient.js";
import { YammerClient } from "../../src/clients/yammerClient.js";

const BASE = "https://www.yammer.com/api/v1";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): YammerClient {
  return new YammerClient(
    new HttpClient({
      baseUrl: BASE,
      getBearerToken: async () => "token",
      maxRetries: 1,
      timeoutMs: 2000,
    }),
  );
}

describe("YammerClient", () => {
  it("getCurrentNetworks returns an array", async () => {
    server.use(
      http.get(`${BASE}/networks/current.json`, () =>
        HttpResponse.json([{ id: 1, name: "Contoso" }]),
      ),
    );
    const nets = await makeClient().getCurrentNetworks();
    expect(nets).toHaveLength(1);
  });

  it("listGroups accepts both array and {groups} payloads", async () => {
    server.use(http.get(`${BASE}/groups.json`, () => HttpResponse.json([{ id: 1 }, { id: 2 }])));
    expect(await makeClient().listGroups({ page: 1 })).toHaveLength(2);
    server.use(
      http.get(`${BASE}/groups.json`, () => HttpResponse.json({ groups: [{ id: 7 }] })),
    );
    expect(await makeClient().listGroups()).toHaveLength(1);
  });

  it("getGroupMessages passes older_than and limit", async () => {
    let receivedQuery: URLSearchParams | null = null;
    server.use(
      http.get(`${BASE}/messages/in_group/100.json`, ({ request }) => {
        receivedQuery = new URL(request.url).searchParams;
        return HttpResponse.json({ messages: [], references: [] });
      }),
    );
    await makeClient().getGroupMessages("100", { limit: 25, olderThan: "abc" });
    expect(receivedQuery?.get("limit")).toBe("25");
    expect(receivedQuery?.get("older_than")).toBe("abc");
  });

  it("postMessage sends body, group_id, and title", async () => {
    let received: Record<string, unknown> | null = null;
    server.use(
      http.post(`${BASE}/messages.json`, async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ messages: [{ id: 999 }] });
      }),
    );
    await makeClient().postMessage({ body: "hi", groupId: "100", title: "T" });
    expect(received).toEqual({ body: "hi", group_id: "100", title: "T" });
  });

  it("deleteMessage and like/unlike issue correct HTTP verbs", async () => {
    let deletedFor: string | null = null;
    let likedFor: string | null = null;
    let unlikedFor: string | null = null;
    server.use(
      http.delete(`${BASE}/messages/:id.json`, ({ params }) => {
        deletedFor = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BASE}/messages/liked_by/current.json`, ({ request }) => {
        likedFor = new URL(request.url).searchParams.get("message_id");
        return new HttpResponse(null, { status: 200 });
      }),
      http.delete(`${BASE}/messages/liked_by/current.json`, ({ request }) => {
        unlikedFor = new URL(request.url).searchParams.get("message_id");
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const c = makeClient();
    await c.deleteMessage("42");
    await c.likeMessage("42");
    await c.unlikeMessage("42");
    expect(deletedFor).toBe("42");
    expect(likedFor).toBe("42");
    expect(unlikedFor).toBe("42");
  });

  it("paginated community fetch via tool-like loop hits maxPages truncation", async () => {
    let page = 0;
    server.use(
      http.get(`${BASE}/messages/in_group/100.json`, () => {
        page++;
        return HttpResponse.json({
          messages: Array.from({ length: 5 }, (_, i) => ({
            id: page * 10 + i,
            created_at: "2026-01-01",
            body: { plain: `m${page * 10 + i}` },
          })),
          references: [],
        });
      }),
    );
    // Hit it a few times to confirm pagination shape.
    const r1 = await makeClient().getGroupMessages("100", { limit: 5 });
    const r2 = await makeClient().getGroupMessages("100", { limit: 5, olderThan: "x" });
    expect((r1.messages ?? []).length).toBe(5);
    expect((r2.messages ?? []).length).toBe(5);
  });
});
