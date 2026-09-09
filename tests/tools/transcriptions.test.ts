import { afterEach, describe, expect, it } from 'vitest';

import { BridgeHttpError } from '../../src/bridge/errors.js';
import type { RawTranscription } from '../../src/bridge/types.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { BridgeRoutes, BridgeSession, ToolDeps, TranscriptionsListParams } from '../../src/deps.js';
import { createTtlStore } from '../../src/domain/snapshotStore.js';
import type { TranscriptionView } from '../../src/domain/projections.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { makeTranscription } from '../fixtures/transcriptions.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';

interface ListResult {
  transcriptions: TranscriptionView[];
  limit: number;
  fetched: number;
  returned: number;
  complete: boolean;
  status_filter: string | null;
  notice: string;
  limitations: string[];
}

interface GetResult {
  transcription: TranscriptionView;
  notice: string;
}

interface RouteStubs {
  listTranscriptions?: (params?: TranscriptionsListParams) => Promise<RawTranscription[]>;
  getTranscription?: (id: number) => Promise<RawTranscription>;
}

function fakeRoutes(stubs: RouteStubs): BridgeRoutes {
  const missing = (): never => {
    throw new Error('unexpected route call');
  };
  return {
    health: missing,
    listNotes: missing,
    searchNotes: missing,
    getNote: missing,
    createNote: missing,
    updateNote: missing,
    deleteNote: missing,
    listFolders: missing,
    createFolder: missing,
    listDictionary: missing,
    updateDictionary: missing,
    listTranscriptions: stubs.listTranscriptions ?? missing,
    getTranscription: stubs.getTranscription ?? missing,
  } as BridgeRoutes;
}

const fakeSession: BridgeSession = {
  host: '127.0.0.1',
  port: 8200,
  attempt: 1,
  signal: new AbortController().signal,
  mutationCommitted: false,
  request: async () => {
    throw new Error('unexpected raw request');
  },
};

function depsFor(stubs: RouteStubs): ToolDeps {
  const config: Config = { ...loadConfig({} as NodeJS.ProcessEnv) };
  return {
    config,
    now: () => 0,
    snapshots: createTtlStore<unknown>({ ttlMs: 1000, maxEntries: 3, now: () => 0 }),
    withSession: async (_options, fn) => fn(fakeRoutes(stubs), fakeSession),
  };
}

/** Records the params the tool sent upstream. */
function listingDeps(rows: RawTranscription[]): { deps: ToolDeps; calls: TranscriptionsListParams[] } {
  const calls: TranscriptionsListParams[] = [];
  const deps = depsFor({
    listTranscriptions: async (params = {}) => {
      calls.push(params);
      return rows.slice(0, params.limit ?? rows.length);
    },
  });
  return { deps, calls };
}

let harness: Harness | undefined;
let bridge: FakeBridge | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
  bridge = undefined;
});

