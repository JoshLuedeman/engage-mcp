import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TokenStore } from "../../src/auth/tokenStore.js";
import { EngageCacheError } from "../../src/utils/errors.js";

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tokenstore-test-"));
}

describe("TokenStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTmpDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when no cache has been saved", async () => {
    const store = new TokenStore({ cacheDir: dir });
    expect(await store.load()).toBeNull();
  });

  it("round-trips an opaque blob", async () => {
    const store = new TokenStore({ cacheDir: dir });
    const payload = JSON.stringify({ msal: "opaque", n: 123 });
    await store.save(payload);
    expect(await store.load()).toBe(payload);
  });

  it("writes both token-cache.bin and cache.key", async () => {
    const store = new TokenStore({ cacheDir: dir });
    await store.save("hello");
    const files = await fs.readdir(dir);
    expect(files).toContain("token-cache.bin");
    expect(files).toContain("cache.key");
  });

  it("survives multiple sequential saves with different sizes", async () => {
    const store = new TokenStore({ cacheDir: dir });
    await store.save("a");
    await store.save("a".repeat(10_000));
    await store.save("final");
    expect(await store.load()).toBe("final");
  });

  it("rejects a tampered ciphertext and moves it aside", async () => {
    const store = new TokenStore({ cacheDir: dir });
    await store.save("good");
    // Corrupt the ciphertext.
    const cachePath = path.join(dir, "token-cache.bin");
    const buf = await fs.readFile(cachePath);
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    await fs.writeFile(cachePath, buf);

    await expect(store.load()).rejects.toBeInstanceOf(EngageCacheError);
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith("token-cache.corrupt-"))).toBe(true);
    // After the corrupt one is moved, next load is null.
    expect(await store.load()).toBeNull();
  });

  it("clear() removes cache and key", async () => {
    const store = new TokenStore({ cacheDir: dir });
    await store.save("x");
    await store.clear();
    const files = await fs.readdir(dir);
    expect(files).not.toContain("token-cache.bin");
    expect(files).not.toContain("cache.key");
  });

  it("rejects load when key is rotated under the cache", async () => {
    const store = new TokenStore({ cacheDir: dir });
    await store.save("original");
    // Replace the key with fresh random bytes.
    await fs.writeFile(path.join(dir, "cache.key"), Buffer.alloc(32, 0xab));
    await expect(store.load()).rejects.toBeInstanceOf(EngageCacheError);
  });

  it("concurrent saves are serialized (no corruption)", async () => {
    const store = new TokenStore({ cacheDir: dir });
    const writers = Array.from({ length: 5 }, (_, i) => store.save(`payload-${i}`));
    await Promise.all(writers);
    const loaded = await store.load();
    expect(loaded).toMatch(/^payload-[0-4]$/);
  });
});
