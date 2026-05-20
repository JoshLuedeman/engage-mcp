/**
 * Tool registry — converts zod input schemas to MCP tool definitions
 * and dispatches CallTool requests to the right handler.
 *
 * Each tool definition holds:
 *  - name (kebab-case-ish but Yammer-style underscores per spec)
 *  - description (single sentence)
 *  - inputSchema (zod -> JSON Schema)
 *  - handler returning the structured result
 *
 * The registry catches typed errors and returns them through the
 * standard MCP error envelope.
 */
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorEnvelope } from "../utils/errors.js";
import { logger, sanitizeError } from "../utils/logger.js";

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: I;
  handler: (input: z.infer<I>) => Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<I extends z.ZodTypeAny>(def: ToolDefinition<I>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as ToolDefinition);
  }

  list(): Tool[] {
    return Array.from(this.tools.values()).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.inputSchema, {
        $refStrategy: "none",
        target: "openApi3",
      }) as Tool["inputSchema"],
    }));
  }

  async call(name: string, rawInput: unknown): Promise<CallToolResult> {
    const def = this.tools.get(name);
    if (!def) {
      return errorResult(new Error(`Unknown tool: ${name}`));
    }
    const parsed = def.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      return errorResult(new Error(`Invalid input for ${name}:\n${issues}`));
    }
    try {
      const result = await def.handler(parsed.data);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      logger.warn({ tool: name, err: sanitizeError(err) }, "tool handler threw");
      return errorResult(err);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

function errorResult(err: unknown): CallToolResult {
  const envelope = toErrorEnvelope(err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}
