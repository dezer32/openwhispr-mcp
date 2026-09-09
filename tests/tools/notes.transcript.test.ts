import { afterEach, describe, expect, it } from 'vitest';

import { BridgeHttpError } from '../../src/bridge/errors.js';
import type { RawNote } from '../../src/bridge/types.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { BridgeRoutes, BridgeSession, ToolDeps } from '../../src/deps.js';
import { createTtlStore } from '../../src/domain/snapshotStore.js';
import type { SpeakerStat } from '../../src/domain/transcript.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { makeNote } from '../fixtures/notes.js';
import {
  BASE_EPOCH_MS,
  BROKEN_JSON_TRANSCRIPT,
  LEGACY_PLAIN_TRANSCRIPT,
  epochSecondSegments,
  jsonTranscript,
  makeSegment,
  relativeSegments,
  twoSpeakerSegments,
} from '../fixtures/transcripts.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { isSchemaRejection, resultText, startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';

interface SegmentView {
  index: number;
  t_rel: number | null;
  t_rel_next: number | null;
  speaker: string;
  speaker_name: string | null;
  speaker_is_placeholder: boolean;
  speaker_status: string | null;
  source: string | null;
  text: string;
}

interface TranscriptResult {
  note_id: number;
  note_title: string | null;
  note_updated_at: string | null;
  kind: 'json' | 'plain' | null;
  format: 'segments' | 'text' | 'speakers';
  time_unit: 'ms' | 's' | 'relative' | null;
  total_segments: number;
  speaker_names_note: string;
  warning?: string;
  notice?: string;
  time_note?: string;
  filtered_segments?: number;
  offset?: number;
  limit?: number;
  has_more?: boolean;
  next_offset?: number | null;
  segments?: SegmentView[];
  total_chunks?: number;
  chunks?: string[];
  text?: string;
  truncated?: boolean;
  max_chars?: number;
  merge_note?: string;
  merge_gap_seconds?: number;
  merge_max_chars?: number;
  speakers?: SpeakerStat[];
}

function fakeRoutes(getNote: (id: number) => Promise<RawNote>): BridgeRoutes {
  const missing = (): never => {
    throw new Error('unexpected route call');
  };
  return {
    health: missing,
    listNotes: missing,
    searchNotes: missing,
    getNote,
    createNote: missing,
    updateNote: missing,
    deleteNote: missing,
    listFolders: missing,
    createFolder: missing,
    listDictionary: missing,
    updateDictionary: missing,
    listTranscriptions: missing,
    getTranscription: missing,
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

function depsFor(getNote: (id: number) => Promise<RawNote>, overrides: Partial<Config> = {}): ToolDeps {
  const config: Config = { ...loadConfig({} as NodeJS.ProcessEnv), ...overrides };
  return {
    config,
    now: () => 0,
    snapshots: createTtlStore<unknown>({ ttlMs: 1000, maxEntries: 3, now: () => 0 }),
    withSession: async (_options, fn) => fn(fakeRoutes(getNote), fakeSession),
  };
}

/** A single note answered for any id. */
function depsForNote(note: RawNote): ToolDeps {
  return depsFor(async () => note);
}

function noteWith(transcript: string | null, overrides: Partial<RawNote> = {}): RawNote {
  return makeNote({ id: 7, title: 'Weekly sync', transcript, ...overrides });
}

let harness: Harness | undefined;
let bridge: FakeBridge | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
  bridge = undefined;
});

