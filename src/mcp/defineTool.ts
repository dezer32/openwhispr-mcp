import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { ToolDeps } from '../deps.js';
import { logDebug, logError } from '../log.js';
import { mapToolError } from './errorMap.js';
import { errorResult, jsonResult } from './result.js';

/**
 * Tool descriptions are context the agent pays for on every single request, so
 * the whole set has a budget. Enforced by the tool-surface test in wave 3.
 */
export const MAX_TOOL_DESCRIPTION_CHARS = 350;

export interface ToolContext {
  deps: ToolDeps;
  /** Cancellation signal for this tool call, forwarded to the bridge session. */
  signal: AbortSignal | undefined;
  toolName: string;
}

export interface ToolDefinition<S extends z.ZodType> {
  name: string;
  title?: string;
  /** Keep under `MAX_TOOL_DESCRIPTION_CHARS`. */
  description: string;
  /**
   * The complete schema, registered as-is. The SDK validates with it and derives
   * the JSON Schema from it, so a second `.strict()` pass inside the handler
   * would be blind: unknown keys are already gone by then.
   */
  schema: S;
  annotations?: ToolAnnotations;
  /** Returns a JSON-able value; the wrapper serialises and size-caps it. */
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
  /** Overrides the default result-size cap for this tool. */
  maxResultChars?: number;
}

interface RegisterToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
}

export function defineTool<S extends z.ZodType>(
  server: McpServer,
  deps: ToolDeps,
  def: ToolDefinition<S>,
): void {
  const config: RegisterToolConfig = {
    description: def.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK accepts a full schema
    inputSchema: def.schema as any,
  };
  if (def.title) config.title = def.title;
  if (def.annotations) config.annotations = def.annotations;

  server.registerTool(def.name, config as never, (async (
    args: z.infer<S>,
    extra: { signal?: AbortSignal },
  ): Promise<CallToolResult> => {
    const started = Date.now();
    const ctx: ToolContext = { deps, signal: extra?.signal, toolName: def.name };
    try {
      const value = await def.handler(args, ctx);
      logDebug('tool ok', { tool: def.name, ms: Date.now() - started });
      return jsonResult(value, { maxChars: def.maxResultChars ?? deps.config.maxResultChars });
    } catch (err) {
      try {
        const payload = await mapToolError(err, { deps, toolName: def.name, signal: extra?.signal });
        logDebug('tool failed', { tool: def.name, kind: payload.kind, ms: Date.now() - started });
        return errorResult(payload);
      } catch (mappingFailure) {
        // Last resort: a tool call must always come back as a result, never as a
        // protocol-level failure that leaves the agent without a kind to react to.
        logError('error mapping failed', {
          tool: def.name,
          error: mappingFailure instanceof Error ? mappingFailure.message : 'unknown',
        });
        return errorResult({
          kind: 'internal_bug',
          message: 'the tool failed and the failure itself could not be classified',
          hint: 'This is a bug in openwhispr-mcp. Re-run with OPENWHISPR_MCP_DEBUG=1 and check stderr.',
        });
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callback shape depends on the schema branch
  }) as any);
}
