import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RawFolder, RawNote, RawTranscription } from '../../../src/bridge/types.js';
import { describeTranscript } from '../../../src/domain/projections.js';
import { buildUsageReport, normalizeDictionary, type UsageReport } from '../../../src/domain/usage.js';
import {
  DICTIONARY_AS_OBJECTS,
  DICTIONARY_AS_STRINGS,
  DICTIONARY_AS_WRAPPED,
} from '../../fixtures/dictionary.js';
import { DEFAULT_FOLDERS, makeFolder } from '../../fixtures/folders.js';
import { makeNote } from '../../fixtures/notes.js';
import { makeTranscription } from '../../fixtures/transcriptions.js';
import { BROKEN_JSON_TRANSCRIPT, jsonTranscript, makeSegment } from '../../fixtures/transcripts.js';

/** 2026-09-08T12:00:00Z — every expectation below is derived from this instant. */
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

const OPTIONS = {
  now: NOW,
  notesLimit: 100,
  transcriptionsLimit: 200,
  includeTranscriptStats: false,
};

function report(
  input: {
    notes?: RawNote[];
    folders?: RawFolder[];
    transcriptions?: RawTranscription[];
    dictionary?: unknown;
  },
  options: Partial<typeof OPTIONS> = {},
): UsageReport {
  return buildUsageReport(
    {
      notes: input.notes ?? [],
      folders: input.folders ?? [],
      transcriptions: input.transcriptions ?? [],
      dictionary: input.dictionary ?? [],
    },
    { ...OPTIONS, ...options },
  );
}

describe('normalizeDictionary', () => {
  it('accepts a bare array of strings', () => {
    expect(normalizeDictionary(DICTIONARY_AS_STRINGS)).toEqual({
      words: ['Symfony', 'MetaTrader', 'ClickHouse'],
      raw_shape: 'strings',
      unrecognized_entries: 0,
    });
  });

  it('accepts an array of {word} objects', () => {
    expect(normalizeDictionary(DICTIONARY_AS_OBJECTS)).toEqual({
      words: ['Symfony', 'MetaTrader', 'ClickHouse'],
      raw_shape: 'objects',
      unrecognized_entries: 0,
    });
  });

  it('accepts a {words: [...]} wrapper', () => {
    expect(normalizeDictionary(DICTIONARY_AS_WRAPPED)).toEqual({
      words: ['Symfony', 'MetaTrader', 'ClickHouse'],
      raw_shape: 'wrapped',
      unrecognized_entries: 0,
    });
  });

  it('reports an empty list as empty rather than unrecognised', () => {
    expect(normalizeDictionary([])).toEqual({ words: [], raw_shape: 'empty', unrecognized_entries: 0 });
  });

  it('trims entries and drops blanks', () => {
    expect(normalizeDictionary(['  Symfony ', '', '   ']).words).toEqual(['Symfony']);
  });

  it('keeps the entries it understands and counts the ones it does not', () => {
    const view = normalizeDictionary(['Symfony', 42, { term: 'nope' }]);
    expect(view.words).toEqual(['Symfony']);
    expect(view.unrecognized_entries).toBe(2);
    expect(view.raw_shape).toBe('strings');
  });

  it('never throws on a shape it cannot read', () => {
    for (const raw of [null, undefined, 17, 'Symfony', { count: 3 }, [1, 2, 3]]) {
      expect(normalizeDictionary(raw)).toMatchObject({ words: [], raw_shape: 'unrecognized' });
    }
  });
});

