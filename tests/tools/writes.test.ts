import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoteDetail } from '../../src/domain/projections.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';
import { DEFAULT_FOLDERS } from '../fixtures/folders.js';
import { makeNote, resetNoteIds } from '../fixtures/notes.js';

interface CreateResult {
  created: true;
  note: NoteDetail;
  notice?: string;
  folder_names_unavailable?: boolean;
  folder_names_note?: string;
}

interface UpdateResult {
  updated: true;
  note: NoteDetail;
  warning?: string;
  folder_names_unavailable?: boolean;
  folder_names_note?: string;
}

interface DeleteResult {
  deleted: true;
  note_id: number;
  notice: string;
}

let bridge: FakeBridge;
let harness: Harness;

/** `METHOD /path` for every call the bridge saw, in order. */
function trace(): string[] {
  return bridge.requests.map((request) => `${request.method} ${request.path}`);
}

/** Indexed access is checked, so a missing request must fail loudly, not as undefined. */
function requestAt(index: number) {
  const request = bridge.requests[index];
  if (!request) throw new Error(`the bridge saw no request at index ${index}`);
  return request;
}

function bodyAt(index: number): Record<string, unknown> {
  return JSON.parse(requestAt(index).body || '{}') as Record<string, unknown>;
}

function domain500(message: string) {
  return { status: 500, json: { error: { code: 'internal_error', message } } };
}

beforeEach(async () => {
  resetNoteIds(1);
  bridge = await startFakeBridge({ state: { folders: [...DEFAULT_FOLDERS] } });
  harness = await startHarness({ bridgeConfigPath: bridge.configPath });
});

afterEach(async () => {
  await harness.close();
  await bridge.close();
});