describe('get_note_transcript — schema', () => {
  async function open(): Promise<Harness> {
    harness = await startHarness({ deps: depsForNote(noteWith(null)) });
    return harness;
  }

  it('requires note_id and rejects unknown keys', async () => {
    const h = await open();
    expect(isSchemaRejection(await h.call('get_note_transcript', {}))).toBe(true);
    expect(isSchemaRejection(await h.call('get_note_transcript', { note_id: 7, verbose: true }))).toBe(true);
  });

  it('rejects a note_id that is not a positive integer', async () => {
    const h = await open();
    for (const note_id of [0, -1, 1.5, '7']) {
      expect(isSchemaRejection(await h.call('get_note_transcript', { note_id }))).toBe(true);
    }
  });

  it('keeps limit inside 1..200 and offset non-negative', async () => {
    const h = await open();
    expect(isSchemaRejection(await h.call('get_note_transcript', { note_id: 7, limit: 0 }))).toBe(true);
    expect(isSchemaRejection(await h.call('get_note_transcript', { note_id: 7, limit: 201 }))).toBe(true);
    expect(isSchemaRejection(await h.call('get_note_transcript', { note_id: 7, offset: -1 }))).toBe(true);
  });

  it('rejects an unknown format', async () => {
    const h = await open();
    expect(isSchemaRejection(await h.call('get_note_transcript', { note_id: 7, format: 'srt' }))).toBe(true);
  });

  it('explains that paging and filters are meaningless for format:speakers', async () => {
    const h = await open();
    for (const extra of [{ offset: 0 }, { limit: 10 }, { speaker: 'you' }, { source: 'mic' }]) {
      const result = await h.call('get_note_transcript', { note_id: 7, format: 'speakers', ...extra });
      expect(isSchemaRejection(result)).toBe(true);
      expect(resultText(result)).toMatch(/speakers/i);
    }
  });

  it('rejects paging for format:text rather than silently ignoring it', async () => {
    const h = await open();
    for (const extra of [{ offset: 5 }, { limit: 10 }]) {
      const result = await h.call('get_note_transcript', { note_id: 7, format: 'text', ...extra });
      expect(isSchemaRejection(result)).toBe(true);
      expect(resultText(result)).toMatch(/format/i);
    }
  });

  it('still allows speaker and source filters for format:text', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(4)))) });
    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'text',
      speaker: 'you',
    });
    expect(result.text).toBe(
      '[00:00] you: Line 1 with a few words in it. Line 3 with a few words in it.',
    );
    expect(result.filtered_segments).toBe(2);
    expect(result.total_segments).toBe(4);
    // Merged lines would otherwise read as one uninterrupted stretch of speech.
    expect(result.notice).toMatch(/not necessarily consecutive/i);
  });
});

