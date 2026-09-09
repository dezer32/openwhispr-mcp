import type { RawTranscriptSegment } from '../bridge/types.js';
import { isRecord, round3 } from './coerce.js';
import { EPOCH_MS_FLOOR, EPOCH_S_FLOOR } from './dates.js';
import { readTranscriptColumn } from './projections.js';
import { countWords } from './words.js';

/**
 * Reading of `notes.transcript`.
 *
 * The column holds either a JSON array of diarization segments or flat legacy
 * text. Segments carry no `start`/`end`/`words` — only a single `timestamp`
 * whose unit is not declared anywhere, so it has to be inferred.
 *
 * The app's own inference ("subtract the minimum and divide by 1000 when the
 * minimum is above 1e9") turns a transcript stamped in epoch *seconds* into
 * milliseconds and shows every offset 1000x too small. This module keeps the
 * three cases apart instead.
 */

export type TranscriptKind = 'json' | 'plain' | null;

export type TimeUnit = 'ms' | 's' | 'relative';

export interface ParsedTranscript {
  kind: TranscriptKind;
  segments: RawTranscriptSegment[];
  /** Non-empty only for `plain`: the text split on paragraph boundaries. */
  chunks: string[];
  warning?: string;
}

export interface NormalizedSegment {
  index: number;
  text: string;
  /** Raw key from the row, or `unknown` when the column is empty. */
  speaker: string;
  /** Display name: the raw key unless a non-placeholder `speakerName` exists. */
  label: string;
  speaker_name: string | null;
  speaker_is_placeholder: boolean;
  speaker_status: string | null;
  source: string | null;
  /** Seconds from the first segment of the whole transcript, or `null`. */
  t_rel: number | null;
}

export interface MergedSegment {
  speaker: string;
  label: string;
  source: string | null;
  text: string;
  t_rel: number | null;
  /** `t_rel` of the last segment folded in — an observed time, never a guess. */
  t_rel_last: number | null;
  segment_count: number;
  first_index: number;
}

export interface MergeOptions {
  minTs: number | null;
  unit: TimeUnit;
  /** A pause longer than this ends the block even for the same speaker. */
  maxGapSeconds?: number;
  /** Upper bound on the characters one block may hold. */
  maxChars?: number;
}

export interface SpeakerStat {
  speaker: string;
  segments: number;
  words: number;
  first_t_rel: number | null;
  last_t_rel: number | null;
  /** Share of the spoken words, one decimal. Rounding may leave the sum off 100. */
  share_pct: number;
}

/** Target size of one chunk of legacy flat text. */
export const CHUNK_CHARS = 2000;

/** Default cap on a merged block; keeps a monologue from becoming one huge line. */
export const DEFAULT_BLOCK_CHARS = 2000;

const PARAGRAPH_BREAK = /\n{2,}/;
const PARAGRAPH_JOIN = '\n\n';

const UNKNOWN_SPEAKER = 'unknown';

const HOUR_SECONDS = 3600;
const MINUTE_SECONDS = 60;

function textOf(segment: RawTranscriptSegment): string {
  return typeof segment.text === 'string' ? segment.text : '';
}

function speakerKeyOf(segment: RawTranscriptSegment): string {
  const raw = typeof segment.speaker === 'string' ? segment.speaker.trim() : '';
  return raw === '' ? UNKNOWN_SPEAKER : raw;
}

