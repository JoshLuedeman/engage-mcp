/**
 * Append-only JSONL audit log for write operations.
 *
 * Records action metadata only — never raw body content. Each entry
 * contains the payload hash so a write can be cross-referenced
 * against a preview without storing user text on disk.
 *
 * Rotation: when the active log exceeds `maxBytes`, it's renamed to
 * `audit.log.1` (older archives shift up); we keep `keepArchives`
 * total archives, the oldest is unlinked.
 *
 * Errors writing the audit log are logged but never propagated —
 * audit failures must not block a write the user explicitly
 * confirmed.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, sanitizeError } from "../utils/logger.js";

export type AuditStatus = "preview" | "committed" | "failed";

export interface AuditEntry {
  ts: string;
  tool: string;
  accountId: string;
  targetKind: "community" | "thread" | "message" | "user" | "other";
  targetId: string;
  payloadHash: string;
  status: AuditStatus;
  errorCode?: string;
  reason?: string;
  extra?: Record<string, unknown>;
}

export interface AuditLogOptions {
  filePath: string;
  maxBytes?: number;
  keepArchives?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP_ARCHIVES = 3;

export class AuditLog {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly keepArchives: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: AuditLogOptions) {
    this.filePath = opts.filePath;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keepArchives = opts.keepArchives ?? DEFAULT_KEEP_ARCHIVES;
  }

  /**
   * Append an entry. Serialized via a per-instance promise chain so a
   * single process can't interleave partial lines into the file.
   */
  async append(entry: AuditEntry): Promise<void> {
    this.chain = this.chain.then(() => this.appendInternal(entry)).catch((err) => {
      logger.warn({ err: sanitizeError(err) }, "audit log append failed");
    });
    return this.chain;
  }

  private async appendInternal(entry: AuditEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.maybeRotate();
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.filePath, line, { encoding: "utf8" });
  }

  private async maybeRotate(): Promise<void> {
    let size = 0;
    try {
      const stat = await fs.stat(this.filePath);
      size = stat.size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;

    // Shift archives up: keep-1 → drop, then keep-2 → keep-1, …, 1 → 2, current → 1.
    const oldest = `${this.filePath}.${this.keepArchives}`;
    try {
      await fs.unlink(oldest);
    } catch {
      // ignore — may not exist
    }
    for (let i = this.keepArchives - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      try {
        await fs.rename(from, to);
      } catch {
        // ignore — archive may not exist yet
      }
    }
    try {
      await fs.rename(this.filePath, `${this.filePath}.1`);
    } catch (err) {
      logger.warn({ err: sanitizeError(err) }, "audit log rotation failed");
    }
  }
}
