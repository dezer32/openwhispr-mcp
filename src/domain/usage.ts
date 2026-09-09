import type {
  RawFolder,
  RawNote,
  RawTranscriptSegment,
  RawTranscription,
} from '../bridge/types.js';
import { isRecord, num, round3 } from './coerce.js';
import { epochToIsoZ, monthKey, parseSqliteUtc, withinLastDays, type DateInput } from './dates.js';
import { countChars, countWords } from './words.js';

/**
 * Local aggregation over the four lists `get_usage` reads.
 *
 * The bridge has no statistics route at all, so every number here is derived
 * from rows the tool actually fetched — which is exactly why each counter
 * carries an `exact` flag and the report ends in a list of limitations.
 * Pure: no clock, no network, no I/O.
 */

/** Folders past this rank are collapsed into a single `other` bucket. */
const TOP_FOLDERS = 20;

const PLAN_REASON =
  'The subscription plan and its usage counters live in the OpenWhispr cloud (the app reads them over its own IPC channel from api.openwhispr.com). The local app neither computes nor stores them, and the CLI bridge exposes no route for them.';

export type DictionaryShape = 'strings' | 'objects' | 'wrapped' | 'empty' | 'unrecognized';

export interface DictionaryView {
  words: string[];
  raw_shape: DictionaryShape;
  /** Entries that were neither a string nor `{word: string}`. */
  unrecognized_entries: number;
}

export interface CountView {
  value: number;
  /** False once the row count reached the limit the tool asked for. */
  exact: boolean;
}

export interface FolderUsage {
  folder_id: number | null;
  folder_name: string | null;
  notes: number;
}

export interface TextTotals {
  note_content: number;
  note_enhanced_content: number;
  /** Null unless transcript parsing was requested. */
  note_transcript: number | null;
  transcription_text: number;
}

export interface PeriodCounts {
  notes: number;
  transcriptions: number;
}

export interface UsageReport {
  generated_at: string;
  limits: { notes: number; transcriptions: number };
  counts: {
    notes: CountView;
    folders: CountView;
    transcriptions: CountView;
    dictionary_words: CountView;
  };
  notes_by_type: Record<string, number>;
  notes_by_folder: {
    top: FolderUsage[];
    other: { folders: number; notes: number } | null;
  };
  words: TextTotals;
  chars: TextTotals;
  transcripts: {
    notes_with_transcript: number;
    /** False when `include_transcript_stats` was off; the rest is then null. */
    parsed: boolean;
    json: number | null;
    plain: number | null;
    total_segments: number | null;
  };
  audio: {
    notes_seconds: number;
    notes_with_duration: number;
    transcriptions_ms: number;
    transcriptions_with_duration: number;
  };
  periods: {
    timezone: 'UTC';
    basis: { notes: string; transcriptions: string };
    last_7_days: PeriodCounts;
    last_30_days: PeriodCounts;
    by_month: Record<string, PeriodCounts>;
    undated: PeriodCounts;
  };
  dictionary: {
    word_count: number;
    raw_shape: DictionaryShape;
    /** Entries neither a string nor `{word}`; they are missing from word_count. */
    unrecognized_entries: number;
  };
  plan: { available: false; reason: string };
  limitations: string[];
}

export interface UsageInput {
  folders: RawFolder[];
  notes: RawNote[];
  transcriptions: RawTranscription[];
  /** Whatever `/v1/dictionary/list` returned; the shape is not contractual. */
  dictionary: unknown;
}

export interface UsageOptions {
  /** Injected clock, epoch ms. */
  now: number;
  notesLimit: number;
  transcriptionsLimit: number;
  includeTranscriptStats: boolean;
}

/**
 * The bridge returns the dictionary as whatever the app happened to store: a
 * bare array of strings, an array of `{word}` rows, or a `{words: [...]}`
 * wrapper. An unreadable shape is reported, never thrown — a dictionary the
 * caller cannot parse must not fail an otherwise valid tool call.
 */
export function normalizeDictionary(raw: unknown): DictionaryView {
  const unwrapped = isRecord(raw) && Array.isArray(raw.words) ? raw.words : raw;
  const viaWrapper = unwrapped !== raw;

  if (!Array.isArray(unwrapped)) {
    return { words: [], raw_shape: 'unrecognized', unrecognized_entries: 0 };
  }
  if (unwrapped.length === 0) {
    return { words: [], raw_shape: viaWrapper ? 'wrapped' : 'empty', unrecognized_entries: 0 };
  }

  const words: string[] = [];
  let unrecognized = 0;
  let sawString = false;

  for (const entry of unwrapped) {
    let word: string | null = null;
    if (typeof entry === 'string') {
      sawString = true;
      word = entry;
    } else if (isRecord(entry) && typeof entry.word === 'string') {
      word = entry.word;
    } else {
      unrecognized += 1;
      continue;
    }
    const trimmed = word.trim();
    if (trimmed !== '') words.push(trimmed);
  }

  if (words.length === 0) {
    const shape: DictionaryShape = unrecognized > 0 ? 'unrecognized' : 'empty';
    return { words, raw_shape: shape, unrecognized_entries: unrecognized };
  }
  const shape: DictionaryShape = viaWrapper ? 'wrapped' : sawString ? 'strings' : 'objects';
  return { words, raw_shape: shape, unrecognized_entries: unrecognized };
}

