import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AuditLog } from "../../src/safety/auditLog.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "audit-log-"));
}

async function readLines(p: string): Promise<string[]> {
  const text = await fs.readFile(p, "utf8");
  return text.split("\n").filter((s) => s.length > 0);
}

describe("AuditLog", () => {
  it("appends one JSONL line per entry", async () => {
    const dir = await tempDir();
    const log = new AuditLog({ filePath: path.join(dir, "audit.log") });
    await log.append({
      ts: "2026-01-01T00:00:00.000Z",
      tool: "engage_post_message",
      accountId: "u1",
      targetKind: "community",
      targetId: "100",
      payloadHash: "h",
      status: "preview",
    });
    await log.append({
      ts: "2026-01-01T00:00:01.000Z",
      tool: "engage_post_message",
      accountId: "u1",
      targetKind: "community",
      targetId: "100",
      payloadHash: "h",
      status: "committed",
    });
    const lines = await readLines(path.join(dir, "audit.log"));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).status).toBe("preview");
    expect(JSON.parse(lines[1]!).status).toBe("committed");
  });

  it("rotates when size exceeds maxBytes", async () => {
    const dir = await tempDir();
    const log = new AuditLog({
      filePath: path.join(dir, "audit.log"),
      maxBytes: 200,
      keepArchives: 2,
    });
    for (let i = 0; i < 10; i++) {
      await log.append({
        ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        tool: "engage_post_message",
        accountId: "u1",
        targetKind: "community",
        targetId: "100",
        payloadHash: "x".repeat(64),
        status: "committed",
      });
    }
    const files = await fs.readdir(dir);
    expect(files.some((f) => f === "audit.log")).toBe(true);
    expect(files.some((f) => f === "audit.log.1")).toBe(true);
  });

  it("serializes concurrent appends without interleaving", async () => {
    const dir = await tempDir();
    const log = new AuditLog({ filePath: path.join(dir, "audit.log") });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.append({
          ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          tool: "engage_post_message",
          accountId: "u1",
          targetKind: "community",
          targetId: "100",
          payloadHash: String(i).padStart(64, "0"),
          status: "preview",
        }),
      ),
    );
    const lines = await readLines(path.join(dir, "audit.log"));
    expect(lines).toHaveLength(20);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
