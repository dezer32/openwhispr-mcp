import { describe, expect, it } from 'vitest';

import {
  describeTranscript,
  toFolder,
  toNoteDetail,
  toNoteSummary,
  toTranscription,
} from '../../../src/domain/projections.js';
import { makeFolder } from '../../fixtures/folders.js';
import { SYNC_ONLY_KEYS, makeNote } from '../../fixtures/notes.js';
import { TIMESTAMP_SHAPES, makeTranscription } from '../../fixtures/transcriptions.js';
import {
  BROKEN_JSON_TRANSCRIPT,
  LEGACY_PLAIN_TRANSCRIPT,
  jsonTranscript,
  twoSpeakerSegments,
} from '../../fixtures/transcripts.js';

/** Allow-lists, copied verbatim from the spec. */
const SUMMARY_KEYS = [
  'id',
  'title',
  'note_type',
  'folder_id',
  'folder_name',
  'created_at',
  'updated_at',
  'content_chars',
  'content_preview',
  'has_enhanced_content',
  'has_transcript',
  'transcript_kind',
  'transcript_segment_count',
  'audio_duration_seconds',
].sort();

const DETAIL_EXTRA_KEYS = [
  'content',
  'enhancement_prompt',
  'source_file',
  'calendar_event_id',
  'participants',
  'diarization_enabled',
  'expected_speaker_count',
  'transcript_hint',
];

const DETAIL_KEYS = [...SUMMARY_KEYS, ...DETAIL_EXTRA_KEYS].sort();

const FOLDER_KEYS = ['id', 'name', 'is_default', 'sort_order', 'created_at', 'updated_at'].sort();

const TRANSCRIPTION_KEYS = [
  'id',
  'text',
  'timestamp',
  'created_at',
  'has_audio',
  'audio_duration_ms',
  'provider',
  'model',
  'status',
  'error_message',
  'error_code',
  'route_kind',
  'text_chars',
  'word_count',
].sort();

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

describe('toNoteSummary', () => {
  it('returns exactly the allow-listed keys', () => {
    expect(keysOf(toNoteSummary(makeNote(), 'Personal'))).toEqual(SUMMARY_KEYS);
  });

  it('leaks no sync-only column and never the transcript or the body', () => {
    const summary = toNoteSummary(
      makeNote({ transcript: jsonTranscript(twoSpeakerSegments(3)) }),
      'Personal',
    ) as unknown as Record<string, unknown>;
    for (const key of SYNC_ONLY_KEYS) {
      expect(summary).not.toHaveProperty(key);
    }
    expect(summary).not.toHaveProperty('transcript');
    expect(summary).not.toHaveProperty('content');
    expect(summary).not.toHaveProperty('enhanced_content');
    expect(summary).not.toHaveProperty('enhancement_prompt');
  });

  it('renders both timestamps as UTC ISO strings', () => {
    const summary = toNoteSummary(makeNote(), null);
    expect(summary.created_at).toBe('2026-09-01T10:00:00Z');
    expect(summary.updated_at).toBe('2026-09-08T08:31:48Z');
  });

  it('carries the resolved folder name, including when it is unknown', () => {
    expect(toNoteSummary(makeNote({ folder_id: 3 }), 'Videos').folder_name).toBe('Videos');
    expect(toNoteSummary(makeNote({ folder_id: 3 }), null).folder_name).toBeNull();
    expect(toNoteSummary(makeNote({ folder_id: 3 }), null).folder_id).toBe(3);
  });

  it('summarises the body without shipping it', () => {
    const body = 'word '.repeat(100).trim();
    const summary = toNoteSummary(makeNote({ content: body }), null);
    expect(summary.content_chars).toBe(body.length);
    expect(summary.content_preview.length).toBeLessThanOrEqual(200);
    expect(summary.content_preview.endsWith('…')).toBe(true);
  });

  it('reports enhanced content as a flag only', () => {
    expect(toNoteSummary(makeNote({ enhanced_content: null }), null).has_enhanced_content).toBe(false);
    expect(toNoteSummary(makeNote({ enhanced_content: '' }), null).has_enhanced_content).toBe(false);
    expect(toNoteSummary(makeNote({ enhanced_content: 'better' }), null).has_enhanced_content).toBe(true);
  });

  it('describes a JSON transcript by kind and segment count', () => {
    const summary = toNoteSummary(
      makeNote({ transcript: jsonTranscript(twoSpeakerSegments(6)) }),
      null,
    );
    expect(summary.has_transcript).toBe(true);
    expect(summary.transcript_kind).toBe('json');
    expect(summary.transcript_segment_count).toBe(6);
  });

  it('describes a legacy plain transcript without a count', () => {
    const summary = toNoteSummary(makeNote({ transcript: LEGACY_PLAIN_TRANSCRIPT }), null);
    expect(summary.has_transcript).toBe(true);
    expect(summary.transcript_kind).toBe('plain');
    expect(summary.transcript_segment_count).toBeNull();
  });

  it('reports no transcript at all', () => {
    const summary = toNoteSummary(makeNote({ transcript: null }), null);
    expect(summary.has_transcript).toBe(false);
    expect(summary.transcript_kind).toBeNull();
    expect(summary.transcript_segment_count).toBeNull();
  });

  it('normalises absent columns to null and keeps the key set stable', () => {
    const sparse = toNoteSummary({ id: 9 }, null);
    expect(keysOf(sparse)).toEqual(SUMMARY_KEYS);
    expect(sparse.title).toBeNull();
    expect(sparse.note_type).toBeNull();
    expect(sparse.folder_id).toBeNull();
    expect(sparse.created_at).toBeNull();
    expect(sparse.updated_at).toBeNull();
    expect(sparse.audio_duration_seconds).toBeNull();
    expect(sparse.content_chars).toBe(0);
    expect(sparse.content_preview).toBe('');
  });
});