function timestampOf(segment: RawTranscriptSegment): number | null {
  const raw = segment.timestamp;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * Splits `notes.transcript` into the shape the tools work with. A missing
 * transcript is an empty result rather than an error — most notes have none.
 */
export function parseTranscript(raw: string | null | undefined): ParsedTranscript {
  // The kind discriminator lives in `projections` and both tools must agree on
  // it; it hands back the parsed array so 240 KB is not parsed a second time.
  const column = readTranscriptColumn(raw);
  if (column.kind === null) return { kind: null, segments: [], chunks: [] };

  const text = raw as string;
  if (column.kind === 'json') {
    const parsed = column.entries ?? [];
    const segments = parsed.filter(isRecord) as RawTranscriptSegment[];
    const skipped = parsed.length - segments.length;
    const result: ParsedTranscript = { kind: 'json', segments, chunks: [] };
    if (skipped > 0) {
      result.warning = `${skipped} transcript entries were not objects and were skipped.`;
    }
    return result;
  }

  const result: ParsedTranscript = { kind: 'plain', segments: [], chunks: chunkText(text) };
  if (text.trimStart().startsWith('[')) {
    result.warning =
      'This transcript starts like a JSON array but does not parse — most likely a truncated write. It is served as flat text.';
  }
  return result;
}

/**
 * Packs whole paragraphs into chunks of at most `maxChars`. A paragraph that
 * does not fit on its own is cut on a fixed boundary; there is nothing better
 * to cut on, and losing the tail would be worse than an awkward split.
 */
export function chunkText(text: string, maxChars: number = CHUNK_CHARS): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(PARAGRAPH_BREAK)) {
    const trimmed = paragraph.trim();
    if (trimmed === '') continue;
    for (let at = 0; at < trimmed.length; at += maxChars) {
      units.push(trimmed.slice(at, at + maxChars));
    }
  }

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current === '') {
      current = unit;
    } else if (current.length + PARAGRAPH_JOIN.length + unit.length <= maxChars) {
      current += PARAGRAPH_JOIN + unit;
    } else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * Smallest timestamp across the segments — the zero point of `t_rel`.
 *
 * It must be taken over the whole transcript, never over a page: a second page
 * computed against its own minimum would restart the clock at zero.
 */
export function minTimestamp(segments: RawTranscriptSegment[]): number | null {
  let min: number | null = null;
  for (const segment of segments) {
    const ts = timestampOf(segment);
    if (ts !== null && (min === null || ts < min)) min = ts;
  }
  return min;
}

/**
 * `minTs > 1e9` is epoch seconds, not milliseconds — this is exactly where the
 * app's heuristic divides seconds by 1000.
 */
export function detectTimeUnit(minTs: number): TimeUnit {
  if (minTs > EPOCH_MS_FLOOR) return 'ms';
  if (minTs > EPOCH_S_FLOOR) return 's';
  return 'relative';
}

export function toRelativeSeconds(ts: number, minTs: number, unit: TimeUnit): number {
  const delta = ts - minTs;
  return round3(unit === 'ms' ? delta / 1000 : delta);
}

export function normalizeSegments(
  segments: RawTranscriptSegment[],
  minTs: number | null,
  unit: TimeUnit,
): NormalizedSegment[] {
  return segments.map((segment, index) => {
    const ts = timestampOf(segment);
    const speaker = speakerKeyOf(segment);
    const name = typeof segment.speakerName === 'string' && segment.speakerName.trim() !== ''
      ? segment.speakerName
      : null;
    // A placeholder name (`Speaker 2`) is noise; the raw key at least stays stable.
    const usable = name !== null && segment.speakerIsPlaceholder !== true;
    return {
      index,
      text: textOf(segment),
      speaker,
      label: usable ? name : speaker,
      speaker_name: name,
      speaker_is_placeholder: segment.speakerIsPlaceholder === true,
      speaker_status: typeof segment.speakerStatus === 'string' ? segment.speakerStatus : null,
      source: typeof segment.source === 'string' ? segment.source : null,
      t_rel: ts === null || minTs === null ? null : toRelativeSeconds(ts, minTs, unit),
    };
  });
}

/**
 * Folds a run of segments from one speaker into a single block. Diarization
 * emits a segment per utterance, so 836 raw segments are perhaps 80 turns.
 */