describe('get_note_transcript — JSON segments', () => {
  it('returns numbered segments with a relative clock and the next segment time', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(3)))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', { note_id: 7 });

    expect(result.kind).toBe('json');
    expect(result.format).toBe('segments');
    expect(result.time_unit).toBe('ms');
    expect(result.total_segments).toBe(3);
    expect(result.filtered_segments).toBe(3);
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeNull();
    expect(result.segments).toHaveLength(3);
    expect(result.segments![0]).toEqual({
      index: 0,
      t_rel: 0,
      t_rel_next: 5,
      speaker: 'you',
      speaker_name: 'You',
      speaker_is_placeholder: true,
      speaker_status: 'provisional',
      source: 'mic',
      text: 'Line 1 with a few words in it.',
    });
    // No `end` exists upstream, so the last segment must not get a made-up one.
    expect(result.segments![2]!.t_rel_next).toBeNull();
  });

  it('always reports note_updated_at as UTC ISO', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(null)) });
    const result = await harness.callJson<TranscriptResult>('get_note_transcript', { note_id: 7 });
    expect(result.note_updated_at).toBe('2026-09-08T08:31:48Z');
    expect(result.note_id).toBe(7);
    expect(result.note_title).toBe('Weekly sync');
  });

  it('pages through segments and reports where the next page starts', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(10)))) });

    const page = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      offset: 0,
      limit: 4,
    });

    expect(page.total_segments).toBe(10);
    expect(page.segments!.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(4);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(4);
  });

  it('keeps the clock absolute on later pages — minTs is taken over every segment', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(10)))) });

    const page = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      offset: 5,
      limit: 5,
    });

    // A per-page minimum would restart this page at 0 and silently rewrite the recording.
    expect(page.segments![0]!.t_rel).toBe(25);
    expect(page.segments!.at(-1)!.t_rel).toBe(45);
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeNull();
  });

  it('filters by speaker before paging but keeps timings from the unfiltered list', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(6)))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      speaker: 'speaker_0',
    });

    expect(result.total_segments).toBe(6);
    expect(result.filtered_segments).toBe(3);
    expect(result.segments!.map((s) => s.index)).toEqual([1, 3, 5]);
    expect(result.segments!.map((s) => s.t_rel)).toEqual([5, 15, 25]);
    // t_rel_next follows the full transcript, so it is a real observed time.
    expect(result.segments!.map((s) => s.t_rel_next)).toEqual([10, 20, null]);
  });

  it('filters by source', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(6)))) });
    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      source: 'system',
    });
    expect(result.filtered_segments).toBe(3);
    expect(result.segments!.every((s) => s.source === 'system')).toBe(true);
  });

  it('returns an empty page instead of an error when a filter matches nothing', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(4)))) });
    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      speaker: 'nobody',
    });
    expect(result.filtered_segments).toBe(0);
    expect(result.segments).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it('does not divide an epoch-seconds transcript by 1000 the way the app does', async () => {
    harness = await startHarness({
      deps: depsForNote(noteWith(jsonTranscript(epochSecondSegments(4, 5)))),
    });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', { note_id: 7 });

    expect(result.time_unit).toBe('s');
    expect(result.segments!.map((s) => s.t_rel)).toEqual([0, 5, 10, 15]);
    expect(result.time_note).toMatch(/epoch seconds/i);
  });

  it('reports "no timestamps at all" as time_unit null, not as relative time', async () => {
    const untimed = Array.from({ length: 3 }, (_, i) =>
      makeSegment({ text: `Line ${i + 1}.`, timestamp: null }),
    );
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(untimed))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', { note_id: 7 });

    // Claiming relative times while every t_rel is null reads as a broken server.
    expect(result.time_unit).toBeNull();
    expect(result.time_note).toMatch(/not one segment .* carries a timestamp/i);
    expect(result.time_note).not.toMatch(/already relative/i);
    expect(result.segments!.map((s) => s.t_rel)).toEqual([null, null, null]);
    expect(result.segments!.map((s) => s.t_rel_next)).toEqual([null, null, null]);
  });

  it('keeps time_unit relative when the timestamps really are relative', async () => {
    harness = await startHarness({
      deps: depsForNote(noteWith(jsonTranscript(relativeSegments(3, 4)))),
    });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', { note_id: 7 });

    expect(result.time_unit).toBe('relative');
    expect(result.time_note).toMatch(/already relative/i);
    expect(result.segments!.map((s) => s.t_rel)).toEqual([0, 4, 8]);
  });

  it('warns that speaker labels are not real names', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(2)))) });
    for (const format of ['segments', 'text', 'speakers']) {
      const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
        note_id: 7,
        format,
      });
      expect(result.speaker_names_note).toMatch(/speaker_mappings/);
    }
  });
});