describe('toNoteDetail', () => {
  it('returns exactly the allow-listed keys when enhanced content is withheld', () => {
    const detail = toNoteDetail(makeNote({ enhanced_content: 'better' }), 'Personal', {
      includeEnhanced: false,
    });
    expect(keysOf(detail)).toEqual(DETAIL_KEYS);
    expect(detail).not.toHaveProperty('enhanced_content');
    expect(detail.has_enhanced_content).toBe(true);
  });

  it('adds enhanced_content only when asked', () => {
    const detail = toNoteDetail(makeNote({ enhanced_content: 'better' }), 'Personal', {
      includeEnhanced: true,
    });
    expect(keysOf(detail)).toEqual([...DETAIL_KEYS, 'enhanced_content'].sort());
    expect(detail.enhanced_content).toBe('better');
  });

  it('never returns the raw transcript or a sync column', () => {
    const detail = toNoteDetail(
      makeNote({ transcript: jsonTranscript(twoSpeakerSegments(4)) }),
      null,
      { includeEnhanced: true },
    ) as unknown as Record<string, unknown>;
    expect(detail).not.toHaveProperty('transcript');
    for (const key of SYNC_ONLY_KEYS) {
      expect(detail).not.toHaveProperty(key);
    }
  });

  it('parses participants JSON', () => {
    const detail = toNoteDetail(
      makeNote({ participants: '[{"name":"Ada"},{"name":"Grace"}]' }),
      null,
      { includeEnhanced: false },
    );
    expect(detail.participants).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);
    expect(detail).not.toHaveProperty('participants_parse_error');
  });

  it('falls back to the raw string and flags unparseable participants', () => {
    const detail = toNoteDetail(makeNote({ participants: 'Ada, Grace' }), null, {
      includeEnhanced: false,
    });
    expect(detail.participants).toBe('Ada, Grace');
    expect(detail.participants_parse_error).toBe(true);
    expect(keysOf(detail)).toEqual([...DETAIL_KEYS, 'participants_parse_error'].sort());
  });

  it('leaves absent participants as null without a flag', () => {
    const detail = toNoteDetail(makeNote({ participants: null }), null, { includeEnhanced: false });
    expect(detail.participants).toBeNull();
    expect(detail).not.toHaveProperty('participants_parse_error');
  });

  it('turns the SQLite integer flags into booleans', () => {
    expect(
      toNoteDetail(makeNote({ diarization_enabled: 1 }), null, { includeEnhanced: false })
        .diarization_enabled,
    ).toBe(true);
    expect(
      toNoteDetail(makeNote({ diarization_enabled: 0 }), null, { includeEnhanced: false })
        .diarization_enabled,
    ).toBe(false);
    expect(
      toNoteDetail(makeNote({ diarization_enabled: null }), null, { includeEnhanced: false })
        .diarization_enabled,
    ).toBe(false);
  });

  it('points at get_note_transcript instead of inlining 202 segments', () => {
    const detail = toNoteDetail(
      makeNote({ transcript: jsonTranscript(twoSpeakerSegments(202)) }),
      null,
      { includeEnhanced: false },
    );
    expect(detail.transcript_hint).toBe('Use get_note_transcript for the 202 transcript segments.');
  });

  it('hints at a plain transcript and stays silent when there is none', () => {
    expect(
      toNoteDetail(makeNote({ transcript: LEGACY_PLAIN_TRANSCRIPT }), null, {
        includeEnhanced: false,
      }).transcript_hint,
    ).toContain('get_note_transcript');
    expect(
      toNoteDetail(makeNote({ transcript: null }), null, { includeEnhanced: false })
        .transcript_hint,
    ).toBeNull();
  });

  it('keeps the body and the descriptive columns', () => {
    const detail = toNoteDetail(
      makeNote({
        content: 'the body',
        enhancement_prompt: 'make it crisp',
        source_file: '/tmp/audio.wav',
        calendar_event_id: 'evt-1',
        expected_speaker_count: 3,
      }),
      null,
      { includeEnhanced: false },
    );
    expect(detail.content).toBe('the body');
    expect(detail.enhancement_prompt).toBe('make it crisp');
    expect(detail.source_file).toBe('/tmp/audio.wav');
    expect(detail.calendar_event_id).toBe('evt-1');
    expect(detail.expected_speaker_count).toBe(3);
  });
});

