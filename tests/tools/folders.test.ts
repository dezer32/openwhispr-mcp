import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderView } from '../../src/domain/projections.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';
import { DEFAULT_FOLDERS } from '../fixtures/folders.js';

interface ListResult {
  folders: FolderView[];
  count: number;
}

interface CreateResult {
  created: true;
  folder: FolderView;
  notice: string;
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

function domain500(message: string) {
  return { status: 500, json: { error: { code: 'internal_error', message } } };
}

beforeEach(async () => {
  bridge = await startFakeBridge({ state: { folders: [...DEFAULT_FOLDERS] } });
  harness = await startHarness({ bridgeConfigPath: bridge.configPath });
});

afterEach(async () => {
  await harness.close();
  await bridge.close();
});

describe('list_folders', () => {
  it('projects every folder and counts them', async () => {
    const result = await harness.callJson<ListResult>('list_folders');

    expect(result.count).toBe(3);
    expect(result.folders[0]).toEqual({
      id: 1,
      name: 'Personal',
      is_default: true, // SQLite stores 1; the projection makes it a boolean
      sort_order: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(result.folders.map((folder) => folder.name)).toEqual(['Personal', 'Meetings', 'Videos']);
  });

  it('never leaks the sync columns the bridge sends with SELECT *', async () => {
    const result = await harness.callJson<ListResult>('list_folders');

    for (const key of ['cloud_id', 'sync_status', 'account_id', 'space_id', 'left_team', 'deleted_at']) {
      expect(JSON.stringify(result)).not.toContain(key);
    }
  });

  it('answers with an empty list when the app has no folders', async () => {
    bridge.state.folders.length = 0;
    expect(await harness.callJson<ListResult>('list_folders')).toEqual({ folders: [], count: 0 });
  });

  it('fails loudly rather than reporting no folders when the bridge errors', async () => {
    bridge.on('GET', '/v1/folders/list', () => domain500('boom'));

    const result = await harness.call('list_folders');
    expect(result.isError).toBe(true);
    expect(toolError(result).kind).toBe('upstream_error');
  });

  it('takes no arguments and is advertised read-only', async () => {
    expect(isSchemaRejection(await harness.call('list_folders', { limit: 10 }))).toBe(true);

    const tool = (await harness.listTools()).find((t) => t.name === 'list_folders');
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('create_folder', () => {
  it('creates the folder and returns its projection', async () => {
    const result = await harness.callJson<CreateResult>('create_folder', { name: 'Trading' });

    expect(result.created).toBe(true);
    expect(result.folder).toMatchObject({ id: 4, name: 'Trading' });
    expect(bridge.state.folders.map((folder) => folder.name)).toContain('Trading');
  });

  it('trims the name before sending it', async () => {
    await harness.callJson<CreateResult>('create_folder', { name: '  Trading  ' });
    expect(bodyAt(0)).toEqual({ name: 'Trading' });
  });

  it('says that the bridge cannot rename or delete folders', async () => {
    const result = await harness.callJson<CreateResult>('create_folder', { name: 'Trading' });
    expect(result.notice).toMatch(/rename|delete/i);
  });

  it('turns a duplicate name into folder_name_conflict with the existing folders', async () => {
    bridge.on('POST', '/v1/folders/create', () => domain500('A folder with that name already exists'));

    const payload = toolError(await harness.call('create_folder', { name: 'Personal' }));

    expect(payload.kind).toBe('folder_name_conflict');
    expect(payload.details?.available_folders).toEqual([
      { id: 1, name: 'Personal' },
      { id: 2, name: 'Meetings' },
      { id: 3, name: 'Videos' },
    ]);
  });

  it('turns the app-side name check into invalid_argument, not a bare upstream_error', async () => {
    bridge.on('POST', '/v1/folders/create', () => domain500('Folder name is required'));

    const payload = toolError(await harness.call('create_folder', { name: 'Trading' }));
    expect(payload.kind).toBe('invalid_argument');
  });

  it('rejects a blank name locally, before any request goes out', async () => {
    expect(isSchemaRejection(await harness.call('create_folder', {}))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_folder', { name: '' }))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_folder', { name: '   ' }))).toBe(true);
    expect(isSchemaRejection(await harness.call('create_folder', { name: 'x', sort_order: 1 }))).toBe(true);
    expect(bridge.requests).toHaveLength(0);
  });

  it('is advertised as a non-destructive, non-idempotent write', async () => {
    const tool = (await harness.listTools()).find((t) => t.name === 'create_folder');

    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
