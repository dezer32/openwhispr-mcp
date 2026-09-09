import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import {
  isSchemaRejection,
  resultText,
  startHarness,
  toolError,
  type Harness,
} from '../helpers/mcpHarness.js';
import {
  DICTIONARY_AS_OBJECTS,
  DICTIONARY_AS_STRINGS,
  DICTIONARY_AS_WRAPPED,
} from '../fixtures/dictionary.js';

interface ListResult {
  words: string[];
  count: number;
  raw_shape: string;
  warning?: string;
}

interface UpdateResult extends ListResult {
  updated: true;
  sent: { add?: string[]; remove?: string[] };
}

let bridge: FakeBridge;
let harness: Harness;

/** Indexed access is checked, so a missing request must fail loudly, not as undefined. */
function requestAt(index: number) {
  const request = bridge.requests[index];
  if (!request) throw new Error(`the bridge saw no request at index ${index}`);
  return request;
}

function bodyAt(index: number): Record<string, unknown> {
  return JSON.parse(requestAt(index).body || '{}') as Record<string, unknown>;
}

function trace(): string[] {
  return bridge.requests.map((request) => `${request.method} ${request.path}`);
}

/** Applies add/remove to the fake's stored list, which the default handler does not. */
function applyUpdates(): void {
  bridge.on('POST', '/v1/dictionary/update', (request) => {
    const patch = JSON.parse(request.body || '{}') as { add?: string[]; remove?: string[] };
    const words = new Set((bridge.state.dictionary as string[]) ?? []);
    for (const word of patch.add ?? []) words.add(word);
    for (const word of patch.remove ?? []) words.delete(word);
    bridge.state.dictionary = [...words];
    return { status: 200, json: { data: { success: true } } };
  });
}

beforeEach(async () => {
  bridge = await startFakeBridge({ state: { dictionary: [...DICTIONARY_AS_STRINGS] } });
  harness = await startHarness({ bridgeConfigPath: bridge.configPath });
});

afterEach(async () => {
  await harness.close();
  await bridge.close();
});

describe('list_dictionary', () => {
  it('reads a bare array of strings', async () => {
    const result = await harness.callJson<ListResult>('list_dictionary');

    expect(result).toMatchObject({
      words: ['Symfony', 'MetaTrader', 'ClickHouse'],
      count: 3,
      raw_shape: 'strings',
    });
    expect(result.warning).toBeUndefined();
  });

  it('reads an array of {word} rows', async () => {
    bridge.state.dictionary = DICTIONARY_AS_OBJECTS;
    const result = await harness.callJson<ListResult>('list_dictionary');
    expect(result).toMatchObject({ words: DICTIONARY_AS_STRINGS, raw_shape: 'objects' });
  });

  it('reads a {words: [...]} wrapper', async () => {
    bridge.state.dictionary = DICTIONARY_AS_WRAPPED;
    const result = await harness.callJson<ListResult>('list_dictionary');
    expect(result).toMatchObject({ words: DICTIONARY_AS_STRINGS, raw_shape: 'wrapped' });
  });

  it('reports an unreadable shape instead of failing the call', async () => {
    bridge.state.dictionary = { total: 3 };

    const result = await harness.call('list_dictionary');
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(resultText(result)) as ListResult;
    expect(payload).toMatchObject({ words: [], count: 0, raw_shape: 'unrecognized' });
    expect(payload.warning).toMatch(/shape/i);
  });

  it('keeps the entries it understands and warns about the ones it skipped', async () => {
    bridge.state.dictionary = ['Symfony', 17, { term: 'MetaTrader' }];

    const result = await harness.callJson<ListResult>('list_dictionary');
    expect(result.words).toEqual(['Symfony']);
    expect(result.warning).toMatch(/2/);
  });

  it('handles an empty dictionary', async () => {
    bridge.state.dictionary = [];
    const result = await harness.callJson<ListResult>('list_dictionary');
    expect(result).toMatchObject({ words: [], count: 0, raw_shape: 'empty' });
  });

  it('takes no arguments and is advertised read-only', async () => {
    expect(isSchemaRejection(await harness.call('list_dictionary', { limit: 5 }))).toBe(true);

    const tool = (await harness.listTools()).find((t) => t.name === 'list_dictionary');
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('update_dictionary', () => {
  it('adds words and reads the list back in the same session', async () => {
    applyUpdates();

    const result = await harness.callJson<UpdateResult>('update_dictionary', { add: ['Qdrant'] });

    expect(bodyAt(0)).toEqual({ add: ['Qdrant'] });
    expect(trace()).toEqual(['POST /v1/dictionary/update', 'GET /v1/dictionary/list']);
    expect(result.sent).toEqual({ add: ['Qdrant'] });
    expect(result.words).toContain('Qdrant');
    expect(result.count).toBe(4);
  });

  it('removes words', async () => {
    applyUpdates();

    const result = await harness.callJson<UpdateResult>('update_dictionary', {
      remove: ['MetaTrader'],
    });

    expect(result.sent).toEqual({ remove: ['MetaTrader'] });
    expect(result.words).not.toContain('MetaTrader');
  });

  it('trims, de-duplicates and drops blanks before sending', async () => {
    applyUpdates();

    const result = await harness.callJson<UpdateResult>('update_dictionary', {
      add: ['  Qdrant ', 'Qdrant', '', '   ', 'ONNX'],
      remove: ['ClickHouse', 'ClickHouse'],
    });

    expect(bodyAt(0)).toEqual({ add: ['Qdrant', 'ONNX'], remove: ['ClickHouse'] });
    expect(result.sent).toEqual({ add: ['Qdrant', 'ONNX'], remove: ['ClickHouse'] });
  });

  it('sends only the halves it was given', async () => {
    applyUpdates();
    await harness.callJson<UpdateResult>('update_dictionary', { add: ['Qdrant'] });
    expect(Object.keys(bodyAt(0))).toEqual(['add']);
  });

  it('refuses a call that would change nothing', async () => {
    for (const args of [{}, { add: [] }, { add: ['  '] }, { add: [], remove: [] }]) {
      expect(isSchemaRejection(await harness.call('update_dictionary', args))).toBe(true);
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it('rejects anything the bridge would not understand', async () => {
    expect(isSchemaRejection(await harness.call('update_dictionary', { words: ['Qdrant'] }))).toBe(true);
    expect(isSchemaRejection(await harness.call('update_dictionary', { add: 'Qdrant' }))).toBe(true);
    expect(isSchemaRejection(await harness.call('update_dictionary', { add: [42] }))).toBe(true);
  });

  it('does not replay the write when the token rotates after it committed', async () => {
    applyUpdates();
    bridge.on('GET', '/v1/dictionary/list', () => ({
      status: 401,
      json: { error: { code: 'unauthorized', message: 'Invalid or missing token' } },
    }));

    const payload = toolError(await harness.call('update_dictionary', { add: ['Qdrant'] }));

    expect(payload.kind).toBe('unauthorized');
    expect(payload.hint).toMatch(/already/i);
    // Exactly one POST: replaying it would have added the word twice.
    expect(trace().filter((entry) => entry.startsWith('POST'))).toHaveLength(1);
  });

  it('is advertised as a non-destructive write', async () => {
    const tool = (await harness.listTools()).find((t) => t.name === 'update_dictionary');

    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
