import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolDeps } from '../../src/deps.js';
import type { UsageReport } from '../../src/domain/usage.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, makeDeps, startHarness, type Harness } from '../helpers/mcpHarness.js';
import { DICTIONARY_AS_STRINGS } from '../fixtures/dictionary.js';
import { DEFAULT_FOLDERS } from '../fixtures/folders.js';
import { makeNote, resetNoteIds } from '../fixtures/notes.js';
import { makeTranscription } from '../fixtures/transcriptions.js';
import { jsonTranscript, makeSegment } from '../fixtures/transcripts.js';

/** 2026-09-01T00:30:00Z — half an hour into a new month in UTC, still August in the Americas. */
const NOW = Date.UTC(2026, 8, 1, 0, 30, 0);

let bridge: FakeBridge;
let harness: Harness;
let sessions: number;

async function boot(now: number = NOW): Promise<void> {
  const base = makeDeps({ bridgeConfigPath: bridge.configPath, now: () => now });
  sessions = 0;
  const deps: ToolDeps = {
    ...base,
    withSession: (options, fn) => {
      sessions += 1;
      return base.withSession(options, fn);
    },
  };
  harness = await startHarness({ deps });
}

function paths(): string[] {
  return bridge.requests.map((request) => request.path).sort();
}

beforeEach(async () => {
  resetNoteIds(1);
  bridge = await startFakeBridge({
    state: {
      folders: [...DEFAULT_FOLDERS],
      dictionary: [...DICTIONARY_AS_STRINGS],
      notes: [
        makeNote({ id: 1, note_type: 'personal', folder_id: 1, created_at: '2026-08-31 23:30:00' }),
        makeNote({
          id: 2,
          note_type: 'meeting',
          folder_id: 2,
          created_at: '2026-09-01 00:10:00',
          audio_duration_seconds: 90,
          transcript: jsonTranscript([makeSegment({ text: 'one two' }), makeSegment({ text: 'three' })]),
        }),
      ],
      transcriptions: [
        makeTranscription({ id: 1, timestamp: '2026-09-01 00:20:00', audio_duration_ms: 4200 }),
      ],
    },
  });
  await boot();
});

afterEach(async () => {
  await harness.close();
  await bridge.close();
});