describe('get_note_transcript — text and speakers', () => {
  it('renders text as [mm:ss] speaker: line', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(3)))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'text',
    });

    expect(result.truncated).toBe(false);
    expect(result.max_chars).toBe(20_000);
    expect(result.text!.split('\n')).toEqual([
      '[00:00] you: Line 1 with a few words in it.',
      '[00:05] speaker_0: Line 2 with a few words in it.',
      '[00:10] you: Line 3 with a few words in it.',
    ]);
    expect(result.segments).toBeUndefined();
  });

  it('folds a run of segments from one speaker into a single line', async () => {
    const run = [
      makeSegment({ text: 'First half,', timestamp: BASE_EPOCH_MS, speaker: 'you' }),
      makeSegment({ text: 'second half.', timestamp: BASE_EPOCH_MS + 1_500, speaker: 'you' }),
      makeSegment({ text: 'Reply.', timestamp: BASE_EPOCH_MS + 90_000, speaker: 'you' }),
    ];
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(run))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'text',
    });

    // A 90-second silence is a new turn, not a continuation of the same one.
    expect(result.text!.split('\n')).toEqual([
      '[00:00] you: First half, second half.',
      '[01:30] you: Reply.',
    ]);
  });

  it('publishes the thresholds that decide where a line breaks', async () => {
    // A caller counting rendered lines is counting an artifact of these three
    // rules, so the rules have to travel with the text.
    const run = [
      makeSegment({ text: 'Mic side.', timestamp: BASE_EPOCH_MS, speaker: 'you', source: 'mic' }),
      makeSegment({
        text: 'System side.',
        timestamp: BASE_EPOCH_MS + 1_000,
        speaker: 'you',
        source: 'system',
      }),
    ];
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(run))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'text',
    });

    expect(result.merge_gap_seconds).toBe(30);
    expect(result.merge_max_chars).toBe(2000);
    expect(result.merge_note).toMatch(/not diarization turns/i);
    expect(result.merge_note).toMatch(/source \(mic\/system\)/);
    expect(result.merge_note).toMatch(/merge_gap_seconds/);
    expect(result.merge_note).toMatch(/merge_max_chars/);
    // The same speaker one second apart, split only because `source` changed —
    // exactly the behaviour the note has to account for.
    expect(result.text!.split('\n')).toHaveLength(2);
  });

  it('leaves the merge fields out of the formats that do no merging', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(3)))) });

    for (const format of ['segments', 'speakers']) {
      const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
        note_id: 7,
        format,
      });
      expect(result.merge_note, format).toBeUndefined();
      expect(result.merge_gap_seconds, format).toBeUndefined();
    }
  });

  it('caps rendered text at 20 000 characters and says it was cut', async () => {
    const many = Array.from({ length: 1200 }, (_, i) =>
      makeSegment({
        text: `Segment ${i} carries a sentence long enough to matter for the cap.`,
        timestamp: BASE_EPOCH_MS + i * 4_000,
        speaker: i % 2 === 0 ? 'you' : 'speaker_0',
      }),
    );
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(many))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'text',
    });

    expect(result.truncated).toBe(true);
    expect(result.text!.length).toBeLessThanOrEqual(20_000);
    expect(result.total_segments).toBe(1200);
  });

  it('answers format:speakers with per-speaker totals and no paging fields', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(6)))) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'speakers',
    });

    expect(result.speakers).toEqual([
      { speaker: 'you', segments: 3, words: 24, first_t_rel: 0, last_t_rel: 20, share_pct: 50 },
      { speaker: 'speaker_0', segments: 3, words: 24, first_t_rel: 5, last_t_rel: 25, share_pct: 50 },
    ]);
    expect(result.total_segments).toBe(6);
    expect(result.offset).toBeUndefined();
    expect(result.limit).toBeUndefined();
    expect(result.has_more).toBeUndefined();
  });
});

describe('get_note_transcript — expect_updated_at', () => {
  it('serves the page when the note has not moved', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(4)))) });
    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      expect_updated_at: '2026-09-08T08:31:48Z',
    });
    expect(result.segments).toHaveLength(4);
  });

  it('refuses to page a transcript that changed under the caller', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(4)))) });

    const result = await harness.call('get_note_transcript', {
      note_id: 7,
      offset: 2,
      expect_updated_at: '2026-09-01T00:00:00Z',
    });

    expect(result.isError).toBe(true);
    const payload = toolError(result);
    expect(payload.kind).toBe('transcript_changed');
    expect(payload.message).toMatch(/offset 0/);
    expect(payload.details).toMatchObject({ note_updated_at: '2026-09-08T08:31:48Z' });
  });

  it('accepts the raw SQLite spelling of the same instant', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(twoSpeakerSegments(2)))) });
    const result = await harness.call('get_note_transcript', {
      note_id: 7,
      expect_updated_at: '2026-09-08 08:31:48',
    });
    expect(result.isError).toBeFalsy();
  });
});

