import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse, delay } from "msw";
import { HttpClient } from "../../src/clients/httpClient.js";
import {
  EngageAuthError,
  EngageNotFoundError,
  EngagePermissionError,
  EngageRateLimitError,
  EngageTimeoutError,
} from "../../src/utils/errors.js";

const BASE = "https://example.test/api";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({
    baseUrl: BASE,
    getBearerToken: async () => "test-token",
    maxRetries: 2,
    timeoutMs: 500,
    ...overrides,
  });
}

describe("HttpClient", () => {
  it("returns parsed JSON for 2xx responses", async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.json({ ok: true })));
    const c = makeClient();
    const body = await c.request<{ ok: boolean }>("x");
    expect(body).toEqual({ ok: true });
  });

  it("attaches the bearer token", async () => {
    let seen: string | null = null;
    server.use(
      http.get(`${BASE}/x`, ({ request }) => {
        seen = request.headers.get("authorization");
        return HttpResponse.json({});
      }),
    );
    const c = makeClient();
    await c.request("x");
    expect(seen).toBe("Bearer test-token");
  });

  it("maps 401 to EngageAuthError", async () => {
    server.use(http.get(`${BASE}/x`, () => new HttpResponse("nope", { status: 401 })));
    await expect(makeClient().request("x")).rejects.toBeInstanceOf(EngageAuthError);
  });

  it("maps 403 to EngagePermissionError", async () => {
    server.use(http.get(`${BASE}/x`, () => new HttpResponse("nope", { status: 403 })));
    await expect(makeClient().request("x")).rejects.toBeInstanceOf(EngagePermissionError);
  });

  it("maps 404 to EngageNotFoundError", async () => {
    server.use(http.get(`${BASE}/x`, () => new HttpResponse("nope", { status: 404 })));
    await expect(makeClient().request("x")).rejects.toBeInstanceOf(EngageNotFoundError);
  });

  it("retries 429 and honors Retry-After (seconds)", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/x`, () => {
        calls++;
        if (calls === 1) {
          return new HttpResponse("rate", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return HttpResponse.json({ ok: true });
      }),
    );
    const c = makeClient();
    const body = await c.request<{ ok: boolean }>("x");
    expect(body).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("eventually throws EngageRateLimitError when retries exhausted", async () => {
    server.use(
      http.get(`${BASE}/x`, () =>
        new HttpResponse("rate", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      ),
    );
    await expect(makeClient({ maxRetries: 1 }).request("x")).rejects.toBeInstanceOf(
      EngageRateLimitError,
    );
  });

  it("retries on 5xx", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/x`, () => {
        calls++;
        if (calls < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json({ ok: true });
      }),
    );
    const c = makeClient();
    const body = await c.request<{ ok: boolean }>("x");
    expect(body).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("times out and surfaces EngageTimeoutError", async () => {
    server.use(
      http.get(`${BASE}/x`, async () => {
        await delay(2000);
        return HttpResponse.json({ ok: true });
      }),
    );
    await expect(
      makeClient({ timeoutMs: 50, maxRetries: 0 }).request("x"),
    ).rejects.toBeInstanceOf(EngageTimeoutError);
  });

  it("respects maxConcurrent (limits to N inflight)", async () => {
    let inflight = 0;
    let peak = 0;
    server.use(
      http.get(`${BASE}/x`, async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await delay(30);
        inflight--;
        return HttpResponse.json({});
      }),
    );
    const c = makeClient({ maxConcurrent: 2, maxRetries: 0 });
    await Promise.all(Array.from({ length: 5 }, () => c.request("x")));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

vi.setConfig({ testTimeout: 10_000 });