interface ParsedTranscript {
  kind: 'json' | 'plain' | null;
  segments: RawTranscriptSegment[] | null;
}

/**
 * Mirrors `describeTranscript` in `projections.ts` — leading `[` means JSON, a
 * parse failure degrades to plain — but keeps the parsed segments, so a 240 KB
 * column is parsed once instead of twice.
 */
function readTranscript(raw: unknown): ParsedTranscript {
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: null, segments: null };
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { kind: 'json', segments: parsed as RawTranscriptSegment[] };
    } catch {
      // Truncated write: still text, just not structured.
    }
  }
  return { kind: 'plain', segments: null };
}

function hasTranscript(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim() !== '';
}

function rankFolders(usage: Map<number | null, number>, names: Map<number, string>) {
  const rows: FolderUsage[] = [...usage].map(([folderId, notes]) => ({
    folder_id: folderId,
    folder_name: folderId === null ? null : names.get(folderId) ?? null,
    notes,
  }));
  // Ties are broken by id so the report is stable across calls; unfiled last.
  rows.sort((a, b) => b.notes - a.notes || (a.folder_id ?? Infinity) - (b.folder_id ?? Infinity));

  const top = rows.slice(0, TOP_FOLDERS);
  const rest = rows.slice(TOP_FOLDERS);
  const other = rest.length
    ? { folders: rest.length, notes: rest.reduce((sum, row) => sum + row.notes, 0) }
    : null;
  return { top, other };
}

function buildLimitations(opts: UsageOptions): string[] {
  return [
    `Counts are taken from at most ${opts.notesLimit} notes and ${opts.transcriptionsLimit} transcriptions: the bridge offers no pagination, only a limit. A counter reports exact:false once as many rows came back as were asked for, which means there are probably more.`,
    'The bridge hides soft-deleted notes and both soft-deleted and discarded transcriptions entirely, so nothing here can account for them.',
    'notes and transcriptions are two independent streams with no link between them — a transcription is not the transcript of any note, and the two totals must not be added together.',
    'All timestamps and period buckets are UTC: the app stores dates without a zone, so a local-time reading of them would be off by the offset.',
    'This report is stitched from four separate requests (folders, notes, transcriptions, dictionary) and is therefore not a consistent snapshot — the data may have changed between them.',
    'No grand total of words is reported: enhanced_content is a rewritten copy of content, so summing the two would count the same text twice.',
  ];
}

