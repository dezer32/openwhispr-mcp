import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_UPSTREAM_LIMIT } from '../../src/config.js';
import type { NoteSummary } from '../../src/domain/projections.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';
import { DEFAULT_FOLDERS } from '../fixtures/folders.js';
import { makeNote, resetNoteIds, SYNC_ONLY_KEYS } from '../fixtures/notes.js';

interface ListResult {
  notes: NoteSummary[];
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
  complete: boolean;
  snapshot: { id: string; taken_at: string; total_in_snapshot: number };
  notice: string;
  folder_names_unavailable?: boolean;
  folder_names_note?: string;
}

const START = 1_757_000_000_000;

let bridge: FakeBridge;
let harness: Harness | undefined;
let clock = START;

async function boot(notes: Record<string, unknown>[]): Promise<void> {
  bridge = await startFakeBridge({ state: { notes, folders: [...DEFAULT_FOLDERS] } });
  harness = await startHarness({ bridgeConfigPath: bridge.configPath, now: () => clock });
}

function listRequests(): number {
  return bridge.requests.filter((r) => r.path === '/v1/notes/list').length;
}

beforeEach(() => {
  clock = START;
  resetNoteIds(1);
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
});

describe('list_notes pagination', () => {
  it('cuts both pages from one snapshot, with a single upstream read', async () => {
    await boot([makeNote({ id: 1 }), makeNote({ id: 2 }), makeNote({ id: 3 })]);

    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 1 });
    expect(first.notes.map((n) => n.id)).toEqual([1]);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBeTruthy();
    expect(first.snapshot.total_in_snapshot).toBe(3);
    expect(first.page_size).toBe(1);

    const second = await harness!.callJson<ListResult>('list_notes', {
      page_size: 1,
      cursor: first.next_cursor!,
    });
    expect(second.notes.map((n) => n.id)).toEqual([2]);
    expect(second.snapshot.id).toBe(first.snapshot.id);

    const third = await harness!.callJson<ListResult>('list_notes', {
      page_size: 1,
      cursor: second.next_cursor!,
    });
    expect(third.notes.map((n) => n.id)).toEqual([3]);
    expect(third.has_more).toBe(false);
    expect(third.next_cursor).toBeNull();

    // The whole point of the snapshot: paging never re-reads the bridge.
    expect(listRequests()).toBe(1);
  });

  it('says in the note that has_more is exact inside the snapshot', async () => {
    await boot([makeNote({ id: 1 }), makeNote({ id: 2 })]);
    const page = await harness!.callJson<ListResult>('list_notes', { page_size: 1 });
    expect(page.notice).toMatch(/has_more/);
    expect(page.notice).toMatch(/exact/i);
    expect(page.snapshot.taken_at).toBe(new Date(START).toISOString());
  });

  it('lets the page size change mid-listing — it is not part of the snapshot identity', async () => {
    await boot([makeNote({ id: 1 }), makeNote({ id: 2 }), makeNote({ id: 3 })]);

    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 1 });
    const rest = await harness!.callJson<ListResult>('list_notes', {
      page_size: 50,
      cursor: first.next_cursor!,
    });

    expect(rest.notes.map((n) => n.id)).toEqual([2, 3]);
    expect(rest.next_cursor).toBeNull();
    expect(listRequests()).toBe(1);
  });

  it('accepts the original filters repeated alongside the cursor', async () => {
    await boot([makeNote({ id: 1 }), makeNote({ id: 2 })]);

    const first = await harness!.callJson<ListResult>('list_notes', {
      page_size: 1,
      note_type: 'personal',
    });
    const second = await harness!.callJson<ListResult>('list_notes', {
      page_size: 1,
      note_type: 'personal',
      cursor: first.next_cursor!,
    });

    expect(second.notes.map((n) => n.id)).toEqual([2]);
  });
});

