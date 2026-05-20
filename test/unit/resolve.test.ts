import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { resolveCommunity } from "../../src/utils/resolve.js";
import { HttpClient } from "../../src/clients/httpClient.js";
import { YammerClient } from "../../src/clients/yammerClient.js";
import {
  EngageAmbiguousCommunityError,
  EngageNotFoundError,
} from "../../src/utils/errors.js";

const BASE = "https://www.yammer.com/api/v1";

const handlers = [
  http.get(`${BASE}/groups/42.json`, () =>
    HttpResponse.json({ id: 42, name: "Direct By Id", full_name: "Direct By Id" }),
  ),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): YammerClient {
  const http = new HttpClient({
    baseUrl: BASE,
    getBearerToken: async () => "test-token",
    maxRetries: 0,
  });
  return new YammerClient(http);
}

describe("resolveCommunity", () => {
  it("resolves numeric id directly without listing", async () => {
    const c = await resolveCommunity(makeClient(), "42");
    expect(c.id).toBe("42");
    expect(c.name).toBe("Direct By Id");
  });

  it("finds exact case-insensitive name match", async () => {
    server.use(
      http.get(`${BASE}/groups.json`, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("page") === "1") {
          return HttpResponse.json([
            { id: 1, name: "Alpha" },
            { id: 2, name: "Beta" },
          ]);
        }
        return HttpResponse.json([]);
      }),
    );
    const c = await resolveCommunity(makeClient(), "alpha");
    expect(c.id).toBe("1");
  });

  it("matches against fullName as well as name", async () => {
    server.use(
      http.get(`${BASE}/groups.json`, () =>
        HttpResponse.json([{ id: 9, name: "x", full_name: "Exact Match" }]),
      ),
    );
    const c = await resolveCommunity(makeClient(), "Exact Match");
    expect(c.id).toBe("9");
  });

  it("throws EngageAmbiguousCommunityError on multiple matches with candidates", async () => {
    server.use(
      http.get(`${BASE}/groups.json`, () =>
        HttpResponse.json([
          { id: 1, name: "Foo" },
          { id: 2, name: "Foo", full_name: "Foo Team" },
        ]),
      ),
    );
    await expect(resolveCommunity(makeClient(), "Foo")).rejects.toMatchObject({
      code: "AMBIGUOUS_COMMUNITY",
    });
    try {
      await resolveCommunity(makeClient(), "Foo");
    } catch (err) {
      expect(err).toBeInstanceOf(EngageAmbiguousCommunityError);
      expect((err as EngageAmbiguousCommunityError).candidates).toHaveLength(2);
    }
  });

  it("throws EngageNotFoundError when no match found", async () => {
    server.use(http.get(`${BASE}/groups.json`, () => HttpResponse.json([])));
    await expect(resolveCommunity(makeClient(), "nope")).rejects.toBeInstanceOf(
      EngageNotFoundError,
    );
  });

  it("rejects empty input", async () => {
    await expect(resolveCommunity(makeClient(), "   ")).rejects.toBeInstanceOf(
      EngageNotFoundError,
    );
  });
});
