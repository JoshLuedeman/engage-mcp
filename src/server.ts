#!/usr/bin/env node
/**
 * MCP server entry point.
 *
 * Communicates with the MCP client over stdio. CRITICAL: nothing must
 * write to stdout other than the MCP framing — all diagnostic logging
 * goes through `logger` (stderr).
 *
 * Phase 0: this server registers ZERO tools. It connects the transport,
 * logs startup to stderr, and waits. Subsequent phases register tools
 * via `src/tools/index.ts`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { logger, sanitizeError } from "./utils/logger.js";
import { toErrorEnvelope } from "./utils/errors.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Configuration errors must be visible on stderr; the process exits
    // before any MCP framing happens.
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

  // Phase 0: empty tool registry. Phase 1+ wires real tools here.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const envelope = toErrorEnvelope(
      new Error(`Unknown tool: ${req.params.name}. No tools are registered in Phase 0.`),
    );
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(envelope) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp-yammer-engage connected over stdio");

  // Graceful shutdown on transport close (SDK closes via process signal).
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