describe('create_note', () => {
  it('creates the note and answers with its projection', async () => {
    const result = await harness.callJson<CreateResult>('create_note', {
      title: 'Release checklist',
      content: 'ship it',
      folder_id: 3,
    });

    expect(result.created).toBe(true);
    expect(result.note).toMatchObject({
      title: 'Release checklist',
      content: 'ship it',
      note_type: 'personal',
      folder_id: 3,
      folder_name: 'Videos',
    });
    expect(bridge.state.notes[0]).toMatchObject({ title: 'Release checklist', folder_id: 3 });
  });

  it('never reads the folder list before the note is written', async () => {
    await harness.callJson<CreateResult>('create_note', { title: 'Ordering', folder_id: 1 });

    // Pre-validating folder_id would cost a request on the happy path and still
    // race the app, so the name is only resolved after the write.
    expect(trace()).toEqual(['POST /v1/notes/create', 'GET /v1/folders/list']);
  });

  it('defaults content to empty and note_type to personal', async () => {
    const result = await harness.callJson<CreateResult>('create_note', { title: 'Bare' });

    expect(requestAt(0).body).toContain('"note_type":"personal"');
    expect(result.note).toMatchObject({ note_type: 'personal', content: '' });
  });

  it('warns in the payload — not the description — that a default folder is picked by name', async () => {
    const withoutFolder = await harness.callJson<CreateResult>('create_note', { title: 'No folder' });
    expect(withoutFolder.notice).toMatch(/name/i);
    expect(withoutFolder.notice).toMatch(/renamed/i);

    const withFolder = await harness.callJson<CreateResult>('create_note', {
      title: 'Filed',
      folder_id: 2,
    });
    expect(withFolder.notice).toBeUndefined();
  });

  it('passes meeting through so the app files it into its own default folder', async () => {
    await harness.callJson<CreateResult>('create_note', { title: 'Standup', note_type: 'meeting' });
    expect(requestAt(0).body).toContain('"note_type":"meeting"');
  });

  it('forwards source_file and audio_duration_seconds only when given', async () => {
    await harness.callJson<CreateResult>('create_note', {
      title: 'Imported',
      note_type: 'upload',
      source_file: '/tmp/talk.m4a',
      audio_duration_seconds: 61.5,
    });

    const body = bodyAt(0);
    expect(body).toMatchObject({ source_file: '/tmp/talk.m4a', audio_duration_seconds: 61.5 });

    bridge.requests.length = 0;
    await harness.callJson<CreateResult>('create_note', { title: 'Plain' });
    expect(Object.keys(bodyAt(0))).not.toContain('source_file');
  });

  it('turns the bridge 500 for an unknown folder into folder_not_found with the real folders', async () => {
    bridge.on('POST', '/v1/notes/create', () =>
      domain500('Folder not found in the active account scope'),
    );

    const result = await harness.call('create_note', { title: 'Lost', folder_id: 999 });
    const payload = toolError(result);

    expect(payload.kind).toBe('folder_not_found');
    expect(payload.details?.available_folders).toEqual([
      { id: 1, name: 'Personal' },
      { id: 2, name: 'Meetings' },
      { id: 3, name: 'Videos' },
    ]);
  });

  it('rejects a missing or empty title, and any field the bridge would ignore', async () => {
    expect(isSchemaRejection(await harness.call('create_note', {}))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_note', { title: '' }))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_note', { title: 'x', note_type: 'diary' }))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_note', { title: 'x', folder_id: 0 }))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_note', { title: 'x', folder_id: 1.5 }))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_note', { title: 'x', transcript: '[]' }))).toBe(true);
    expect(bridge.requests).toHaveLength(0);
  });

  it('flags a failed folder listing rather than reporting the new note as unfiled', async () => {
    bridge.on('GET', '/v1/folders/list', () => ({
      status: 500,
      json: { error: { code: 'internal_error', message: 'boom' } },
    }));

    const result = await harness.callJson<CreateResult>('create_note', {
      title: 'Filed',
      folder_id: 2,
    });

    expect(result.note.folder_id).toBe(2);
    expect(result.note.folder_name).toBeNull();
    expect(result.folder_names_unavailable).toBe(true);
    expect(result.folder_names_note).toMatch(/could not be read/i);
  });

  it('sends the agent to notice, the field the default-folder warning lands in', async () => {
    const tool = (await harness.listTools()).find((t) => t.name === 'create_note');
    expect(tool!.description).toMatch(/notice field/);
    expect(tool!.description).not.toMatch(/the note field/);

    const created = await harness.callJson<CreateResult>('create_note', { title: 'No folder' });
    expect(created.notice).toMatch(/default folder|looks up by name/i);
    // `note` is the stored note, never prose — that is what made the old wording wrong.
    expect(created.note).toMatchObject({ title: 'No folder' });
  });

  it('warns that a timed-out create may already have been written instead of advising a retry', async () => {
    const impatient = await startHarness({
      bridgeConfigPath: bridge.configPath,
      config: { timeoutMs: 150 },
    });
    bridge.fault('hang');
    try {
      const payload = toolError(await impatient.call('create_note', { title: 'Slow' }));
      expect(payload.kind).toBe('timeout');
      expect(payload.hint).toMatch(/may already have been applied/i);
      expect(payload.hint).toMatch(/do not repeat it blindly/i);
      expect(payload.hint).toMatch(/list_notes/);
    } finally {
      bridge.fault(null);
      await impatient.close();
    }
  });

  it('is advertised as a non-destructive, non-idempotent write', async () => {
    const tool = (await harness.listTools()).find((t) => t.name === 'create_note');
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});