describe('describeTranscript', () => {
  it('reports nothing for null, undefined and blank input', () => {
    expect(describeTranscript(null)).toEqual({ kind: null, segment_count: null });
    expect(describeTranscript(undefined)).toEqual({ kind: null, segment_count: null });
    expect(describeTranscript('')).toEqual({ kind: null, segment_count: null });
    expect(describeTranscript('   ')).toEqual({ kind: null, segment_count: null });
  });

  it('counts the segments of a JSON transcript', () => {
    expect(describeTranscript(jsonTranscript(twoSpeakerSegments(6)))).toEqual({
      kind: 'json',
      segment_count: 6,
    });
    expect(describeTranscript('[]')).toEqual({ kind: 'json', segment_count: 0 });
  });

  it('tolerates leading whitespace before the JSON array', () => {
    expect(describeTranscript(`\n  ${jsonTranscript(twoSpeakerSegments(2))}`)).toEqual({
      kind: 'json',
      segment_count: 2,
    });
  });

  it('degrades a truncated JSON transcript to plain text', () => {
    expect(describeTranscript(BROKEN_JSON_TRANSCRIPT)).toEqual({ kind: 'plain', segment_count: null });
  });

  it('reports flat legacy text as plain', () => {
    expect(describeTranscript(LEGACY_PLAIN_TRANSCRIPT)).toEqual({ kind: 'plain', segment_count: null });
    expect(describeTranscript('{"text":"an object, not an array"}')).toEqual({
      kind: 'plain',
      segment_count: null,
    });
  });
});

describe('toFolder', () => {
  it('returns exactly the allow-listed keys', () => {
    expect(keysOf(toFolder(makeFolder()))).toEqual(FOLDER_KEYS);
  });

  it('hides the sync columns', () => {
    const folder = toFolder(makeFolder()) as unknown as Record<string, unknown>;
    for (const key of ['cloud_id', 'client_folder_id', 'sync_status', 'deleted_at', 'space_id', 'account_id', 'left_team']) {
      expect(folder).not.toHaveProperty(key);
    }
  });

  it('turns is_default into a boolean and the dates into ISO', () => {
    expect(toFolder(makeFolder({ is_default: 1 })).is_default).toBe(true);
    expect(toFolder(makeFolder({ is_default: 0 })).is_default).toBe(false);
    expect(toFolder(makeFolder()).created_at).toBe('2026-01-01T00:00:00Z');
    expect(toFolder(makeFolder()).updated_at).toBe('2026-01-01T00:00:00Z');
  });

  it('normalises absent columns', () => {
    const folder = toFolder({ id: 5 });
    expect(keysOf(folder)).toEqual(FOLDER_KEYS);
    expect(folder.name).toBeNull();
    expect(folder.is_default).toBe(false);
    expect(folder.sort_order).toBeNull();
    expect(folder.created_at).toBeNull();
  });
});

describe('toTranscription', () => {
  it('returns exactly the allow-listed keys', () => {
    expect(keysOf(toTranscription(makeTranscription()))).toEqual(TRANSCRIPTION_KEYS);
  });

  it('hides raw_text and the sync columns', () => {
    const view = toTranscription(makeTranscription()) as unknown as Record<string, unknown>;
    for (const key of ['raw_text', 'cloud_id', 'sync_status', 'deleted_at', 'client_transcription_id']) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it('accepts a SQLite datetime timestamp', () => {
    const view = toTranscription(makeTranscription({ timestamp: TIMESTAMP_SHAPES.sqliteString }));
    expect(view.timestamp).toBe('2026-09-07T12:00:00Z');
  });

  it('accepts an epoch-millisecond timestamp', () => {
    const view = toTranscription(makeTranscription({ timestamp: TIMESTAMP_SHAPES.epochMs }));
    expect(view.timestamp).toBe(new Date(TIMESTAMP_SHAPES.epochMs).toISOString().replace('.000Z', 'Z'));
  });

  it('counts the text it returns', () => {
    const view = toTranscription(makeTranscription({ text: 'Two words here.' }));
    expect(view.text_chars).toBe('Two words here.'.length);
    expect(view.word_count).toBe(3);
  });

  it('normalises flags and absent columns', () => {
    expect(toTranscription(makeTranscription({ has_audio: 1 })).has_audio).toBe(true);
    expect(toTranscription(makeTranscription({ has_audio: 0 })).has_audio).toBe(false);
    const sparse = toTranscription({ id: 4 });
    expect(keysOf(sparse)).toEqual(TRANSCRIPTION_KEYS);
    expect(sparse.text).toBeNull();
    expect(sparse.timestamp).toBeNull();
    expect(sparse.provider).toBeNull();
    expect(sparse.text_chars).toBe(0);
    expect(sparse.word_count).toBe(0);
  });
});