describe('list_notes snapshot lifetime', () => {
  it('reports snapshot_expired once the snapshot has aged out', async () => {
    await boot([makeNote({ id: 1 }), makeNote({ id: 2 })]);
    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 1 });

    clock = START + 121_000;

    const result = await harness!.call('list_notes', { page_size: 1, cursor: first.next_cursor! });
    const error = toolError(result);
    expect(error.kind).toBe('snapshot_expired');
    expect(error.message).toBe('snapshot expired, re-list without a cursor');
  });

  it('reports snapshot_expired when a fourth listing evicts the first snapshot', async () => {
    await boot([makeNote({ id: 1 }), makeNote({ id: 2 })]);
    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 1 });

    for (let i = 0; i < 3; i += 1) {
      await harness!.callJson<ListResult>('list_notes', { page_size: 1 });
    }

    const error = toolError(
      await harness!.call('list_notes', { page_size: 1, cursor: first.next_cursor! }),
    );
    expect(error.kind).toBe('snapshot_expired');
  });

  it('names the filter that changed when a cursor is reused with different filters', async () => {
    await boot([makeNote({ id: 1, note_type: 'personal' }), makeNote({ id: 2, note_type: 'personal' })]);

    const first = await harness!.callJson<ListResult>('list_notes', {
      page_size: 1,
      note_type: 'personal',
    });

    const error = toolError(
      await harness!.call('list_notes', {
        page_size: 1,
        note_type: 'meeting',
        cursor: first.next_cursor!,
      }),
    );

    expect(error.kind).toBe('invalid_argument');
    expect(error.message).toContain('note_type');
    expect(error.message).toContain('personal');
    expect(error.message).toContain('meeting');
    expect(error.details?.changed_filters).toEqual(['note_type']);
  });

  it('names folder_id when the folder filter is the one that changed', async () => {
    await boot([makeNote({ id: 1, folder_id: 1 }), makeNote({ id: 2, folder_id: 1 })]);

    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 1, folder_id: 1 });
    const error = toolError(
      await harness!.call('list_notes', { page_size: 1, folder_id: 2, cursor: first.next_cursor! }),
    );

    expect(error.kind).toBe('invalid_argument');
    expect(error.message).toContain('folder_id');
    expect(error.details?.changed_filters).toEqual(['folder_id']);
  });

  it('rejects a malformed cursor as invalid_argument, not as an expired snapshot', async () => {
    await boot([makeNote({ id: 1 })]);
    const error = toolError(await harness!.call('list_notes', { cursor: 'obviously-not-a-cursor' }));
    expect(error.kind).toBe('invalid_argument');
    expect(error.hint).toBeTruthy();
  });
});

describe('list_notes upstream cap', () => {
  it('reports complete:false and stops issuing cursors at the end of a saturated snapshot', async () => {
    const notes = Array.from({ length: MAX_UPSTREAM_LIMIT + 20 }, (_, i) => makeNote({ id: i + 1 }));
    await boot(notes);

    let page = await harness!.callJson<ListResult>('list_notes', { page_size: 100 });
    expect(page.complete).toBe(false);
    expect(page.notice).toMatch(/caps a single read at 500 rows/);
    expect(page.snapshot.total_in_snapshot).toBe(MAX_UPSTREAM_LIMIT);

    const seen: number[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      seen.push(...page.notes.map((n) => n.id));
      expect(page.complete).toBe(false);
      if (page.next_cursor === null) break;
      page = await harness!.callJson<ListResult>('list_notes', {
        page_size: 100,
        cursor: page.next_cursor,
      });
    }

    expect(page.next_cursor).toBeNull();
    expect(page.has_more).toBe(false);
    expect(seen).toHaveLength(MAX_UPSTREAM_LIMIT);
    expect(new Set(seen).size).toBe(MAX_UPSTREAM_LIMIT);
    expect(listRequests()).toBe(1);
  });

  it('keeps explaining snapshot paging on every page of a saturated snapshot', async () => {
    const notes = Array.from({ length: MAX_UPSTREAM_LIMIT + 20 }, (_, i) => makeNote({ id: i + 1 }));
    await boot(notes);

    // The saturated case is the only one where paging is really used, so losing
    // the snapshot explanation exactly there is the failure this guards.
    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 100 });
    expect(first.notice).toMatch(/cut from a single snapshot/i);
    expect(first.notice).toMatch(/caps a single read at 500 rows/);

    const second = await harness!.callJson<ListResult>('list_notes', {
      page_size: 100,
      cursor: first.next_cursor!,
    });
    expect(second.notice).toBe(first.notice);
  });

  it('still issues a cursor inside a saturated snapshot, contrary to what the README used to claim', async () => {
    const notes = Array.from({ length: MAX_UPSTREAM_LIMIT + 20 }, (_, i) => makeNote({ id: i + 1 }));
    await boot(notes);

    const page = await harness!.callJson<ListResult>('list_notes', { page_size: 100 });
    expect(page.complete).toBe(false);
    expect(page.has_more).toBe(true);
    // `complete:false` and a usable cursor coexist: the cursor pages the snapshot,
    // `complete` speaks about the rows the bridge never handed over.
    expect(page.next_cursor).toBeTruthy();
  });

  it('asks the bridge for the cap in one read', async () => {
    await boot([makeNote({ id: 1 })]);
    await harness!.callJson<ListResult>('list_notes', { note_type: 'personal', folder_id: 1 });

    const request = bridge.requests.find((r) => r.path === '/v1/notes/list');
    expect(request?.query).toMatchObject({
      limit: String(MAX_UPSTREAM_LIMIT),
      note_type: 'personal',
      folder_id: '1',
    });
  });

  it('reports complete:true when the read came back below the cap', async () => {
    await boot([makeNote({ id: 1 })]);
    const page = await harness!.callJson<ListResult>('list_notes');
    expect(page.complete).toBe(true);
    expect(page.page_size).toBe(20);
  });
});

