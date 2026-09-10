import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createTtlStore } from '../../src/domain/snapshotStore.js';
import { createServer } from '../../src/server.js';
import { withBridgeSession } from '../../src/bridge/session.js';
import type { ToolDeps } from '../../src/deps.js';

export interface HarnessOptions {
  /** Path to the handshake file; usually `fakeBridge.configPath`. */
  bridgeConfigPath?: string;
  config?: Partial<Config>;
  now?: () => number;
  /** Replaces the whole dependency object (for pure-unit tool tests). */
  deps?: ToolDeps;
  snapshotTtlMs?: number;
  snapshotMaxEntries?: number;
}

export interface Harness {
  client: Client;
  deps: ToolDeps;
  listTools(): Promise<Tool[]>;
  listResources(): Promise<Resource[]>;
  /** Rejects with an `McpError` when the server refuses the read. */
  readResource(uri: string): Promise<ReadResourceResult>;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Parses the single JSON text block a tool returns. */
  callJson<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export function makeDeps(options: HarnessOptions = {}): ToolDeps {
  if (options.deps) return options.deps;
  const base = loadConfig({
    ...process.env,
    OPENWHISPR_BRIDGE_CONFIG: options.bridgeConfigPath ?? process.env.OPENWHISPR_BRIDGE_CONFIG,
  } as NodeJS.ProcessEnv);
  const config: Config = { ...base, ...options.config };
  const now = options.now ?? (() => Date.now());
  const snapshots = createTtlStore<unknown>({
    ttlMs: options.snapshotTtlMs ?? 120_000,
    maxEntries: options.snapshotMaxEntries ?? 3,
    now,
  });
  return {
    config,
    now,
    snapshots,
    withSession: (sessionOptions, fn) => withBridgeSession(config, sessionOptions, fn),
  };
}

/** Boots the real server over an in-memory transport pair. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const deps = makeDeps(options);
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const harness: Harness = {
    client,
    deps,
    async listTools() {
      const { tools } = await client.listTools();
      return tools;
    },
    async listResources() {
      const { resources } = await client.listResources();
      return resources;
    },
    async readResource(uri) {
      return client.readResource({ uri });
    },
    async call(name, args = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async callJson<T>(name: string, args: Record<string, unknown> = {}) {
      const result = await harness.call(name, args);
      const block = result.content?.[0];
      if (!block || block.type !== 'text') {
        throw new Error(`tool ${name} returned no text block: ${JSON.stringify(result)}`);
      }
      return JSON.parse(block.text) as T;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
  return harness;
}

export interface ToolErrorPayloadView {
  kind: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export function resultText(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') throw new Error('no text block in result');
  return block.text;
}

/**
 * SDK 1.30 answers a schema violation with `isError: true` and a plain-text
 * `MCP error -32602: Input validation error: ...` body — our handler never runs,
 * so such a result carries no `{error:{kind}}` envelope.
 */
export function isSchemaRejection(result: CallToolResult): boolean {
  return result.isError === true && /^MCP error -32602: Input validation error:/.test(resultText(result));
}

/** Reads `{error:{kind,...}}` out of an `isError` result produced by our handlers. */
export function toolError(result: CallToolResult): ToolErrorPayloadView {
  const text = resultText(result);
  if (isSchemaRejection(result)) {
    throw new Error(`result is an SDK schema rejection, not a tool error: ${text}`);
  }
  const parsed = JSON.parse(text) as { error?: ToolErrorPayloadView };
  if (!parsed.error) throw new Error(`result is not an error payload: ${text}`);
  return parsed.error;
}