describe('update_note', () => {
  beforeEach(() => {
    bridge.state.notes.push(
      makeNote({ id: 5, title: 'Before', content: 'old body', folder_id: 1 }),
      makeNote({ id: 6, title: 'Enhanced', content: 'raw body', enhanced_content: 'polished body' }),
    );
  });

  it('patches only the fields it was given and returns the stored note', async () => {
    const result = await harness.callJson<UpdateResult>('update_note', {
      note_id: 5,
      title: 'After',
    });

    expect(bodyAt(1)).toEqual({ title: 'After' });
    expect(result.note).toMatchObject({ id: 5, title: 'After', content: 'old body' });
    expect(result.warning).toBeUndefined();
  });

  it('reads the note before it writes, so a 401 replay cannot double-apply', async () => {
    await harness.callJson<UpdateResult>('update_note', { note_id: 5, content: 'new body' });

    expect(trace()).toEqual([
      'GET /v1/notes/5',
      'PATCH /v1/notes/5',
      'GET /v1/notes/5',
      'GET /v1/folders/list',
    ]);
  });

  it('warns that the existing enhancement is now stale when content changes', async () => {
    const result = await harness.callJson<UpdateResult>('update_note', {
      note_id: 6,
      content: 'rewritten body',
    });

    expect(result.warning).toMatch(/enhanced/i);
    expect(result.warning).toMatch(/stale|out of date|outdated/i);
  });

  it('stays quiet when content changes on a note with no enhancement', async () => {
    const result = await harness.callJson<UpdateResult>('update_note', {
      note_id: 5,
      content: 'new body',
    });
    expect(result.warning).toBeUndefined();
  });

  it('stays quiet when only the title or the folder moves', async () => {
    const result = await harness.callJson<UpdateResult>('update_note', { note_id: 6, title: 'Renamed' });
    expect(result.warning).toBeUndefined();
  });

  it('refuses a patch with nothing to write instead of letting the bridge fail', async () => {
    const result = await harness.call('update_note', { note_id: 5 });
    expect(isSchemaRejection(result)).toBe(true);
    expect(bridge.requests).toHaveLength(0);
  });

  it('does not accept note_type, transcript or enhanced_content', async () => {
    for (const patch of [
      { note_type: 'meeting' },
      { transcript: '[]' },
      { enhanced_content: 'rewritten' },
      { participants: '[]' },
      { diarization_enabled: 1 },
    ]) {
      expect(isSchemaRejection(await harness.call('update_note', { note_id: 5, ...patch }))).toBe(true);
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it('reports an unknown note as not_found without sending a patch', async () => {
    const payload = toolError(await harness.call('update_note', { note_id: 404, title: 'Ghost' }));

    expect(payload.kind).toBe('not_found');
    expect(trace()).toEqual(['GET /v1/notes/404']);
  });

  it('treats the silent {success:false} answer as a failed write', async () => {
    bridge.on('PATCH', /^\/v1\/notes\/\d+$/, () => ({
      status: 200,
      json: { data: { success: false } },
    }));

    const payload = toolError(await harness.call('update_note', { note_id: 5, title: 'Nope' }));
    expect(payload.kind).toBe('write_failed');
  });

  it('maps a move into a missing folder to folder_not_found', async () => {
    bridge.on('PATCH', /^\/v1\/notes\/\d+$/, () => domain500('Folder not found'));

    const payload = toolError(await harness.call('update_note', { note_id: 5, folder_id: 42 }));
    expect(payload.kind).toBe('folder_not_found');
    expect(payload.details?.available_folders).toHaveLength(3);
  });

  it('flags a failed folder listing rather than reporting the moved note as unfiled', async () => {
    bridge.on('GET', '/v1/folders/list', () => ({
      status: 500,
      json: { error: { code: 'internal_error', message: 'boom' } },
    }));

    const result = await harness.callJson<UpdateResult>('update_note', {
      note_id: 5,
      folder_id: 3,
    });

    expect(result.note.folder_id).toBe(3);
    expect(result.note.folder_name).toBeNull();
    expect(result.folder_names_unavailable).toBe(true);
    expect(result.folder_names_note).toMatch(/could not be read/i);
  });

  it('is advertised as an idempotent, non-destructive write', async () => {
    const tool = (await harness.listTools()).find((t) => t.name === 'update_note');
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.description).toMatch(/enhanc/i);
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
});

describe('delete_note', () => {
  beforeEach(() => {
    bridge.state.notes.push(makeNote({ id: 7, title: 'Doomed' }));
  });

  it('deletes the note', async () => {
    const result = await harness.callJson<DeleteResult>('delete_note', { note_id: 7 });

    expect(result).toMatchObject({ deleted: true, note_id: 7 });
    expect(bridge.state.notes).toHaveLength(0);
    expect(trace()).toEqual(['DELETE /v1/notes/7']);
  });

  it('succeeds on an id that never existed and never claims the note was there', async () => {
    const result = await harness.callJson<DeleteResult>('delete_note', { note_id: 4242 });

    expect(result).toMatchObject({ deleted: true, note_id: 4242 });
    expect(result.notice).toMatch(/204/);
    expect(result.notice).toMatch(/without confirming|does not confirm/i);
    // The bridge answers 204 either way, so the payload carries no field that
    // would let a caller conclude a row was actually there and is now gone.
    expect(Object.keys(result).sort()).toEqual(['deleted', 'note_id', 'notice']);
  });

  it('takes only a note id', async () => {
    expect(isSchemaRejection(await harness.call('delete_note', {}))).toBe(true);
    expect(isSchemaRejection(await harness.call('delete_note', { note_id: 7, force: true }))).toBe(true);
    expect(isSchemaRejection(await harness.call('delete_note', { note_id: -1 }))).toBe(true);
    expect(bridge.requests).toHaveLength(0);
  });

  it('is advertised as destructive and says there is no confirmation step', async () => {
    const tool = (await harness.listTools()).find((t) => t.name === 'delete_note');

    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.description).toMatch(/confirm/i);
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
});
