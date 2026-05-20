#!/usr/bin/env node
/**
 * MCP server entry point.
 *
 * Wires:
 *   config → MsalAuth → HttpClient → YammerClient → ToolRegistry
 *
 * Communicates with the MCP client over stdio. CRITICAL: nothing must
 * write to stdout other than the MCP framing — all diagnostic logging
 * goes through `logger` (stderr).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { logger, sanitizeError } from "./utils/logger.js";
import { MsalAuth } from "./auth/msalAuth.js";
import { HttpClient } from "./clients/httpClient.js";
import { YammerClient } from "./clients/yammerClient.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildAuthTools } from "./tools/authTools.js";
import { buildReadTools } from "./tools/readTools.js";
import { buildWriteTools } from "./tools/writeTools.js";
import { buildManagementTools } from "./tools/managementTools.js";
import { CapabilityService } from "./services/capabilityService.js";
import { ConfirmationManager } from "./safety/confirmation.js";
import { AuditLog } from "./safety/auditLog.js";
import * as path from "node:path";

const YAMMER_API_BASE = "https://www.yammer.com/api/v1";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Configuration error: ${(err as Error).message}\n`);
    process.exit(2);
  }

  logger.info(
    {
      tenant: config.azureTenantId,
      authMode: config.authMode,
      cacheDir: config.tokenCacheDir,
      scopes: config.yammerScopes.length,
    },
    "mcp-yammer-engage starting",
  );

  const auth = new MsalAuth({
    clientId: config.azureClientId,
    tenantId: config.azureTenantId,
    scopes: config.yammerScopes,
    cacheDir: config.tokenCacheDir,
    authMode: config.authMode,
  });

  const http = new HttpClient({
    baseUrl: YAMMER_API_BASE,
    getBearerToken: () => auth.getAccessToken(),
    maxConcurrent: config.maxConcurrentRequests,
    timeoutMs: config.requestTimeoutMs,
  });

  const yammer = new YammerClient(http);
  const capabilities = new CapabilityService(yammer);
  const confirmation = new ConfirmationManager();
  const audit = new AuditLog({ filePath: path.join(config.tokenCacheDir, "audit.log") });

  const registry = new ToolRegistry();
  for (const tool of buildAuthTools(auth)) registry.register(tool);
  for (const tool of buildReadTools(yammer)) registry.register(tool);
  for (const tool of buildWriteTools({ client: yammer, auth, confirmation, audit })) {
    registry.register(tool);
  }
  for (const tool of buildManagementTools(yammer)) registry.register(tool);

  // Bonus tool: surfaces capability probe results. Useful to assistants
  // that want to know what is reachable before trying a call.
  const { z } = await import("zod");
  registry.register({
    name: "engage_get_capabilities",
    description:
      "Return the cached capability probe results. Pass `refresh: true` to re-probe.",
    inputSchema: z.object({ refresh: z.boolean().optional() }).strict(),
    handler: async (input) => {
      if (input.refresh) {
        return capabilities.probe();
      }
      const current = capabilities.get();
      if (current.probedAt === null) {
        return capabilities.probe();
      }
      return current;
    },
  });

  const server = new Server(
    {
      name: "mcp-yammer-engage",
      version: "0.1.0-dev",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    registry.call(req.params.name, req.params.arguments),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ tools: registry.list().length }, "mcp-yammer-engage connected over stdio");

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err: sanitizeError(err) }, "fatal startup error");
  process.exit(1);
});
