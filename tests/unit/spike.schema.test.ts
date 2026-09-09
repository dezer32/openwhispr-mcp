import { describe, expect, it, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { defineTool } from '../../src/mcp/defineTool.js';
import { makeDeps } from '../helpers/mcpHarness.js';

/**
 * Wave 0 spike: pins the SDK + zod 4 contract every tool relies on.
 */
const schema = z
  .object({
    q: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.q.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'q must contain at least one token', path: ['q'] });
    }
  });

async function boot() {
  const deps = makeDeps();
  const server = new McpServer({ name: 'spike', version: '0.0.0' }, { capabilities: { tools: {} } });
  defineTool(server, deps, {
    name: 'spike',
    description: 'Spike tool.',
    schema,
    handler: async (args) => ({ echoed: args }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spike-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function text(result: unknown): string {
  return ((result as { content: { type: string; text: string }[] }).content[0]!).text;
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('SDK 1.30 + zod 4 registration contract', () => {
  it('publishes a non-empty JSON Schema for a full z.object', async () => {
    const booted = await boot();
    close = booted.close;
    const { tools } = await booted.client.listTools();
    const spike = tools.find((t) => t.name === 'spike');
    expect(spike).toBeDefined();
    expect(Object.keys(spike!.inputSchema.properties ?? {}).sort()).toEqual(['limit', 'q']);
    expect(spike!.inputSchema.required).toEqual(['q']);
  });

  it('accepts a valid call and applies zod defaults', async () => {
    const booted = await boot();
    close = booted.close;
    const result = await booted.client.callTool({ name: 'spike', arguments: { q: 'hello' } });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual({ echoed: { q: 'hello', limit: 20 } });
  });

  it('rejects an unknown key instead of silently dropping it', async () => {
    const booted = await boot();
    close = booted.close;
    const result = await booted.client.callTool({ name: 'spike', arguments: { q: 'hello', bogus: 1 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Unrecognized key');
    expect(text(result)).toContain('bogus');
  });

  it('enforces superRefine before the handler runs', async () => {
    const booted = await boot();
    close = booted.close;
    const result = await booted.client.callTool({ name: 'spike', arguments: { q: '   ' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('q must contain at least one token');
  });

  /**
   * SDK 1.30 does NOT reject the request at the protocol level on a schema
   * violation: it catches the zod failure and answers with `isError: true` and a
   * plain-text `MCP error -32602: Input validation error: ...` body. Our handler
   * never runs, so these results are NOT our `{error:{kind,...}}` envelope.
   */
  it('reports validation failures as -32602 text, not as our error envelope', async () => {
    const booted = await boot();
    close = booted.close;
    const result = await booted.client.callTool({ name: 'spike', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^MCP error -32602: Input validation error:/);
    expect(() => JSON.parse(text(result))).toThrow();
  });
});
