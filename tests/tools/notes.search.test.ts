import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoteSummary } from '../../src/domain/projections.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, startHarness, type Harness } from '../helpers/mcpHarness.js';
import { DEFAULT_FOLDERS } from '../fixtures/folders.js';
import { makeNote, resetNoteIds, SYNC_ONLY_KEYS } from '../fixtures/notes.js';

interface SearchHit extends NoteSummary {
  matched_in: string[];
  snippet: string | null;
  snippet_field: string | null;
}

interface SearchResult {
  notes: SearchHit[];
  limit: number;
  tokens_used: string[];
  fts_query: string;
  match_semantics: string;
  score_available: boolean;
  complete: boolean;
  notice: string;
  tokenizer_note: string;
  operator_note: string;
  folder_names_unavailable?: boolean;
  folder_names_note?: string;
}

let bridge: FakeBridge;
let harness: Harness | undefined;

async function boot(searchResults: Record<string, unknown>[]): Promise<void> {
  bridge = await startFakeBridge({
    state: { notes: [], searchResults, folders: [...DEFAULT_FOLDERS] },
  });
  harness = await startHarness({ bridgeConfigPath: bridge.configPath });
}

beforeEach(() => {
  resetNoteIds(1);
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
});

describe('search_notes', () => {
  it('flags a failed folder listing instead of returning bare null folder names', async () => {
    await boot([makeNote({ id: 1, title: 'Roadmap', folder_id: 2 })]);
    bridge.on('GET', '/v1/folders/list', () => ({
      status: 500,
      json: { error: { code: 'internal_error', message: 'boom' } },
    }));

    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'roadmap' });

    expect(result.notes[0]!.folder_id).toBe(2);
    expect(result.notes[0]!.folder_name).toBeNull();
    expect(result.folder_names_unavailable).toBe(true);
    expect(result.folder_names_note).toMatch(/could not be read/i);
  });

  it('returns note summaries with the fields the match came from', async () => {
    await boot([
      makeNote({ id: 1, title: 'Roadmap', content: 'The quarterly roadmap draft.', folder_id: 2 }),
    ]);

    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'roadmap' });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.id).toBe(1);
    expect(result.notes[0]!.folder_name).toBe('Meetings');
    expect(result.notes[0]!.matched_in).toEqual(['title', 'content']);
    expect(result.notes[0]!.snippet).toContain('roadmap');
    expect(result.tokens_used).toEqual(['roadmap']);
    expect(result.match_semantics).toBe('FTS5 prefix AND');
    expect(result.score_available).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.limit).toBe(20);
  });

  it('names enhanced_content when that hidden field is the only thing that matched', async () => {
    await boot([
      makeNote({
        id: 2,
        title: 'Alpha',
        content: 'nothing here',
        enhanced_content: 'a polished zeta paragraph',
      }),
    ]);

    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'zeta' });

    expect(result.notes[0]!.matched_in).toEqual(['enhanced_content']);
    expect(result.notes[0]!.snippet_field).toBe('enhanced_content');
    expect(result.notes[0]!.snippet).toContain('zeta');
  });

  it('forwards the raw query and the limit to the bridge, which builds the FTS query itself', async () => {
    await boot([makeNote({ id: 1 })]);

    await harness!.callJson<SearchResult>('search_notes', { q: 'note body', limit: 5 });

    const request = bridge.requests.find((r) => r.path === '/v1/notes/search');
    expect(request?.query).toMatchObject({ q: 'note body', limit: '5' });
  });

  it('resolves folder names with a single folder listing', async () => {
    await boot([makeNote({ id: 1, folder_id: 1 }), makeNote({ id: 2, folder_id: 3 })]);

    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'note' });

    expect(result.notes.map((n) => n.folder_name)).toEqual(['Personal', 'Videos']);
    expect(bridge.requests.filter((r) => r.path === '/v1/folders/list')).toHaveLength(1);
  });

  it('keeps bodies and sync columns out of the hits', async () => {
    await boot([makeNote({ id: 1, content: 'searchable body' })]);

    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'searchable' });
    const hit = result.notes[0]! as unknown as Record<string, unknown>;

    expect(hit.content).toBeUndefined();
    expect(hit.transcript).toBeUndefined();
    for (const key of SYNC_ONLY_KEYS) expect(hit[key]).toBeUndefined();
  });

  it('reports complete:false when the bridge returned exactly the requested limit', async () => {
    await boot([makeNote({ id: 1 }), makeNote({ id: 2 }), makeNote({ id: 3 })]);

    const truncated = await harness!.callJson<SearchResult>('search_notes', { q: 'note', limit: 2 });
    expect(truncated.notes).toHaveLength(2);
    expect(truncated.complete).toBe(false);
    expect(truncated.notice).toMatch(/limit/i);

    const full = await harness!.callJson<SearchResult>('search_notes', { q: 'note', limit: 20 });
    expect(full.complete).toBe(true);
  });

  it('says that the bridge offers no semantic search and no score', async () => {
    await boot([makeNote({ id: 1 })]);
    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'note' });
    expect(result.notice).toMatch(/semantic/i);
    expect(result.notice).toMatch(/score|rank/i);
  });

  it('returns an empty hit list rather than an error when nothing matches', async () => {
    await boot([]);
    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'nothing' });
    expect(result.notes).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

