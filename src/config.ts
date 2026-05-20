import { z } from "zod";
import * as dotenv from "dotenv";
import * as os from "node:os";
import * as path from "node:path";

dotenv.config();

const AuthMode = z.enum(["device_code", "interactive"]);

const ConfigSchema = z.object({
  azureClientId: z.string().min(1, "AZURE_CLIENT_ID is required"),
  azureTenantId: z.string().min(1, "AZURE_TENANT_ID is required"),
  yammerScopes: z.array(z.string().min(1)).min(1),
  authMode: AuthMode,
  maxConcurrentRequests: z.number().int().positive().max(16),
  requestTimeoutMs: z.number().int().positive().max(300_000),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  tokenCacheDir: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type { AuthMode };

function defaultCacheDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "mcp-yammer-engage");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "mcp-yammer-engage");
  }
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(xdg, "mcp-yammer-engage");
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return ["https://api.yammer.com/user_impersonation"];
  }
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return n;
}

/**
 * Loads, validates, and freezes configuration from environment variables.
 * Throws an `Error` with a human-readable message if validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    azureClientId: env.AZURE_CLIENT_ID ?? "",
    azureTenantId: env.AZURE_TENANT_ID ?? "",
    yammerScopes: parseScopes(env.YAMMER_SCOPES),
    authMode: (env.AUTH_MODE ?? "device_code") as "device_code" | "interactive",
    maxConcurrentRequests: parseInt("MAX_CONCURRENT_REQUESTS", env.MAX_CONCURRENT_REQUESTS, 2),
    requestTimeoutMs: parseInt("REQUEST_TIMEOUT_MS", env.REQUEST_TIMEOUT_MS, 30_000),
    logLevel: (env.LOG_LEVEL ?? "info") as Config["logLevel"],
    tokenCacheDir:
      env.TOKEN_CACHE_DIR && env.TOKEN_CACHE_DIR.trim().length > 0
        ? env.TOKEN_CACHE_DIR
        : defaultCacheDir(),
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration:\n${issues}\n\nSee .env.example for required variables.`,
    );
  }
  return Object.freeze(parsed.data);
}
