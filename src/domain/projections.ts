import type { RawFolder, RawNote, RawTranscription } from '../bridge/types.js';
import { num } from './coerce.js';
import { toIsoZ } from './dates.js';
import { buildPreview } from './ftsQuery.js';
import { countChars, countWords } from './words.js';

/**
 * Allow-listed views over the bridge rows.
 *
 * The bridge answers with `SELECT *`, so every row carries sync bookkeeping
 * (`cloud_id`, `sync_status`, `account_id`, …) and, for notes, a `transcript`
 * column that reaches 240 KB. Nothing here is a filter over the raw row: each
 * projection builds a fresh object, so a new column added by an app update
 * cannot leak into a tool result.
 */

export const CONTENT_PREVIEW_CHARS = 200;

export type TranscriptKind = 'json' | 'plain';

export interface TranscriptShape {
  kind: TranscriptKind | null;
  segment_count: number | null;
}

export interface NoteSummary {
  id: number;
  title: string | null;
  note_type: string | null;
  folder_id: number | null;
  /** Resolved by `folderIndex`; the note row itself only carries `folder_id`. */
  folder_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  content_chars: number;
  content_preview: string;
  has_enhanced_content: boolean;
  has_transcript: boolean;
  transcript_kind: TranscriptKind | null;
  transcript_segment_count: number | null;
  audio_duration_seconds: number | null;
}

export interface NoteDetail extends NoteSummary {
  content: string | null;
  /** Present only when the caller asked for it. */
  enhanced_content?: string | null;
  enhancement_prompt: string | null;
  source_file: string | null;
  calendar_event_id: string | null;
  /** Parsed JSON when the column holds JSON, otherwise the raw string. */
  participants: unknown;
  participants_parse_error?: boolean;
  diarization_enabled: boolean;
  expected_speaker_count: number | null;
  transcript_hint: string | null;
}

export interface FolderView {
  id: number;
  name: string | null;
  is_default: boolean;
  sort_order: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface TranscriptionView {
  id: number;
  text: string | null;
  timestamp: string | null;
  created_at: string | null;
  has_audio: boolean;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  error_message: string | null;
  error_code: string | null;
  route_kind: string | null;
  text_chars: number;
  word_count: number;
  /** Only present for `get_transcription`: the text before the custom dictionary rewrote it. */
  raw_text?: string | null;
}

export interface TranscriptionProjectionOptions {
  /**
   * Include `raw_text`. Off for lists — it roughly doubles every row — on for a
   * single transcription, where "why did this word come out wrong" is the
   * question being asked.
   */
  includeRaw?: boolean;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** SQLite has no boolean type: flags arrive as 0/1, occasionally as text. */
function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    return normalised !== '' && normalised !== '0' && normalised !== 'false';
  }
  return false;
}

export interface TranscriptColumn {
  kind: TranscriptKind | null;
  /** The parsed array for a JSON transcript, `null` otherwise. */
  entries: unknown[] | null;
}

/**
 * `notes.transcript` holds either a JSON array of segments or flat legacy text.
 * The app discriminates on a leading `[`; we do the same, but a leading `[` that
 * fails to parse (a truncated write) degrades to plain rather than throwing.
 *
 * The parsed array is handed back rather than discarded: the column reaches
 * 240 KB, and `parseTranscript` used to re-parse it right after asking for the
 * kind.
 */
export function readTranscriptColumn(raw: string | null | undefined): TranscriptColumn {
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: null, entries: null };

  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { kind: 'json', entries: parsed };
    } catch {
      // Corrupt or truncated JSON: still text, just not structured.
    }
  }
  return { kind: 'plain', entries: null };
}

/** The same discrimination, reduced to what a note summary reports. */
export function describeTranscript(raw: string | null | undefined): TranscriptShape {
  const column = readTranscriptColumn(raw);
  return {
    kind: column.kind,
    segment_count: column.entries === null ? null : column.entries.length,
  };
}

