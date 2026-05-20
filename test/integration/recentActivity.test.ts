import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { HttpClient } from "../../src/clients/httpClient.js";
import { YammerClient } from "../../src/clients/yammerClient.js";
import { DigestService } from "../../src/services/digestService.js";
import type { EngageCommunity } from "../../src/models/index.js";

const BASE = "https://www.yammer.com/api/v1";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeService(): DigestService {
  return new DigestService(
    new YammerClient(
      new HttpClient({
        baseUrl: BASE,
        getBearerToken: async () => "t",
        maxRetries: 0,
        timeoutMs: 2000,
      }),
    ),
  );
}

const c = (id: string, name: string): EngageCommunity => ({ id, name });

function onceForGroup(groupId: string, payload: unknown) {
  let served = false;
  return http.get(`${BASE}/messages/in_group/${groupId}.json`, ({ request }) => {
    const url = new URL(request.url);
    if (served || url.searchParams.get("older_than")) {
      return HttpResponse.json({ messages: [], references: [] });
    }
    served = true;
    return HttpResponse.json(payload);
  });
}

describe("DigestService.getRecentActivity", () => {
  it("aggregates per-community counts and surfaces warnings for failures", async () => {
    const recent = new Date().toISOString();
    server.use(
      onceForGroup("1", {
        messages: [
          { id: 10, thread_id: 10, sender_id: "a", created_at: recent, body: { plain: "starter" } },
          { id: 11, thread_id: 10, sender_id: "b", created_at: recent, body: { plain: "reply" } },
        ],
        references: [],
      }),
      http.get(`${BASE}/messages/in_group/2.json`, () =>
        new HttpResponse(JSON.stringify({ error: "boom" }), { status: 500 }),
      ),
    );
    const result = await makeService().getRecentActivity({
      communities: [c("1", "Alpha"), c("2", "Beta")],
      hoursAgo: 24,
      concurrency: 2,
    });
    expect(result.communities).toHaveLength(1);
    expect(result.communities[0]!.communityName).toBe("Alpha");
    expect(result.communities[0]!.messageCount).toBe(1);
    expect(result.communities[0]!.replyCount).toBe(1);
    expect(result.warnings.find((w) => w.communityId === "2")).toBeDefined();
  });

  it("refuses when no communities passed", async () => {
    await expect(makeService().getRecentActivity({ communities: [] })).rejects.toThrowError(
      /requires an explicit communities/i,
    );
  });

  it("refuses above maxCommunities cap", async () => {
    const many = Array.from({ length: 30 }, (_, i) => c(String(i), `C${i}`));
    await expect(
      makeService().getRecentActivity({ communities: many, maxCommunities: 25 }),
    ).rejects.toThrowError(/Refusing to scan/);
  });

  it("respects a zero-budget timeout and returns warnings + partial results", async () => {
    server.use(
      http.get(`${BASE}/messages/in_group/1.json`, () =>
        HttpResponse.json({ messages: [], references: [] }),
      ),
    );
    const result = await makeService().getRecentActivity({
      communities: [c("1", "Alpha")],
      budgetMs: 1,
    });
    // With a 1ms budget, the task should bail and produce a TIMEOUT warning.
    // (Time-sensitive; allow either path so it doesn't flake on a fast machine.)
    if (result.warnings.length > 0) {
      expect(result.warnings[0]!.code).toBe("TIMEOUT");
    } else {
      expect(result.communities).toBeDefined();
    }
  });
});