describe('get_note_transcript — plain, broken and missing transcripts', () => {
  it('serves legacy flat text as paginated chunks with no segments', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(LEGACY_PLAIN_TRANSCRIPT)) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', { note_id: 7 });

    expect(result.kind).toBe('plain');
    expect(result.segments).toEqual([]);
    expect(result.total_segments).toBe(0);
    expect(result.time_unit).toBeNull();
    expect(result.total_chunks).toBe(1);
    expect(result.chunks).toEqual([LEGACY_PLAIN_TRANSCRIPT]);
    expect(result.has_more).toBe(false);
    expect(result.notice).toMatch(/no speaker/i);
  });

  it('pages plain chunks', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(80).trim()}`).join(
      '\n\n',
    );
    harness = await startHarness({ deps: depsForNote(noteWith(long)) });

    const first = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      limit: 2,
    });

    expect(first.total_chunks).toBeGreaterThan(2);
    expect(first.chunks).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(2);
  });

  it('renders plain text for format:text', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(LEGACY_PLAIN_TRANSCRIPT)) });
    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'text',
    });
    expect(result.text).toBe(LEGACY_PLAIN_TRANSCRIPT);
    expect(result.truncated).toBe(false);
  });

  it('has no speakers to report for flat text', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(LEGACY_PLAIN_TRANSCRIPT)) });
    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 7,
      format: 'speakers',
    });
    expect(result.speakers).toEqual([]);
    expect(result.notice).toMatch(/no speaker/i);
  });

  it('degrades a truncated JSON write to text and warns about it', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(BROKEN_JSON_TRANSCRIPT)) });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', { note_id: 7 });

    expect(result.kind).toBe('plain');
    expect(result.warning).toMatch(/json/i);
    expect(result.chunks!.join('')).toContain('truncated mid-write');
  });

  it('reports a note with no transcript as empty, not as an error', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(null)) });

    const result = await harness.call('get_note_transcript', { note_id: 7 });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(resultText(result)) as TranscriptResult;
    expect(payload.kind).toBeNull();
    expect(payload.segments).toEqual([]);
    expect(payload.total_segments).toBe(0);
    expect(payload.notice).toMatch(/no transcript/i);
  });

  it('never puts prose under a bare note key, next to note_id and note_title', async () => {
    // Every other tool reserves `note` for the note object; a string there would
    // read as "the note" to a client typed against the other fourteen.
    const cases: Array<[string, string | null]> = [
      ['no transcript', null],
      ['legacy plain text', LEGACY_PLAIN_TRANSCRIPT],
      ['filtered json', jsonTranscript(twoSpeakerSegments())],
    ];

    for (const [label, transcript] of cases) {
      harness = await startHarness({ deps: depsForNote(noteWith(transcript)) });
      const payload = await harness.callJson<Record<string, unknown>>('get_note_transcript', {
        note_id: 7,
        format: 'text',
        ...(transcript === null ? {} : { speaker: 'you' }),
      });
      expect(Object.keys(payload), label).not.toContain('note');
      expect(typeof payload.notice, label).toBe('string');
      await harness.close();
      harness = undefined;
    }
  });
});

describe('get_note_transcript — failures and advertisement', () => {
  it('turns a 404 into an actionable not_found', async () => {
    harness = await startHarness({
      deps: depsFor(async () => {
        throw new BridgeHttpError({ status: 404, upstreamCode: 'not_found', upstreamMessage: 'Not found' });
      }),
    });

    const payload = toolError(await harness.call('get_note_transcript', { note_id: 999 }));
    expect(payload.kind).toBe('not_found');
    expect(payload.hint).toMatch(/list_notes|search_notes/);
  });

  it('caps its own result size rather than returning megabytes of JSON', async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      makeSegment({ text: 'x'.repeat(4_000), timestamp: BASE_EPOCH_MS + i * 1_000 }),
    );
    harness = await startHarness({ deps: depsForNote(noteWith(jsonTranscript(many))) });

    const payload = toolError(
      await harness.call('get_note_transcript', { note_id: 7, limit: 200 }),
    );
    expect(payload.kind).toBe('response_too_large');
  });

  it('is advertised as a read-only, closed-world tool with a short description', async () => {
    harness = await startHarness({ deps: depsForNote(noteWith(null)) });
    const tool = (await harness.listTools()).find((t) => t.name === 'get_note_transcript');

    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.description!.length).toBeGreaterThan(40);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});

describe('get_note_transcript — over the real HTTP path', () => {
  it('reads a 202-segment transcript through the bridge', async () => {
    bridge = await startFakeBridge({
      state: {
        notes: [makeNote({ id: 42, transcript: jsonTranscript(twoSpeakerSegments(202)) })],
        folders: [],
        transcriptions: [],
        dictionary: [],
        health: { status: 'ok' },
      },
    });
    harness = await startHarness({ bridgeConfigPath: bridge.configPath });

    const result = await harness.callJson<TranscriptResult>('get_note_transcript', {
      note_id: 42,
      offset: 200,
      limit: 5,
    });

    expect(result.total_segments).toBe(202);
    expect(result.segments).toHaveLength(2);
    expect(result.segments![0]!.t_rel).toBe(1000);
    expect(result.has_more).toBe(false);
  });
});