describe('list_notes projection', () => {
  it('resolves folder_name with a single folder listing per call', async () => {
    await boot([makeNote({ id: 1, folder_id: 2 }), makeNote({ id: 2, folder_id: 3 })]);

    const page = await harness!.callJson<ListResult>('list_notes');

    expect(page.notes.map((n) => n.folder_name)).toEqual(['Meetings', 'Videos']);
    expect(bridge.requests.filter((r) => r.path === '/v1/folders/list')).toHaveLength(1);
  });

  it('does not read folders again while paging inside the snapshot', async () => {
    await boot([makeNote({ id: 1, folder_id: 1 }), makeNote({ id: 2, folder_id: 1 })]);

    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 1 });
    const second = await harness!.callJson<ListResult>('list_notes', {
      page_size: 1,
      cursor: first.next_cursor!,
    });

    expect(second.notes[0]!.folder_name).toBe('Personal');
    expect(bridge.requests.filter((r) => r.path === '/v1/folders/list')).toHaveLength(1);
  });

  it('distinguishes "the folder list would not read" from "this note has no folder"', async () => {
    await boot([makeNote({ id: 1, folder_id: 2 }), makeNote({ id: 2, folder_id: 3 })]);
    bridge.on('GET', '/v1/folders/list', () => ({
      status: 500,
      json: { error: { code: 'internal_error', message: 'boom' } },
    }));

    const first = await harness!.callJson<ListResult>('list_notes', { page_size: 1 });
    expect(first.notes[0]!.folder_id).toBe(2);
    expect(first.notes[0]!.folder_name).toBeNull();
    expect(first.folder_names_unavailable).toBe(true);
    expect(first.folder_names_note).toMatch(/could not be read/i);

    // Pages 2..N never touch the bridge, so the fact has to ride the snapshot.
    const second = await harness!.callJson<ListResult>('list_notes', {
      page_size: 1,
      cursor: first.next_cursor!,
    });
    expect(second.folder_names_unavailable).toBe(true);
    expect(second.notes[0]!.folder_name).toBeNull();
  });

  it('leaves the flag off when the folder list read fine', async () => {
    await boot([makeNote({ id: 1, folder_id: 2 })]);
    const page = await harness!.callJson<ListResult>('list_notes');

    expect(page.notes[0]!.folder_name).toBe('Meetings');
    expect(page.folder_names_unavailable).toBeUndefined();
    expect(page.folder_names_note).toBeUndefined();
  });

  it('keeps bodies, transcripts and sync columns out of the summaries', async () => {
    await boot([
      makeNote({
        id: 1,
        content: 'x'.repeat(5000),
        enhanced_content: 'enhanced',
        transcript: JSON.stringify([{ text: 'hi' }, { text: 'there' }]),
      }),
    ]);

    const page = await harness!.callJson<ListResult>('list_notes');
    const note = page.notes[0]! as unknown as Record<string, unknown>;

    expect(note.content).toBeUndefined();
    expect(note.enhanced_content).toBeUndefined();
    expect(note.transcript).toBeUndefined();
    for (const key of SYNC_ONLY_KEYS) expect(note[key]).toBeUndefined();

    expect(note.content_chars).toBe(5000);
    expect(note.has_enhanced_content).toBe(true);
    expect(note.transcript_segment_count).toBe(2);
  });

  it('answers an empty listing without a cursor', async () => {
    await boot([]);
    const page = await harness!.callJson<ListResult>('list_notes');
    expect(page.notes).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
    expect(page.complete).toBe(true);
  });
});

describe('list_notes schema', () => {
  beforeEach(async () => {
    await boot([makeNote({ id: 1 })]);
  });

  it.each([
    ['page_size below the minimum', { page_size: 0 }],
    ['page_size above the maximum', { page_size: 101 }],
    ['a fractional page_size', { page_size: 2.5 }],
    ['an unknown note_type', { note_type: 'archived' }],
    ['folder_id zero', { folder_id: 0 }],
    ['an unknown key', { limit: 5 }],
  ])('rejects %s', async (_label, args) => {
    expect(isSchemaRejection(await harness!.call('list_notes', args))).toBe(true);
  });

  it('advertises every argument as optional, with page_size defaulted', async () => {
    const tool = (await harness!.listTools()).find((t) => t.name === 'list_notes');
    const schema = tool!.inputSchema as {
      properties?: Record<string, { default?: unknown }>;
      required?: string[];
      additionalProperties?: boolean;
    };

    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'cursor',
      'folder_id',
      'note_type',
      'page_size',
    ]);
    expect(schema.required ?? []).toEqual([]);
    expect(schema.properties?.page_size?.default).toBe(20);
    expect(schema.additionalProperties).toBe(false);
  });

  it('is advertised as a read-only, closed-world tool with a short description', async () => {
    const tool = (await harness!.listTools()).find((t) => t.name === 'list_notes');
    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});