describe('buildUsageReport — counts', () => {
  it('marks a count exact only while fewer rows came back than the limit', () => {
    const result = report(
      {
        notes: Array.from({ length: 100 }, (_, i) => makeNote({ id: i + 1 })),
        transcriptions: [makeTranscription({ id: 1 })],
        folders: DEFAULT_FOLDERS,
        dictionary: DICTIONARY_AS_STRINGS,
      },
      { notesLimit: 100, transcriptionsLimit: 200 },
    );

    expect(result.counts.notes).toEqual({ value: 100, exact: false });
    expect(result.counts.transcriptions).toEqual({ value: 1, exact: true });
    // The bridge caps neither of these, so their totals are never partial.
    expect(result.counts.folders).toEqual({ value: 3, exact: true });
    expect(result.counts.dictionary_words).toEqual({ value: 3, exact: true });
  });

  it('stamps the report with the injected clock, in UTC', () => {
    expect(report({}).generated_at).toBe('2026-09-08T12:00:00Z');
  });
});

describe('buildUsageReport — grouping', () => {
  it('splits notes by type and files an unknown type separately', () => {
    const result = report({
      notes: [
        makeNote({ id: 1, note_type: 'personal' }),
        makeNote({ id: 2, note_type: 'personal' }),
        makeNote({ id: 3, note_type: 'meeting' }),
        makeNote({ id: 4, note_type: 'upload' }),
        makeNote({ id: 5, note_type: null }),
      ],
    });

    expect(result.notes_by_type).toEqual({ personal: 2, meeting: 1, upload: 1, unknown: 1 });
  });

  it('names folders from the folder list and keeps unfiled notes visible', () => {
    const result = report({
      folders: DEFAULT_FOLDERS,
      notes: [
        makeNote({ id: 1, folder_id: 1 }),
        makeNote({ id: 2, folder_id: 1 }),
        makeNote({ id: 3, folder_id: 2 }),
        makeNote({ id: 4, folder_id: null }),
        makeNote({ id: 5, folder_id: 99 }),
      ],
    });

    expect(result.notes_by_folder.top).toEqual([
      { folder_id: 1, folder_name: 'Personal', notes: 2 },
      { folder_id: 2, folder_name: 'Meetings', notes: 1 },
      { folder_id: 99, folder_name: null, notes: 1 },
      { folder_id: null, folder_name: null, notes: 1 },
    ]);
    expect(result.notes_by_folder.other).toBeNull();
  });

  it('keeps the top 20 folders and aggregates the rest into other', () => {
    const folders = Array.from({ length: 22 }, (_, i) => makeFolder({ id: i + 1 }));
    // Folder i holds 23-i notes, so folder 1 is the largest and folder 22 the smallest.
    const notes: RawNote[] = [];
    let id = 1;
    for (let folderId = 1; folderId <= 22; folderId += 1) {
      for (let n = 0; n < 23 - folderId; n += 1) notes.push(makeNote({ id: id++, folder_id: folderId }));
    }

    const result = report({ folders, notes });

    expect(result.counts.notes.value).toBe(253); // 22 + 21 + ... + 1
    expect(result.notes_by_folder.top).toHaveLength(20);
    expect(result.notes_by_folder.top[0]).toEqual({ folder_id: 1, folder_name: 'Folder 1', notes: 22 });
    expect(result.notes_by_folder.top[19]).toEqual({ folder_id: 20, folder_name: 'Folder 20', notes: 3 });
    expect(result.notes_by_folder.other).toEqual({ folders: 2, notes: 3 }); // folders 21 and 22
  });
});

describe('buildUsageReport — text volume', () => {
  const notes = [
    makeNote({ id: 1, content: 'alpha beta' }), //           2 words, 10 chars
    makeNote({ id: 2, content: 'gamma', enhanced_content: 'gamma delta rewritten' }), // 1/5, 3/21
    makeNote({ id: 3, content: '', enhanced_content: null }),
  ];
  const transcriptions = [
    makeTranscription({ id: 1, text: 'one two three' }), // 3 words, 13 chars
    makeTranscription({ id: 2, text: null }),
  ];

  it('counts content, enhanced content and transcription text separately', () => {
    const result = report({ notes, transcriptions });

    expect(result.words.note_content).toBe(3);
    expect(result.chars.note_content).toBe(15);
    expect(result.words.note_enhanced_content).toBe(3);
    expect(result.chars.note_enhanced_content).toBe(21);
    expect(result.words.transcription_text).toBe(3);
    expect(result.chars.transcription_text).toBe(13);
  });

  it('never reports a grand total — enhanced_content is a rewrite of content, not an addition', () => {
    const result = report({ notes });
    expect(result.words).not.toHaveProperty('total');
    expect(result.words).not.toHaveProperty('total_words');
    expect(result.limitations.join(' ')).toMatch(/enhanced_content/);
  });
});