export function mergeConsecutive(
  segments: RawTranscriptSegment[],
  opts: MergeOptions,
): MergedSegment[] {
  const maxChars = opts.maxChars ?? DEFAULT_BLOCK_CHARS;
  const maxGap = opts.maxGapSeconds ?? Number.POSITIVE_INFINITY;
  const blocks: MergedSegment[] = [];

  for (const segment of normalizeSegments(segments, opts.minTs, opts.unit)) {
    const text = segment.text.trim();
    if (text === '') continue;

    const open = blocks[blocks.length - 1];
    const gap =
      open && open.t_rel_last !== null && segment.t_rel !== null
        ? segment.t_rel - open.t_rel_last
        : 0;
    const extendable =
      open !== undefined &&
      open.speaker === segment.speaker &&
      open.source === segment.source &&
      gap <= maxGap &&
      open.text.length + 1 + text.length <= maxChars;

    if (extendable) {
      open.text += ` ${text}`;
      open.t_rel_last = segment.t_rel ?? open.t_rel_last;
      open.segment_count += 1;
      continue;
    }

    blocks.push({
      speaker: segment.speaker,
      label: segment.label,
      source: segment.source,
      text,
      t_rel: segment.t_rel,
      t_rel_last: segment.t_rel,
      segment_count: 1,
      first_index: segment.index,
    });
  }

  return blocks;
}

/** `mm:ss`, or `h:mm:ss` past the hour. `--:--` when the segment has no time. */
export function formatClock(tRel: number | null): string {
  if (tRel === null || !Number.isFinite(tRel) || tRel < 0) return '--:--';
  const total = Math.floor(tRel);
  const seconds = String(total % MINUTE_SECONDS).padStart(2, '0');
  const minutes = Math.floor(total / MINUTE_SECONDS) % MINUTE_SECONDS;
  if (total < HOUR_SECONDS) return `${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${Math.floor(total / HOUR_SECONDS)}:${String(minutes).padStart(2, '0')}:${seconds}`;
}

/**
 * Renders blocks as `[mm:ss] speaker: text`, cutting on a line boundary so the
 * agent never has to reason about half a sentence.
 */
export function renderText(
  segments: MergedSegment[],
  opts: { maxChars: number },
): { text: string; truncated: boolean } {
  const lines = segments.map(
    (block) => `[${formatClock(block.t_rel)}] ${block.label}: ${block.text}`,
  );
  const full = lines.join('\n');
  if (full.length <= opts.maxChars) return { text: full, truncated: false };

  let kept = '';
  for (const line of lines) {
    const next = kept === '' ? line : `${kept}\n${line}`;
    if (next.length > opts.maxChars) break;
    kept = next;
  }
  // A single line longer than the whole budget still has to yield something.
  if (kept === '') kept = full.slice(0, opts.maxChars);
  return { text: kept, truncated: true };
}

/**
 * Per-speaker totals. Cheap enough to compute over every segment, which is the
 * point: it answers "who is in this recording" without paging through 836 rows.
 */
export function speakerStats(
  segments: RawTranscriptSegment[],
  minTs: number | null,
  unit: TimeUnit,
): SpeakerStat[] {
  const bySpeaker = new Map<string, SpeakerStat>();
  let totalWords = 0;

  for (const segment of normalizeSegments(segments, minTs, unit)) {
    let stat = bySpeaker.get(segment.speaker);
    if (!stat) {
      stat = {
        speaker: segment.speaker,
        segments: 0,
        words: 0,
        first_t_rel: null,
        last_t_rel: null,
        share_pct: 0,
      };
      bySpeaker.set(segment.speaker, stat);
    }

    const words = countWords(segment.text);
    stat.segments += 1;
    stat.words += words;
    totalWords += words;
    if (segment.t_rel !== null) {
      if (stat.first_t_rel === null || segment.t_rel < stat.first_t_rel) {
        stat.first_t_rel = segment.t_rel;
      }
      if (stat.last_t_rel === null || segment.t_rel > stat.last_t_rel) {
        stat.last_t_rel = segment.t_rel;
      }
    }
  }

  const stats = [...bySpeaker.values()];
  for (const stat of stats) {
    // Deliberately not normalised to sum to 100: a fudged last row would be a lie.
    stat.share_pct = totalWords === 0 ? 0 : Math.round((stat.words / totalWords) * 1000) / 10;
  }

  return stats.sort((a, b) => {
    if (a.first_t_rel === b.first_t_rel) return a.speaker.localeCompare(b.speaker);
    if (a.first_t_rel === null) return 1;
    if (b.first_t_rel === null) return -1;
    return a.first_t_rel - b.first_t_rel;
  });
}
