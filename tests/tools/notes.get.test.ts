import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoteDetail } from '../../src/domain/projections.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';
import { DEFAULT_FOLDERS } from '../fixtures/folders.js';
import { makeNote, resetNoteIds, SYNC_ONLY_KEYS } from '../fixtures/notes.js';

interface GetResult {
  note: NoteDetail;
  enhanced_content_note?: string;
  folder_names_unavailable?: boolean;
  folder_names_note?: string;
}

const SEGMENTS = JSON.stringify([
  { text: 'hello', source: 'mic', timestamp: 1_757_000_000_000 },
  { text: 'there', source: 'system', timestamp: 1_757_000_001_000 },
]);

let bridge: FakeBridge;
let harness: Harness | undefined;

async function boot(notes: Record<string, unknown>[]): Promise<void> {
  bridge = await startFakeBridge({ state: { notes, folders: [...DEFAULT_FOLDERS] } });
  harness = await startHarness({ bridgeConfigPath: bridge.configPath });
}

/** Every key in the payload, at any depth. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}

beforeEach(() => {
  resetNoteIds(1);
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
});

describe('get_note', () => {
  it('says a null folder_name came from a failed lookup, not from an unfiled note', async () => {
    await boot([makeNote({ id: 7, folder_id: 2 })]);
    bridge.on('GET', '/v1/folders/list', () => ({
      status: 500,
      json: { error: { code: 'internal_error', message: 'boom' } },
    }));

    const result = await harness!.callJson<GetResult>('get_note', { note_id: 7 });

    expect(result.note.folder_id).toBe(2);
    expect(result.note.folder_name).toBeNull();
    expect(result.folder_names_unavailable).toBe(true);
    expect(result.folder_names_note).toMatch(/could not be read/i);
  });

  it('returns the note body with its folder name resolved', async () => {
    await boot([makeNote({ id: 7, title: 'Kickoff', content: 'Body text', folder_id: 2 })]);

    const result = await harness!.callJson<GetResult>('get_note', { note_id: 7 });

    expect(result.note.id).toBe(7);
    expect(result.note.title).toBe('Kickoff');
    expect(result.note.content).toBe('Body text');
    expect(result.note.folder_id).toBe(2);
    expect(result.note.folder_name).toBe('Meetings');
    expect(result.note.updated_at).toBe('2026-09-08T08:31:48Z');
  });

  it('keeps the sync bookkeeping columns out of the payload', async () => {
    await boot([makeNote({ id: 1 })]);
    const result = await harness!.callJson<GetResult>('get_note', { note_id: 1 });
    const keys = allKeys(result);
    for (const key of SYNC_ONLY_KEYS) expect(keys.has(key)).toBe(false);
  });
});

describe('get_note transcript handling', () => {
  it('never returns the transcript column, only a hint and a segment count', async () => {
    await boot([makeNote({ id: 3, transcript: SEGMENTS })]);

    const result = await harness!.callJson<GetResult>('get_note', { note_id: 3 });

    expect(allKeys(result).has('transcript')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('"transcript":');
    expect(result.note.has_transcript).toBe(true);
    expect(result.note.transcript_kind).toBe('json');
    expect(result.note.transcript_segment_count).toBe(2);
    expect(result.note.transcript_hint).toContain('get_note_transcript');
  });

  it('withholds a 240 KB transcript no matter how large it is', async () => {
    const huge = JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ text: `line ${i}` })));
    await boot([makeNote({ id: 4, transcript: huge, content: 'short' })]);

    const result = await harness!.callJson<GetResult>('get_note', { note_id: 4 });

    expect(result.note.transcript_segment_count).toBe(900);
    expect(JSON.stringify(result).length).toBeLessThan(4000);
  });

  it('reports no transcript hint for a note without one', async () => {
    await boot([makeNote({ id: 5, transcript: null })]);
    const result = await harness!.callJson<GetResult>('get_note', { note_id: 5 });
    expect(result.note.has_transcript).toBe(false);
    expect(result.note.transcript_hint).toBeNull();
  });
});

describe('get_note enhanced content', () => {
  it('omits the enhanced_content key entirely by default', async () => {
    await boot([makeNote({ id: 6, enhanced_content: 'polished text' })]);

    const result = await harness!.callJson<GetResult>('get_note', { note_id: 6 });

    expect('enhanced_content' in result.note).toBe(false);
    expect(allKeys(result).has('enhanced_content')).toBe(false);
    expect(result.note.has_enhanced_content).toBe(true);
    // Withholding it silently would look like the note has no enhanced version.
    expect(result.enhanced_content_note).toContain('include_enhanced');
  });

  it('returns enhanced_content when asked for it', async () => {
    await boot([makeNote({ id: 6, enhanced_content: 'polished text' })]);

    const result = await harness!.callJson<GetResult>('get_note', {
      note_id: 6,
      include_enhanced: true,
    });

    expect(result.note.enhanced_content).toBe('polished text');
    expect(result.enhanced_content_note).toBeUndefined();
  });

  it('says nothing about enhanced content when the note has none', async () => {
    await boot([makeNote({ id: 6, enhanced_content: null })]);
    const result = await harness!.callJson<GetResult>('get_note', { note_id: 6 });
    expect(result.note.has_enhanced_content).toBe(false);
    expect(result.enhanced_content_note).toBeUndefined();
  });
});

describe('get_note failures', () => {
  it('explains that a 404 covers three different situations', async () => {
    await boot([makeNote({ id: 1 })]);

    const error = toolError(await harness!.call('get_note', { note_id: 999 }));

    expect(error.kind).toBe('not_found');
    expect(error.message).toContain('999');
    const hint = error.hint ?? '';
    expect(hint).toMatch(/never existed|does not exist/i);
    expect(hint).toMatch(/delete/i);
    expect(hint).toMatch(/account|scope/i);
    expect(hint).toContain('list_notes');
  });

  it('does not swallow other upstream failures', async () => {
    await boot([makeNote({ id: 1 })]);
    bridge.fault({ status: 500, body: { error: { code: 'internal_error', message: 'boom' } } });

    const error = toolError(await harness!.call('get_note', { note_id: 1 }));
    expect(error.kind).toBe('upstream_error');
  });
});

describe('get_note schema', () => {
  beforeEach(async () => {
    await boot([makeNote({ id: 1 })]);
  });

  it.each([
    ['a missing note_id', {}],
    ['note_id zero', { note_id: 0 }],
    ['a negative note_id', { note_id: -3 }],
    ['a fractional note_id', { note_id: 1.5 }],
    ['a string note_id', { note_id: '1' }],
    ['an unknown key', { note_id: 1, include_transcript: true }],
  ])('rejects %s', async (_label, args) => {
    expect(isSchemaRejection(await harness!.call('get_note', args))).toBe(true);
  });

  it('advertises note_id as the only required argument', async () => {
    const tool = (await harness!.listTools()).find((t) => t.name === 'get_note');
    const schema = tool!.inputSchema as {
      properties?: Record<string, { default?: unknown }>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['include_enhanced', 'note_id']);
    expect(schema.required).toEqual(['note_id']);
    expect(schema.properties?.include_enhanced?.default).toBe(false);
    expect(schema.additionalProperties).toBe(false);
  });

  it('is advertised as a read-only, closed-world tool with a short description', async () => {
    const tool = (await harness!.listTools()).find((t) => t.name === 'get_note');
    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});