describe('list_transcriptions', () => {
  it('asks the bridge for 50 rows by default', async () => {
    const { deps, calls } = listingDeps([makeTranscription({ id: 1 })]);
    harness = await startHarness({ deps });

    const result = await harness.callJson<ListResult>('list_transcriptions');

    expect(calls).toEqual([{ limit: 50 }]);
    expect(result.limit).toBe(50);
    expect(result.transcriptions).toHaveLength(1);
    expect(result.status_filter).toBeNull();
  });

  it('projects rows and never leaks the sync columns', async () => {
    const { deps } = listingDeps([makeTranscription({ id: 3, text: 'Two words' })]);
    harness = await startHarness({ deps });

    const [row] = (await harness.callJson<ListResult>('list_transcriptions')).transcriptions;

    expect(row).toMatchObject({
      id: 3,
      text: 'Two words',
      timestamp: '2026-09-07T12:00:00Z',
      has_audio: true,
      audio_duration_ms: 4200,
      provider: 'local',
      status: 'completed',
      word_count: 2,
    });
    for (const key of ['raw_text', 'cloud_id', 'sync_status', 'deleted_at', 'client_transcription_id']) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it('passes an explicit limit through and reports the result as incomplete when it filled up', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeTranscription({ id: i + 1 }));
    const { deps, calls } = listingDeps(rows);
    harness = await startHarness({ deps });

    const full = await harness.callJson<ListResult>('list_transcriptions', { limit: 3 });

    expect(calls).toEqual([{ limit: 3 }]);
    expect(full.fetched).toBe(3);
    // Exactly `limit` rows came back, so there is no way to tell whether more exist.
    expect(full.complete).toBe(false);
  });

  it('reports the result as complete when the bridge returned fewer rows than asked', async () => {
    const { deps } = listingDeps([makeTranscription({ id: 1 }), makeTranscription({ id: 2 })]);
    harness = await startHarness({ deps });

    const result = await harness.callJson<ListResult>('list_transcriptions', { limit: 10 });
    expect(result.complete).toBe(true);
  });

  it('filters by status locally and says the window was already cut by limit', async () => {
    const rows = [
      makeTranscription({ id: 1, status: 'completed' }),
      makeTranscription({ id: 2, status: 'failed', error_message: 'no network' }),
      makeTranscription({ id: 3, status: 'completed' }),
    ];
    const { deps, calls } = listingDeps(rows);
    harness = await startHarness({ deps });

    const result = await harness.callJson<ListResult>('list_transcriptions', {
      limit: 3,
      status: 'failed',
    });

    // The bridge has no status parameter, so the limit still applies to all statuses.
    expect(calls).toEqual([{ limit: 3 }]);
    expect(result.transcriptions.map((t) => t.id)).toEqual([2]);
    expect(result.fetched).toBe(3);
    expect(result.returned).toBe(1);
    expect(result.status_filter).toBe('failed');
    expect(result.limitations.join(' ')).toMatch(/locally/i);
  });

  it('says an empty result is not proof that nothing was dictated', async () => {
    const { deps } = listingDeps([]);
    harness = await startHarness({ deps });

    const result = await harness.callJson<ListResult>('list_transcriptions');

    expect(result.transcriptions).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.limitations.join(' ')).toMatch(/discarded/);
    expect(result.limitations.join(' ')).toMatch(/soft-deleted/i);
  });

  it('states that dictations are not linked to notes', async () => {
    const { deps } = listingDeps([makeTranscription({ id: 1 })]);
    harness = await startHarness({ deps });

    const result = await harness.callJson<ListResult>('list_transcriptions');

    expect(result.notice).toMatch(/no link to notes/i);
    expect(result.notice).toMatch(/get_note_transcript/);
  });

  it('rejects unknown keys, an out-of-range limit and an unknown status', async () => {
    const { deps } = listingDeps([]);
    harness = await startHarness({ deps });

    expect(isSchemaRejection(await harness.call('list_transcriptions', { note_id: 1 }))).toBe(true);
    expect(isSchemaRejection(await harness.call('list_transcriptions', { limit: 0 }))).toBe(true);
    expect(isSchemaRejection(await harness.call('list_transcriptions', { limit: 501 }))).toBe(true);
    expect(isSchemaRejection(await harness.call('list_transcriptions', { status: 'discarded' }))).toBe(true);
  });

  it('is advertised as a read-only, closed-world tool with a short description', async () => {
    const { deps } = listingDeps([]);
    harness = await startHarness({ deps });
    const tool = (await harness.listTools()).find((t) => t.name === 'list_transcriptions');

    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.description!.length).toBeGreaterThan(40);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('get_transcription', () => {
  it('returns one projected dictation with the same no-link warning', async () => {
    harness = await startHarness({
      deps: depsFor({
        getTranscription: async (id) => makeTranscription({ id, text: 'Remember the milk' }),
      }),
    });

    const result = await harness.callJson<GetResult>('get_transcription', { transcription_id: 12 });

    expect(result.transcription.id).toBe(12);
    expect(result.transcription.text).toBe('Remember the milk');
    expect(result.transcription.word_count).toBe(3);
    expect(result.notice).toMatch(/no link to notes/i);
  });

  it('explains that a missing dictation may be discarded or soft-deleted', async () => {
    harness = await startHarness({
      deps: depsFor({
        getTranscription: async () => {
          throw new BridgeHttpError({ status: 404, upstreamCode: 'not_found', upstreamMessage: 'Not found' });
        },
      }),
    });

    const payload = toolError(await harness.call('get_transcription', { transcription_id: 99 }));

    expect(payload.kind).toBe('not_found');
    expect(payload.hint).toMatch(/discarded/);
    expect(payload.hint).toMatch(/deleted/i);
  });

  it('requires a positive integer id and rejects unknown keys', async () => {
    harness = await startHarness({ deps: depsFor({ getTranscription: async () => makeTranscription() }) });

    expect(isSchemaRejection(await harness.call('get_transcription', {}))).toBe(true);
    expect(isSchemaRejection(await harness.call('get_transcription', { transcription_id: 0 }))).toBe(true);
    expect(isSchemaRejection(await harness.call('get_transcription', { transcription_id: 1.5 }))).toBe(true);
    expect(
      isSchemaRejection(await harness.call('get_transcription', { transcription_id: 1, limit: 2 })),
    ).toBe(true);
  });

  it('is advertised as a read-only, closed-world tool with a short description', async () => {
    harness = await startHarness({ deps: depsFor({ getTranscription: async () => makeTranscription() }) });
    const tool = (await harness.listTools()).find((t) => t.name === 'get_transcription');

    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.description!.length).toBeGreaterThan(40);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('transcriptions — over the real HTTP path', () => {
  it('lists and reads dictations through the bridge', async () => {
    bridge = await startFakeBridge({
      state: {
        transcriptions: [
          makeTranscription({ id: 1, text: 'First dictation' }),
          makeTranscription({ id: 2, text: 'Second dictation', status: 'failed' }),
        ],
      },
    });
    harness = await startHarness({ bridgeConfigPath: bridge.configPath });

    const list = await harness.callJson<ListResult>('list_transcriptions', { limit: 10 });
    expect(list.transcriptions.map((t) => t.id)).toEqual([1, 2]);
    expect(list.complete).toBe(true);

    const one = await harness.callJson<GetResult>('get_transcription', { transcription_id: 2 });
    expect(one.transcription.text).toBe('Second dictation');
    expect(one.transcription.status).toBe('failed');

    // The two delete routes are deliberately not exposed.
    const names = (await harness.listTools()).map((t) => t.name);
    expect(names).not.toContain('delete_transcription');
  });
});
