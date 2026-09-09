import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { startHarness, type Harness } from '../helpers/mcpHarness.js';
import { TOOL_NAMES } from '../../src/mcp/tools/index.js';

/**
 * `tools/list` is context every client pays for in every session, so its shape
 * is a contract, not an implementation detail.
 */
const MAX_DESCRIPTION_CHARS = 350;

/** Tools that must not be advertised as read-only. */
const WRITE_TOOLS = new Set(['create_note', 'update_note', 'delete_note', 'create_folder', 'update_dictionary']);

let harness: Harness;
let tools: Tool[];

beforeAll(async () => {
  // No bridge is needed: registration performs no I/O.
  harness = await startHarness({ bridgeConfigPath: '/nonexistent/openwhispr/cli-bridge.json' });
  tools = await harness.listTools();
});

afterAll(async () => {
  await harness?.close();
});

describe('tools/list contract', () => {
  it('advertises exactly the 15 declared tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('keeps every description within the context budget', () => {
    const tooLong = tools
      .filter((t) => (t.description ?? '').length > MAX_DESCRIPTION_CHARS)
      .map((t) => `${t.name}: ${(t.description ?? '').length}`);
    expect(tooLong).toEqual([]);
  });

  it('gives every tool a non-empty description', () => {
    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toBe('');
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(20);
    }
  });

  it('publishes a real JSON Schema object for every tool', () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      // `.strict()` must survive the JSON Schema conversion, or clients will
      // happily send keys the server would then reject at call time.
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it('publishes parameters for every tool that takes them', () => {
    const parameterless = new Set(['health', 'list_folders', 'list_dictionary']);
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      if (parameterless.has(tool.name)) {
        expect(props, tool.name).toEqual([]);
      } else {
        expect(props.length, tool.name).toBeGreaterThan(0);
      }
    }
  });

  it('marks read-only tools read-only and write tools not', () => {
    for (const tool of tools) {
      const readOnly = tool.annotations?.readOnlyHint;
      expect(readOnly, tool.name).toBe(!WRITE_TOOLS.has(tool.name));
    }
  });

  it('marks only delete_note destructive', () => {
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
    expect(destructive).toEqual(['delete_note']);
  });

  it('marks every tool as closed-world — the bridge is loopback only', () => {
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it('describes search_notes as FTS5 up front', () => {
    const search = tools.find((t) => t.name === 'search_notes');
    expect(search?.description).toMatch(/^Full-text \(FTS5 prefix AND\)/);
  });
});

describe('projection contract', () => {
  it('exposes raw_text only on the single-transcription tool', async () => {
    const { toTranscription } = await import('../../src/domain/projections.js');
    const { makeTranscription } = await import('../fixtures/transcriptions.js');
    const row = makeTranscription({ raw_text: 'befor postprocessing' });
    expect(toTranscription(row)).not.toHaveProperty('raw_text');
    expect(toTranscription(row, { includeRaw: true }).raw_text).toBe('befor postprocessing');
  });
});
