/**
 * Token-cache file persistence with AES-256-GCM encryption.
 *
 * Threat model (see plan.md §4.1 — be honest about what this does and
 * does not protect against):
 *  - Protects against casual file inspection or a copied cache without
 *    the sibling `cache.key`.
 *  - Does NOT protect against a local-user attacker or a malicious
 *    process running as the same user. That's out of scope and
 *    documented in README.
 *
 * Files (within `cacheDir`):
 *   token-cache.bin   ciphertext (IV || authTag || ciphertext)
 *   cache.key         32 raw bytes of key material (mode 0600 where supported)
 *
 * Writes are atomic (write to *.tmp + rename) and protected by an
 * exclusive file lock via proper-lockfile.
 *
 * If decryption fails (corrupt cache or rotated key), the corrupt
 * cache file is renamed to `token-cache.corrupt-<ts>.bin` and a
 * fresh empty state is returned, with an EngageCacheError surfaced
 * for the caller to log/inform the user.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import lockfile from "proper-lockfile";
import { EngageCacheError } from "../utils/errors.js";

const KEY_FILE = "cache.key";
const CACHE_FILE = "token-cache.bin";
const LOCK_FILE = "cache.lock";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;
const LOCK_OPTS = {
  retries: { retries: 30, minTimeout: 25, maxTimeout: 250, factor: 1.5 },
  stale: 10_000,
} as const;

export interface TokenStoreOptions {
  cacheDir: string;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(target: string, data: Buffer, mode?: number): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  if (mode !== undefined) {
    await fs.writeFile(tmp, data, { mode });
  } else {
    await fs.writeFile(tmp, data);
  }
  await fs.rename(tmp, target);
  if (mode !== undefined && process.platform !== "win32") {
    try {
      await fs.chmod(target, mode);
    } catch {
      // best effort
    }
  }
}

async function loadOrCreateKey(cacheDir: string): Promise<Buffer> {
  const keyPath = path.join(cacheDir, KEY_FILE);
  if (await fileExists(keyPath)) {
    const buf = await fs.readFile(keyPath);
    if (buf.length !== KEY_BYTES) {
      throw new EngageCacheError(
        `Cache key at ${keyPath} has unexpected length ${buf.length} (expected ${KEY_BYTES}).`,
      );
    }
    return buf;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  await ensureDir(cacheDir);
  await atomicWrite(keyPath, key, 0o600);
  return key;
}

function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("ciphertext too short");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export class TokenStore {
  private readonly cacheDir: string;
  private readonly cachePath: string;
  private readonly lockPath: string;

  constructor(opts: TokenStoreOptions) {
    this.cacheDir = opts.cacheDir;
    this.cachePath = path.join(opts.cacheDir, CACHE_FILE);
    this.lockPath = path.join(opts.cacheDir, LOCK_FILE);
  }

  /**
   * Returns plaintext token-cache contents (whatever opaque blob MSAL
   * gave us last time), or `null` if nothing has been stored yet.
   *
   * Throws `EngageCacheError` if the cache exists but cannot be
   * decrypted. The corrupt file is moved aside so subsequent reads
   * return null and a fresh cache can be written.
   */
  async load(): Promise<string | null> {
    await ensureDir(this.cacheDir);
    await this.ensureLockTarget();
    const release = await lockfile.lock(this.lockPath, LOCK_OPTS);
    try {
      if (!(await fileExists(this.cachePath))) return null;
      const key = await loadOrCreateKey(this.cacheDir);
      const blob = await fs.readFile(this.cachePath);
      try {
        return decrypt(blob, key);
      } catch (err) {
        const archive = path.join(
          this.cacheDir,
          `token-cache.corrupt-${Date.now()}.bin`,
        );
        try {
          await fs.rename(this.cachePath, archive);
        } catch {
          // ignore
        }
        throw new EngageCacheError(
          `Token cache could not be decrypted (moved to ${archive}). Re-authentication required.`,
          { cause: err },
        );
      }
    } finally {
      await release();
    }
  }

  /**
   * Persist an opaque token-cache blob, encrypted.
   */
  async save(contents: string): Promise<void> {
    await ensureDir(this.cacheDir);
    await this.ensureLockTarget();
    const release = await lockfile.lock(this.lockPath, LOCK_OPTS);
    try {
      const key = await loadOrCreateKey(this.cacheDir);
      const blob = encrypt(contents, key);
      await atomicWrite(this.cachePath, blob, 0o600);
    } finally {
      await release();
    }
  }

  /**
   * Wipe cached tokens and key. Used by the `auth_clear_tokens` tool.
   */
  async clear(): Promise<void> {
    await ensureDir(this.cacheDir);
    await this.ensureLockTarget();
    const release = await lockfile.lock(this.lockPath, LOCK_OPTS);
    try {
      for (const name of [CACHE_FILE, KEY_FILE]) {
        const p = path.join(this.cacheDir, name);
        try {
          await fs.unlink(p);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    } finally {
      await release();
    }
  }

  /**
   * proper-lockfile requires the lock target file to exist. Create an
   * empty sentinel if missing.
   */
  private async ensureLockTarget(): Promise<void> {
    if (!(await fileExists(this.lockPath))) {
      try {
        await fs.writeFile(this.lockPath, "");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
}