describe('buildUsageReport — transcripts', () => {
  const notes = [
    makeNote({
      id: 1,
      transcript: jsonTranscript([
        makeSegment({ text: 'one two' }), //   2 words,  7 chars
        makeSegment({ text: 'three' }), //     1 word,   5 chars
      ]),
    }),
    makeNote({ id: 2, transcript: 'plain words here' }), // 3 words, 16 chars
    makeNote({ id: 3, transcript: null }),
    makeNote({ id: 4, transcript: '   ' }),
  ];

  it('counts notes that carry a transcript without parsing, by default', () => {
    const result = report({ notes });

    expect(result.transcripts.notes_with_transcript).toBe(2);
    expect(result.transcripts.parsed).toBe(false);
    expect(result.transcripts.json).toBeNull();
    expect(result.transcripts.plain).toBeNull();
    expect(result.transcripts.total_segments).toBeNull();
    expect(result.words.note_transcript).toBeNull();
    expect(result.chars.note_transcript).toBeNull();
  });

  it('classifies a truncated transcript exactly as describeTranscript does', () => {
    const broken = [makeNote({ id: 1, transcript: BROKEN_JSON_TRANSCRIPT })];
    const result = report({ notes: broken }, { includeTranscriptStats: true });

    expect(describeTranscript(BROKEN_JSON_TRANSCRIPT).kind).toBe('plain');
    expect(result.transcripts).toMatchObject({ json: 0, plain: 1, total_segments: 0 });
    expect(result.chars.note_transcript).toBe(BROKEN_JSON_TRANSCRIPT.length);
  });

  it('splits json from plain and counts segment text when asked', () => {
    const result = report({ notes }, { includeTranscriptStats: true });

    expect(result.transcripts).toMatchObject({
      notes_with_transcript: 2,
      parsed: true,
      json: 1,
      plain: 1,
      total_segments: 2,
    });
    expect(result.words.note_transcript).toBe(6); // 2 + 1 from the segments, 3 from the legacy text
    expect(result.chars.note_transcript).toBe(28); // 7 + 5 + 16
  });
});

describe('buildUsageReport — audio', () => {
  it('keeps note seconds and transcription milliseconds apart', () => {
    const result = report({
      notes: [
        makeNote({ id: 1, audio_duration_seconds: 12.5 }),
        makeNote({ id: 2, audio_duration_seconds: 30 }),
        makeNote({ id: 3, audio_duration_seconds: null }),
      ],
      transcriptions: [
        makeTranscription({ id: 1, audio_duration_ms: 4200 }),
        makeTranscription({ id: 2, audio_duration_ms: null }),
      ],
    });

    expect(result.audio).toEqual({
      notes_seconds: 42.5,
      notes_with_duration: 2,
      transcriptions_ms: 4200,
      transcriptions_with_duration: 1,
    });
  });
});

