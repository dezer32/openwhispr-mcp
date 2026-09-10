import {
  DEFAULT_BLOCK_CHARS,
  detectTimeUnit,
  mergeConsecutive,
  minTimestamp,
  parseTranscript,
  renderText,
  speakerStats,
  type SpeakerStat,
  type TimeUnit,
} from './transcript.js';
import {
  EMPTY_NOTE,
  MERGE_GAP_SECONDS,
  MERGE_NOTE,
  NO_TIME_NOTE,
  PLAIN_NOTE,
  SPEAKER_NAMES_NOTE,
  TIME_NOTES,
} from './transcriptNotes.js';

/**
 * Renders one note's transcript as a single markdown document.
 *
 * This exists because `get_note_transcript` cannot hand over a whole meeting:
 * `format:"text"` stops at 20 000 characters and `format:"segments"` needs seven
 * to nine paged calls for a real recording. The document is the same data with
 * the same caveats, assembled once so it can be read in one go.
 *
 * Pure by design — the resource layer does the I/O and passes the row in, which
 * is what makes every branch below testable without a bridge.
 */

export interface TranscriptDocInput {
  noteId: number;
  title: string | null;
  noteType: string | null;
  /** Already normalised to UTC ISO by the caller; printed verbatim. */
  updatedAt: string | null;
  /** The raw `notes.transcript` column. */
  transcript: string | null;
}

export interface TranscriptDoc {
  text: string;
  truncated: boolean;
}

/** `mm:ss` prefixes and pipes in a speaker key must not break the markdown table. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function speakersTable(stats: SpeakerStat[]): string {
  const rows = stats.map(
    (stat) => `| ${cell(stat.speaker)} | ${stat.segments} | ${stat.words} | ${stat.share_pct}% |`,
  );
  return [
    '## Speakers',
    '',
    '| speaker | segments | words | share |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function truncationMarker(maxChars: number, noteId: number): string {
  return (
    `> Truncated at ${maxChars} characters, the cap on one resource read — the transcript continues ` +
    `past this point. Read the rest with get_note_transcript(note_id: ${noteId}, format="segments").`
  );
}

export function renderTranscriptDoc(
  input: TranscriptDocInput,
  opts: { maxChars: number },
): TranscriptDoc {
  const parsed = parseTranscript(input.transcript);

  // Taken over the whole transcript: a minimum computed over part of it would
  // restart the clock partway through the document.
  const minTs = minTimestamp(parsed.segments);
  // `relative` is only a placeholder for the arithmetic: with no minimum every
  // t_rel is null whatever the unit, so it is never reported as the unit.
  const unit: TimeUnit = minTs === null ? 'relative' : detectTimeUnit(minTs);
  const reportedUnit = minTs === null ? null : unit;

  const sections: string[] = [
    `# ${input.title?.trim() || `Note ${input.noteId}`} — transcript`,
    [
      `- note_id: ${input.noteId}`,
      `- note_type: ${input.noteType ?? 'null'}`,
      `- updated_at: ${input.updatedAt ?? 'null'}`,
      `- segments: ${parsed.segments.length}`,
      `- time_unit: ${reportedUnit ?? 'null'}`,
    ].join('\n'),
  ];

  let body = '';
  let cut: (budget: number) => string = () => '';

  if (parsed.kind === null) {
    sections.push(`> ${EMPTY_NOTE}`);
  } else if (parsed.kind === 'plain') {
    sections.push(`> ${PLAIN_NOTE}`);
    body = parsed.chunks.join('\n\n');
    // Flat text has no lines to cut on — a fixed boundary is all there is.
    cut = (budget) => body.slice(0, budget);
  } else {
    sections.push(speakersTable(speakerStats(parsed.segments, minTs, unit)));
    sections.push(`> ${SPEAKER_NAMES_NOTE}`);
    sections.push(`> ${minTs === null ? NO_TIME_NOTE : TIME_NOTES[unit]}`);
    sections.push(`> ${MERGE_NOTE}`);

    const blocks = mergeConsecutive(parsed.segments, {
      minTs,
      unit,
      maxGapSeconds: MERGE_GAP_SECONDS,
      // Passed rather than left to the default so the document is shaped by the
      // same thresholds MERGE_NOTE names.
      maxChars: DEFAULT_BLOCK_CHARS,
    });
    body = renderText(blocks, { maxChars: Number.POSITIVE_INFINITY }).text;
    cut = (budget) => renderText(blocks, { maxChars: budget }).text;
  }

  if (parsed.warning) sections.push(`> ${parsed.warning}`);
  if (body !== '') sections.push('## Transcript');

  const prefix = sections.join('\n\n') + (body === '' ? '\n' : '\n\n');
  const full = prefix + body;
  if (full.length <= opts.maxChars) return { text: full, truncated: false };

  const marker = truncationMarker(opts.maxChars, input.noteId);
  const budget = opts.maxChars - prefix.length - marker.length - 2;
  // A budget this small means the header alone overflows — nothing is left to
  // cut on a boundary, and a hard slice is still more useful than an error.
  if (budget <= 0) return { text: full.slice(0, opts.maxChars), truncated: true };
  return { text: `${prefix}${cut(budget)}\n\n${marker}`, truncated: true };
}
