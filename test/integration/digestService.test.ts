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

const community: EngageCommunity = {
  id: "100",
  name: "Test Community",
};

function msg(
  id: number,
  body: string,
  opts: { replyCount?: number; createdAt?: string; threadId?: number; likedByCount?: number; senderId?: string } = {},
): Record<string, unknown> {
  return {
    id,
    thread_id: opts.threadId ?? id,
    sender_id: opts.senderId ?? "u1",
    created_at: opts.createdAt ?? "2026-01-01T00:00:00Z",
    body: { plain: body },
    replied_to_id: opts.threadId && opts.threadId !== id ? opts.threadId : null,
    web_url: `https://www.yammer.com/network/threads/${id}`,
    ...(opts.replyCount !== undefined ? { replied_to_count: opts.replyCount } : {}),
    ...(opts.likedByCount !== undefined ? { liked_by: { count: opts.likedByCount } } : {}),
  };
}

function once(messages: Array<Record<string, unknown>>) {
  let served = false;
  return ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    if (served || url.searchParams.get("older_than")) {
      return HttpResponse.json({ messages: [], references: [] });
    }
    served = true;
    return HttpResponse.json({ messages, references: [] });
  };
}

describe("DigestService.findUnansweredQuestions", () => {
  it("flags messages with a question mark and zero replies", async () => {
    server.use(
      http.get(
        `${BASE}/messages/in_group/100.json`,
        once([
          msg(1, "How do I set up SSO?"),
          msg(2, "Just a status update.", { replyCount: 2 }),
          msg(3, "Anyone seen this error?", { replyCount: 0 }),
        ]),
      ),
    );
    const result = await makeService().findUnansweredQuestions(community);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.message.id).toBe("1");
    expect(result.candidates[0]!.reasons).toContain("contains_question_mark");
  });

  it("respects since filter", async () => {
    server.use(
      http.get(
        `${BASE}/messages/in_group/100.json`,
        once([
          msg(1, "Old question?", { createdAt: "2025-01-01T00:00:00Z" }),
          msg(2, "Recent question?", { createdAt: "2026-06-01T00:00:00Z" }),
        ]),
      ),
    );
    const result = await makeService().findUnansweredQuestions(community, {
      since: "2026-01-01T00:00:00Z",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.message.id).toBe("2");
  });

  it("respects custom limit", async () => {
    server.use(
      http.get(
        `${BASE}/messages/in_group/100.json`,
        once(Array.from({ length: 10 }, (_, i) => msg(i + 1, `Q${i + 1}?`))),
      ),
    );
    const result = await makeService().findUnansweredQuestions(community, { limit: 3 });
    expect(result.candidates).toHaveLength(3);
  });

  it("returns empty when no questions match heuristics", async () => {
    server.use(
      http.get(
        `${BASE}/messages/in_group/100.json`,
        once([msg(1, "Hello world.", { replyCount: 5 })]),
      ),
    );
    const result = await makeService().findUnansweredQuestions(community);
    expect(result.candidates).toHaveLength(0);
  });

  it("flags messages matching configured keywords even without ?", async () => {
    server.use(
      http.get(
        `${BASE}/messages/in_group/100.json`,
        once([msg(1, "I need help with this", { replyCount: 5 })]),
      ),
    );
    const result = await makeService().findUnansweredQuestions(community);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.reasons.some((r) => r.startsWith("keyword:"))).toBe(true);
  });
});

describe("DigestService.computeCommunityHealth", () => {
  it("counts posts, replies, and active authors", async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    server.use(
      http.get(
        `${BASE}/messages/in_group/100.json`,
        once([
          msg(10, "Starter A?", { createdAt: recent, senderId: "a", replyCount: 0 }),
          msg(11, "Reply 1", { createdAt: recent, senderId: "b", threadId: 10 }),
          msg(20, "Starter B", { createdAt: recent, senderId: "a", replyCount: 1, likedByCount: 3 }),
          msg(21, "Reply 2", { createdAt: recent, senderId: "c", threadId: 20 }),
        ]),
      ),
    );
    const h = await makeService().computeCommunityHealth(community, { days: 7 });
    expect(h.postCount).toBe(2);
    expect(h.replyCount).toBe(2);
    expect(h.activeAuthors).toBe(3);
    expect(h.unansweredCount).toBe(1);
    expect(h.topThreads.length).toBeGreaterThan(0);
  });

  it("excludes messages outside the window", async () => {
    const old = "2024-01-01T00:00:00Z";
    server.use(
      http.get(
        `${BASE}/messages/in_group/100.json`,
        once([msg(1, "ancient", { createdAt: old })]),
      ),
    );
    const h = await makeService().computeCommunityHealth(community, { days: 7 });
    expect(h.postCount).toBe(0);
    expect(h.replyCount).toBe(0);
  });
});
