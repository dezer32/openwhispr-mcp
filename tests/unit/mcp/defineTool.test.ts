import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig, type Config } from '../../../src/config.js';
import { createTtlStore } from '../../../src/domain/snapshotStore.js';
import { ToolError } from '../../../src/bridge/errors.js';
import type { ToolDeps } from '../../../src/deps.js';
import { MAX_TOOL_DESCRIPTION_CHARS, defineTool } from '../../../src/mcp/defineTool.js';
import { isSchemaRejection, toolError } from '../../helpers/mcpHarness.js';

function makeToolDeps(configOverrides: Partial<Config> = {}): ToolDeps {
  const config: Config = { ...loadConfig({} as NodeJS.ProcessEnv), ...configOverrides };
  return {
    config,
    now: () => 0,
    snapshots: createTtlStore<unknown>({ ttlMs: 1000, maxEntries: 3, now: () => 0 }),
    withSession: async () => {
      throw new Error('withSession must not be called');
    },
  };
}

interface Booted {
  client: Client;
  deps: ToolDeps;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

async function boot(
  register: (server: McpServer, deps: ToolDeps) => void,
  configOverrides: Partial<Config> = {},
): Promise<Booted> {
  const deps = makeToolDeps(configOverrides);
  const server = new McpServer({ name: 'define-tool-test', version: '0.0.0' }, { capabilities: { tools: {} } });
  register(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'define-tool-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    deps,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

let booted: Booted | undefined;
afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

describe('defineTool — registration', () => {
  it('publishes the full schema, not an empty object', async () => {
    booted = await boot((server, deps) =>
      defineTool(server, deps, {
        name: 'sample',
        title: 'Sample',
        description: 'A sample tool.',
        schema: z
          .object({ q: z.string().min(1), limit: z.number().int().default(10) })
          .strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: async (args) => args,
      }),
    );

    const { tools } = await booted.client.listTools();
    const tool = tools.find((t) => t.name === 'sample');
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(['limit', 'q']);
    expect(tool!.inputSchema.required).toEqual(['q']);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tool!.title ?? tool!.annotations?.title).toBe('Sample');
  });

  it('lets the SDK reject an unknown key before the handler runs', async () => {
    let ran = false;
    booted = await boot((server, deps) =>
      defineTool(server, deps, {
        name: 'sample',
        description: 'A sample tool.',
        schema: z.object({ q: z.string() }).strict(),
        handler: async () => {
          ran = true;
          return {};
        },
      }),
    );

    const result = await booted.call('sample', { q: 'x', bogus: 1 });
    expect(isSchemaRejection(result)).toBe(true);
    expect(ran).toBe(false);
  });

  it('exports the description budget wave 3 asserts against', () => {
    expect(MAX_TOOL_DESCRIPTION_CHARS).toBe(350);
  });
});

describe('defineTool — failures', () => {
  it('turns a thrown OpenWhisprError into our error envelope', async () => {
    booted = await boot((server, deps) => {
      defineTool(server, deps, {
        name: 'boom',
        description: 'Throws.',
        schema: z.object({}).strict(),
        handler: async () => {
          throw new ToolError('snapshot_expired', 'the cursor expired', { hint: 'Re-run the list call.' });
        },
      });
      defineTool(server, deps, {
        name: 'fine',
        description: 'Works.',
        schema: z.object({}).strict(),
        handler: async () => ({ ok: true }),
      });
    });

    const failed = await booted.call('boom');
    expect(failed.isError).toBe(true);
    expect(toolError(failed)).toMatchObject({ kind: 'snapshot_expired', hint: 'Re-run the list call.' });

    // The server is still usable after a handler blew up.
    const ok = await booted.call('fine');
    expect(ok.isError).toBeFalsy();
  });

  it('survives a thrown value that cannot be stringified', async () => {
    booted = await boot((server, deps) =>
      defineTool(server, deps, {
        name: 'weird',
        description: 'Throws a bare object.',
        schema: z.object({}).strict(),
        handler: async () => {
          throw Object.create(null);
        },
      }),
    );

    const result = await booted.call('weird');
    expect(result.isError).toBe(true);
    expect(toolError(result).kind).toBe('internal_bug');
  });
});

describe('defineTool — result size cap', () => {
  const big = { blob: 'x'.repeat(5_000) };

  it('applies the cap from deps.config', async () => {
    booted = await boot(
      (server, deps) =>
        defineTool(server, deps, {
          name: 'big',
          description: 'Returns a lot.',
          schema: z.object({}).strict(),
          handler: async () => big,
        }),
      { maxResultChars: 200 },
    );

    expect(toolError(await booted.call('big')).kind).toBe('response_too_large');
  });

  it('lets the tool raise the cap above the config default', async () => {
    booted = await boot(
      (server, deps) =>
        defineTool(server, deps, {
          name: 'big',
          description: 'Returns a lot.',
          schema: z.object({}).strict(),
          maxResultChars: 100_000,
          handler: async () => big,
        }),
      { maxResultChars: 200 },
    );

    const result = await booted.call('big');
    expect(result.isError).toBeFalsy();
  });

  it('lets the tool lower the cap below the config default', async () => {
    booted = await boot(
      (server, deps) =>
        defineTool(server, deps, {
          name: 'big',
          description: 'Returns a lot.',
          schema: z.object({}).strict(),
          maxResultChars: 200,
          handler: async () => big,
        }),
      { maxResultChars: 100_000 },
    );

    expect(toolError(await booted.call('big')).kind).toBe('response_too_large');
  });
});

describe('defineTool — cancellation', () => {
  it('hands the call signal to the handler', async () => {
    let seen: AbortSignal | undefined;
    booted = await boot((server, deps) =>
      defineTool(server, deps, {
        name: 'sig',
        description: 'Reports its signal.',
        schema: z.object({}).strict(),
        handler: async (_args, ctx) => {
          seen = ctx.signal;
          return { ok: true };
        },
      }),
    );

    await booted.call('sig');
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
  });

  it('aborts that signal when the client cancels the request', async () => {
    let seen: AbortSignal | undefined;
    let started: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    booted = await boot((server, deps) =>
      defineTool(server, deps, {
        name: 'slow',
        description: 'Waits.',
        schema: z.object({}).strict(),
        handler: async (_args, ctx) => {
          seen = ctx.signal;
          started();
          await held;
          return { ok: true };
        },
      }),
    );

    const controller = new AbortController();
    const pending = booted.client
      .callTool({ name: 'slow', arguments: {} }, undefined, { signal: controller.signal })
      .catch(() => undefined);

    await handlerStarted;
    controller.abort();
    await pending;
    // The cancellation notification travels over the in-memory pair asynchronously.
    for (let i = 0; i < 50 && !seen?.aborted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();

    expect(seen!.aborted).toBe(true);
  });
});