describe('buildUsageReport — periods', () => {
  // A zone 14 hours ahead of UTC: any bucket computed locally lands in the wrong
  // month for the rows below, so these assertions fail if UTC is not used.
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Pacific/Kiritimati';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const notes = [
    makeNote({ id: 1, created_at: '2026-09-08 11:00:00' }), //  1 hour ago
    makeNote({ id: 2, created_at: '2026-09-02 00:00:00' }), //  6 days ago
    makeNote({ id: 3, created_at: '2026-08-31 23:30:00' }), //  August in UTC, September locally
    makeNote({ id: 4, created_at: '2026-07-04 09:00:00' }), //  outside both windows
    makeNote({ id: 5, created_at: null }),
  ];
  const transcriptions = [
    makeTranscription({ id: 1, timestamp: '2026-09-08 09:00:00', created_at: null }),
    makeTranscription({ id: 2, timestamp: null, created_at: '2026-08-31 23:45:00' }),
    makeTranscription({ id: 3, timestamp: null, created_at: null }),
  ];

  it('buckets by month in UTC, not in the local zone', () => {
    const result = report({ notes, transcriptions });

    expect(result.periods.timezone).toBe('UTC');
    expect(result.periods.by_month).toEqual({
      '2026-09': { notes: 2, transcriptions: 1 },
      '2026-08': { notes: 1, transcriptions: 1 },
      '2026-07': { notes: 1, transcriptions: 0 },
    });
  });

  it('counts the last 7 and 30 days from the injected clock', () => {
    const result = report({ notes, transcriptions });

    expect(result.periods.last_7_days).toEqual({ notes: 2, transcriptions: 1 });
    expect(result.periods.last_30_days).toEqual({ notes: 3, transcriptions: 2 });
  });

  it('reports rows with an unreadable timestamp instead of dropping them silently', () => {
    const result = report({ notes, transcriptions });
    expect(result.periods.undated).toEqual({ notes: 1, transcriptions: 1 });
  });
});

describe('buildUsageReport — dictionary, plan and limitations', () => {
  it('reports the dictionary size but never the words themselves', () => {
    const result = report({ dictionary: DICTIONARY_AS_OBJECTS });

    expect(result.dictionary).toEqual({
      word_count: 3,
      raw_shape: 'objects',
      unrecognized_entries: 0,
    });
    expect(JSON.stringify(result)).not.toContain('MetaTrader');
  });

  it('drops exact on dictionary_words once entries were skipped, as list_dictionary warns', () => {
    const mixed = [...DICTIONARY_AS_STRINGS, { spelling: 'Qdrant' }, 42, null];
    const result = report({ dictionary: mixed });

    expect(result.dictionary).toEqual({
      word_count: 3,
      raw_shape: 'strings',
      unrecognized_entries: 3,
    });
    // "7 words, exactly" over data the other tool warns about would be a lie.
    expect(result.counts.dictionary_words).toEqual({ value: 3, exact: false });
  });

  it('keeps exact:true when every entry was readable', () => {
    const result = report({ dictionary: DICTIONARY_AS_WRAPPED });
    expect(result.counts.dictionary_words).toEqual({ value: 3, exact: true });
  });

  it('never claims an exact count over a dictionary shape it could not read at all', () => {
    const result = report({ dictionary: { entries: 'who knows' } });

    expect(result.dictionary.raw_shape).toBe('unrecognized');
    expect(result.counts.dictionary_words).toEqual({ value: 0, exact: false });
  });

  it('says the subscription plan is not readable locally, and why', () => {
    const result = report({});

    expect(result.plan.available).toBe(false);
    expect(result.plan.reason).toMatch(/cloud/i);
  });

  it('names every limitation an agent could otherwise mistake for a fact', () => {
    const result = report({}, { notesLimit: 25, transcriptionsLimit: 60 });
    const text = result.limitations.join('\n');

    expect(text).toMatch(/25/); // the notes limit actually used
    expect(text).toMatch(/60/); // the transcriptions limit actually used
    expect(text).toMatch(/discarded/);
    expect(text).toMatch(/soft-deleted/i);
    expect(text).toMatch(/not linked|no link/i);
    expect(text).toMatch(/UTC/);
    expect(text).toMatch(/four requests|consistent snapshot/i);
    expect(text).toMatch(/enhanced_content/);
  });
});