export function buildUsageReport(input: UsageInput, opts: UsageOptions): UsageReport {
  const { notes, folders, transcriptions } = input;
  const dictionary = normalizeDictionary(input.dictionary);

  const folderNames = new Map<number, string>();
  for (const folder of folders) {
    const name = typeof folder?.name === 'string' ? folder.name.trim() : '';
    if (typeof folder?.id === 'number' && name !== '') folderNames.set(folder.id, name);
  }

  const byType: Record<string, number> = {};
  const byFolder = new Map<number | null, number>();

  const words: TextTotals = {
    note_content: 0,
    note_enhanced_content: 0,
    note_transcript: opts.includeTranscriptStats ? 0 : null,
    transcription_text: 0,
  };
  const chars: TextTotals = { ...words };

  let notesWithTranscript = 0;
  let jsonTranscripts = 0;
  let plainTranscripts = 0;
  let totalSegments = 0;
  let notesSeconds = 0;
  let notesWithDuration = 0;

  const monthly = new Map<string, PeriodCounts>();
  const last7: PeriodCounts = { notes: 0, transcriptions: 0 };
  const last30: PeriodCounts = { notes: 0, transcriptions: 0 };
  const undated: PeriodCounts = { notes: 0, transcriptions: 0 };

  function bucket(stamp: DateInput, field: 'notes' | 'transcriptions'): void {
    if (parseSqliteUtc(stamp) === null) {
      undated[field] += 1;
      return;
    }
    if (withinLastDays(stamp, 7, opts.now)) last7[field] += 1;
    if (withinLastDays(stamp, 30, opts.now)) last30[field] += 1;
    const key = monthKey(stamp);
    if (key === null) return;
    const row = monthly.get(key) ?? { notes: 0, transcriptions: 0 };
    row[field] += 1;
    monthly.set(key, row);
  }

  for (const note of notes) {
    const type = typeof note.note_type === 'string' && note.note_type !== '' ? note.note_type : 'unknown';
    byType[type] = (byType[type] ?? 0) + 1;

    const folderId = num(note.folder_id);
    byFolder.set(folderId, (byFolder.get(folderId) ?? 0) + 1);

    const content = typeof note.content === 'string' ? note.content : null;
    words.note_content += countWords(content);
    chars.note_content += countChars(content);

    const enhanced = typeof note.enhanced_content === 'string' ? note.enhanced_content : null;
    words.note_enhanced_content += countWords(enhanced);
    chars.note_enhanced_content += countChars(enhanced);

    if (hasTranscript(note.transcript)) notesWithTranscript += 1;

    if (opts.includeTranscriptStats) {
      const transcript = readTranscript(note.transcript);
      if (transcript.kind === 'json' && transcript.segments) {
        jsonTranscripts += 1;
        totalSegments += transcript.segments.length;
        for (const segment of transcript.segments) {
          const text = typeof segment?.text === 'string' ? segment.text : null;
          words.note_transcript = (words.note_transcript ?? 0) + countWords(text);
          chars.note_transcript = (chars.note_transcript ?? 0) + countChars(text);
        }
      } else if (transcript.kind === 'plain') {
        plainTranscripts += 1;
        const text = note.transcript as string;
        words.note_transcript = (words.note_transcript ?? 0) + countWords(text);
        chars.note_transcript = (chars.note_transcript ?? 0) + countChars(text);
      }
    }

    const seconds = num(note.audio_duration_seconds);
    if (seconds !== null) {
      notesSeconds += seconds;
      notesWithDuration += 1;
    }

    bucket(note.created_at, 'notes');
  }

  let transcriptionsMs = 0;
  let transcriptionsWithDuration = 0;

  for (const row of transcriptions) {
    const text = typeof row.text === 'string' ? row.text : null;
    words.transcription_text += countWords(text);
    chars.transcription_text += countChars(text);

    const ms = num(row.audio_duration_ms);
    if (ms !== null) {
      transcriptionsMs += ms;
      transcriptionsWithDuration += 1;
    }

    // `timestamp` is the row's own clock; `created_at` is the fallback when the
    // column is empty or holds something unparseable.
    const stamp = parseSqliteUtc(row.timestamp) === null ? row.created_at : row.timestamp;
    bucket(stamp, 'transcriptions');
  }

  const byMonth: Record<string, PeriodCounts> = {};
  for (const key of [...monthly.keys()].sort().reverse()) byMonth[key] = monthly.get(key)!;

  return {
    generated_at: epochToIsoZ(opts.now),
    limits: { notes: opts.notesLimit, transcriptions: opts.transcriptionsLimit },
    counts: {
      notes: { value: notes.length, exact: notes.length < opts.notesLimit },
      // Neither route takes a limit, so these two are never partial.
      folders: { value: folders.length, exact: true },
      transcriptions: {
        value: transcriptions.length,
        exact: transcriptions.length < opts.transcriptionsLimit,
      },
      // `list_dictionary` warns about entries it could not read, so claiming an
      // exact count over the same data would make the two tools contradict
      // each other on the same dictionary.
      dictionary_words: {
        value: dictionary.words.length,
        exact: dictionary.unrecognized_entries === 0 && dictionary.raw_shape !== 'unrecognized',
      },
    },
    notes_by_type: byType,
    notes_by_folder: rankFolders(byFolder, folderNames),
    words,
    chars,
    transcripts: {
      notes_with_transcript: notesWithTranscript,
      parsed: opts.includeTranscriptStats,
      json: opts.includeTranscriptStats ? jsonTranscripts : null,
      plain: opts.includeTranscriptStats ? plainTranscripts : null,
      total_segments: opts.includeTranscriptStats ? totalSegments : null,
    },
    audio: {
      notes_seconds: round3(notesSeconds),
      notes_with_duration: notesWithDuration,
      transcriptions_ms: round3(transcriptionsMs),
      transcriptions_with_duration: transcriptionsWithDuration,
    },
    periods: {
      timezone: 'UTC',
      basis: {
        notes: 'created_at',
        transcriptions: 'timestamp, falling back to created_at',
      },
      last_7_days: last7,
      last_30_days: last30,
      by_month: byMonth,
      undated,
    },
    dictionary: {
      word_count: dictionary.words.length,
      raw_shape: dictionary.raw_shape,
      unrecognized_entries: dictionary.unrecognized_entries,
    },
    plan: { available: false, reason: PLAN_REASON },
    limitations: buildLimitations(opts),
  };
}