function transcriptHint(shape: TranscriptShape): string | null {
  if (shape.kind === null) return null;
  if (shape.kind === 'json' && shape.segment_count !== null) {
    const noun = shape.segment_count === 1 ? 'segment' : 'segments';
    return `Use get_note_transcript for the ${shape.segment_count} transcript ${noun}.`;
  }
  return 'Use get_note_transcript for the full transcript text.';
}

function parseParticipants(raw: unknown): { value: unknown; failed: boolean } {
  if (raw === null || raw === undefined) return { value: null, failed: false };
  if (typeof raw !== 'string') return { value: raw, failed: false };
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, failed: false };
  try {
    return { value: JSON.parse(trimmed) as unknown, failed: false };
  } catch {
    // Older rows stored a comma-separated list; hand it over as-is and say so.
    return { value: raw, failed: true };
  }
}

export function toNoteSummary(note: RawNote, folderName: string | null): NoteSummary {
  const content = str(note.content);
  const shape = describeTranscript(str(note.transcript));
  return {
    id: note.id,
    title: str(note.title),
    note_type: str(note.note_type),
    folder_id: num(note.folder_id),
    folder_name: folderName ?? null,
    created_at: toIsoZ(note.created_at),
    updated_at: toIsoZ(note.updated_at),
    content_chars: countChars(content),
    content_preview: buildPreview(content, CONTENT_PREVIEW_CHARS),
    has_enhanced_content: (str(note.enhanced_content) ?? '') !== '',
    has_transcript: shape.kind !== null,
    transcript_kind: shape.kind,
    transcript_segment_count: shape.segment_count,
    audio_duration_seconds: num(note.audio_duration_seconds),
  };
}

export function toNoteDetail(
  note: RawNote,
  folderName: string | null,
  opts: { includeEnhanced: boolean },
): NoteDetail {
  const summary = toNoteSummary(note, folderName);
  const participants = parseParticipants(note.participants);

  const detail: NoteDetail = {
    ...summary,
    content: str(note.content),
    enhancement_prompt: str(note.enhancement_prompt),
    source_file: str(note.source_file),
    calendar_event_id: str(note.calendar_event_id),
    participants: participants.value,
    diarization_enabled: bool(note.diarization_enabled),
    expected_speaker_count: num(note.expected_speaker_count),
    transcript_hint: transcriptHint({
      kind: summary.transcript_kind,
      segment_count: summary.transcript_segment_count,
    }),
  };

  if (participants.failed) detail.participants_parse_error = true;
  if (opts.includeEnhanced) detail.enhanced_content = str(note.enhanced_content);
  return detail;
}

export function toFolder(folder: RawFolder): FolderView {
  return {
    id: folder.id,
    name: str(folder.name),
    is_default: bool(folder.is_default),
    sort_order: num(folder.sort_order),
    created_at: toIsoZ(folder.created_at),
    updated_at: toIsoZ(folder.updated_at),
  };
}

export function toTranscription(
  row: RawTranscription,
  options: TranscriptionProjectionOptions = {},
): TranscriptionView {
  const text = str(row.text);
  const view: TranscriptionView = {
    id: row.id,
    text,
    // The column type is unconfirmed: a datetime string and an epoch number
    // both occur, and `toIsoZ` flattens either into UTC ISO.
    timestamp: toIsoZ(row.timestamp),
    created_at: toIsoZ(row.created_at),
    has_audio: bool(row.has_audio),
    audio_duration_ms: num(row.audio_duration_ms),
    provider: str(row.provider),
    model: str(row.model),
    status: str(row.status),
    error_message: str(row.error_message),
    error_code: str(row.error_code),
    route_kind: str(row.route_kind),
    text_chars: countChars(text),
    word_count: countWords(text),
  };
  if (options.includeRaw) view.raw_text = str(row.raw_text);
  return view;
}