describe('get_usage', () => {
  it('reads folders, notes, transcriptions and the dictionary in one session', async () => {
    await harness.callJson<UsageReport>('get_usage');

    expect(sessions).toBe(1);
    expect(bridge.requests).toHaveLength(4);
    expect(paths()).toEqual([
      '/v1/dictionary/list',
      '/v1/folders/list',
      '/v1/notes/list',
      '/v1/transcriptions/list',
    ]);
    // One session means one pinned {port, token}: counters cannot be stitched
    // together from two app instances.
    expect(new Set(bridge.requests.map((request) => request.port)).size).toBe(1);
    expect(new Set(bridge.requests.map((request) => request.authorization)).size).toBe(1);
  });

  it('asks for 100 notes and 200 transcriptions by default', async () => {
    await harness.callJson<UsageReport>('get_usage');

    const notes = bridge.requests.find((request) => request.path === '/v1/notes/list')!;
    const transcriptions = bridge.requests.find((r) => r.path === '/v1/transcriptions/list')!;

    expect(notes.query).toEqual({ limit: '100' });
    expect(transcriptions.query).toEqual({ limit: '200' });
  });

  it('splits notes by type locally instead of asking the bridge per type', async () => {
    const result = await harness.callJson<UsageReport>('get_usage');

    expect(result.notes_by_type).toEqual({ personal: 1, meeting: 1 });
    expect(bridge.requests.filter((request) => request.path === '/v1/notes/list')).toHaveLength(1);
  });

  it('forwards the limits it was given and flags a saturated count', async () => {
    const result = await harness.callJson<UsageReport>('get_usage', {
      notes_limit: 2,
      transcriptions_limit: 5,
    });

    const notes = bridge.requests.find((request) => request.path === '/v1/notes/list')!;
    expect(notes.query).toEqual({ limit: '2' });
    expect(result.counts.notes).toEqual({ value: 2, exact: false });
    expect(result.counts.transcriptions).toEqual({ value: 1, exact: true });
    expect(result.limits).toEqual({ notes: 2, transcriptions: 5 });
  });

  it('leaves transcripts unparsed unless asked', async () => {
    const off = await harness.callJson<UsageReport>('get_usage');
    expect(off.transcripts).toMatchObject({ notes_with_transcript: 1, parsed: false, json: null });
    expect(off.words.note_transcript).toBeNull();

    const on = await harness.callJson<UsageReport>('get_usage', { include_transcript_stats: true });
    expect(on.transcripts).toMatchObject({ parsed: true, json: 1, plain: 0, total_segments: 2 });
    expect(on.words.note_transcript).toBe(3);
  });

  it('buckets periods with the injected clock, in UTC', async () => {
    const result = await harness.callJson<UsageReport>('get_usage');

    expect(result.generated_at).toBe('2026-09-01T00:30:00Z');
    expect(result.periods.timezone).toBe('UTC');
    // The note from 2026-08-31 23:30Z belongs to August even though half the
    // world was already in September, and vice versa.
    expect(result.periods.by_month).toEqual({
      '2026-09': { notes: 1, transcriptions: 1 },
      '2026-08': { notes: 1, transcriptions: 0 },
    });
    expect(result.periods.last_7_days).toEqual({ notes: 2, transcriptions: 1 });
  });

  it('reports audio separately for notes and transcriptions', async () => {
    const result = await harness.callJson<UsageReport>('get_usage');

    expect(result.audio).toEqual({
      notes_seconds: 90,
      notes_with_duration: 1,
      transcriptions_ms: 4200,
      transcriptions_with_duration: 1,
    });
  });

  it('counts dictionary words without repeating them', async () => {
    const result = await harness.callJson<UsageReport>('get_usage');

    expect(result.dictionary).toEqual({
      word_count: 3,
      raw_shape: 'strings',
      unrecognized_entries: 0,
    });
    expect(JSON.stringify(result)).not.toContain('MetaTrader');
  });

  it('agrees with list_dictionary about entries neither tool could read', async () => {
    bridge.state.dictionary = [...DICTIONARY_AS_STRINGS, { spelling: 'Qdrant' }, 42];

    const usage = await harness.callJson<UsageReport>('get_usage');
    const listed = await harness.callJson<{ count: number; warning?: string }>('list_dictionary');

    expect(listed.warning).toMatch(/skipped/i);
    expect(usage.dictionary.unrecognized_entries).toBe(2);
    expect(usage.counts.dictionary_words).toEqual({ value: listed.count, exact: false });
  });

  it('says the subscription plan cannot be read locally, and lists what else is missing', async () => {
    const result = await harness.callJson<UsageReport>('get_usage');

    expect(result.plan.available).toBe(false);
    expect(result.plan.reason).toMatch(/cloud/i);
    expect(result.limitations.length).toBeGreaterThanOrEqual(5);
    expect(result.limitations.join('\n')).toMatch(/not a consistent snapshot/i);
  });

  it('rejects limits outside the range the bridge can serve', async () => {
    for (const args of [
      { notes_limit: 0 },
      { notes_limit: 501 },
      { notes_limit: 10.5 },
      { transcriptions_limit: 0 },
      { transcriptions_limit: 1001 },
      { include_transcript_stats: 'yes' },
      { limit: 10 },
    ]) {
      expect(isSchemaRejection(await harness.call('get_usage', args))).toBe(true);
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it('is advertised as a read-only tool with a short description', async () => {
    const tool = (await harness.listTools()).find((t) => t.name === 'get_usage');

    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});