describe('search_notes tokenizer disclosure', () => {
  it('reports that "C++" collapses to a single prefix term and explains why', async () => {
    await boot([makeNote({ id: 1, title: 'C++ notes', content: 'Comparing C++ and Rust.' })]);

    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'C++' });

    expect(result.tokens_used).toEqual(['C']);
    expect(result.fts_query).toBe('"C"*');
    expect(result.tokenizer_note).toContain('+');
    expect(result.tokenizer_note).toMatch(/prefix/i);
  });

  it('reports that AND is a required literal word, not an operator', async () => {
    await boot([makeNote({ id: 1 })]);

    const result = await harness!.callJson<SearchResult>('search_notes', { q: 'проект AND отчёт' });

    expect(result.tokens_used).toEqual(['проект', 'AND', 'отчёт']);
    expect(result.fts_query).toBe('"проект"* "AND"* "отчёт"*');
    expect(result.operator_note).toContain('AND');
    expect(result.operator_note).toMatch(/OR/);
    expect(result.operator_note).toMatch(/NEAR/);
    expect(result.operator_note).toMatch(/not (an )?operator|literal|ordinary word/i);
  });
});

describe('search_notes schema', () => {
  beforeEach(async () => {
    await boot([makeNote({ id: 1 })]);
  });

  it.each([
    ['an empty query', { q: '' }],
    ['a query of punctuation only', { q: '!!! ***' }],
    ['a query of whitespace only', { q: '   ' }],
    ['a missing query', {}],
    ['limit below the minimum', { q: 'note', limit: 0 }],
    ['limit above the maximum', { q: 'note', limit: 101 }],
    ['a fractional limit', { q: 'note', limit: 1.5 }],
    ['an unknown key', { q: 'note', note_type: 'personal' }],
  ])('rejects %s', async (_label, args) => {
    expect(isSchemaRejection(await harness!.call('search_notes', args))).toBe(true);
  });

  it('never reaches the bridge with a query that has no tokens', async () => {
    await harness!.call('search_notes', { q: '???' });
    expect(bridge.requests.filter((r) => r.path === '/v1/notes/search')).toHaveLength(0);
  });

  it('still advertises its arguments after superRefine wraps the object', async () => {
    const tool = (await harness!.listTools()).find((t) => t.name === 'search_notes');
    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['limit', 'q']);
    expect(schema.required).toEqual(['q']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('is advertised as a read-only, closed-world tool whose description opens with the semantics', async () => {
    const tool = (await harness!.listTools()).find((t) => t.name === 'search_notes');
    expect(tool).toBeDefined();
    expect(tool!.description!.startsWith('Full-text (FTS5 prefix AND)')).toBe(true);
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});
