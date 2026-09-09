import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeHttpError, ToolError } from '../../bridge/errors.js';
import type { RawNote } from '../../bridge/types.js';
import type { BridgeRoutes, ToolDeps } from '../../deps.js';
import { toIsoZ } from '../../domain/dates.js';
import {
  DEFAULT_BLOCK_CHARS,
  detectTimeUnit,
  mergeConsecutive,
  minTimestamp,
  normalizeSegments,
  parseTranscript,
  renderText,
  speakerStats,
  type NormalizedSegment,
  type SpeakerStat,
  type TimeUnit,
  type TranscriptKind,
} from '../../domain/transcript.js';
import {
  DEFAULT_SEGMENT_LIMIT,
  DEFAULT_SEGMENT_OFFSET,
  getNoteTranscriptSchema,
  type TranscriptFormat,
} from '../../schemas/transcript.js';
import { defineTool } from '../defineTool.js';

/** Hard cap on the rendered `text` format, well below the result-size cap. */
const TEXT_MAX_CHARS = 20_000;

/**
 * A same-speaker run is one turn while the pauses inside it stay short; past
 * this it is a new turn. Segments carry no `end`, so the gap is measured
 * start-to-start and the threshold is deliberately generous.
 */
const MERGE_GAP_SECONDS = 30;

/** Two real notes hold 58 KB and 240 KB of transcript; a page must stay far below that. */
const MAX_RESULT_CHARS = 250_000;

const DESCRIPTION =
  "Read a note's transcript. format=segments pages diarized segments with times relative to the " +
  'recording start (offset/limit, speaker/source filters); format=text renders "[mm:ss] speaker: …" ' +
  'lines; format=speakers gives per-speaker totals only — use it first on long recordings. ' +
  'A note with no transcript returns an empty result, not an error.';

const SPEAKER_NAMES_NOTE =
  'Speaker labels come from the transcript itself. Readable names live in the app\'s speaker_mappings table, which the CLI bridge does not expose, so speaker and speaker_name may be placeholders such as speaker_0.';

const PLAIN_NOTE =
  'This transcript is legacy flat text: no speaker labels and no timestamps. It is served as chunks of about 2000 characters, paged with offset/limit.';

const EMPTY_NOTE =
  'This note has no transcript. Only recordings produce one; a note written by hand never has it, and that is not an error.';

const FILTERED_TEXT_NOTE =
  'Only the segments matching the filter were rendered, so two consecutive lines were not necessarily consecutive in the recording. Compare filtered_segments with total_segments.';

const TIME_NOTES: Record<TimeUnit, string> = {
  ms: 'Segment timestamps are epoch milliseconds; t_rel is seconds from the first segment of the whole transcript.',
  s: 'Segment timestamps are epoch seconds; t_rel is seconds from the first segment. The app\'s own UI mistakes these for milliseconds and shows offsets 1000x too small.',
  relative:
    'Segment timestamps are already relative to the start of the recording; t_rel is seconds from the first segment.',
};

/**
 * "No timestamps at all" and "timestamps that are already relative" are two
 * different facts, and `detectTimeUnit(0)` collapses them into the second one —
 * which then reads as a broken server when every `t_rel` comes back null.
 */
const NO_TIME_NOTE =
  'Not one segment in this transcript carries a timestamp, so time_unit is null and t_rel, t_rel_next and the per-speaker times are null throughout; rendered lines show --:--. That is what the recording stored, not a failure to read it.';

/**
 * `format:"text"` is the only place where segments are folded together, so the
 * three thresholds that decide it have to be visible: without them a caller
 * counts the rendered lines and reports them as turns of the conversation.
 */
const MERGE_NOTE =
  `Rendered lines are not diarization turns. Consecutive segments are folded into one line only while the speaker is the same, source (mic/system) is the same, the start-to-start gap stays under merge_gap_seconds and the line stays under merge_max_chars — so the line count is an artifact of these three thresholds. Use format=segments for the raw segments.`;

const NOT_FOUND_HINT =
  'Note ids come from list_notes, search_notes or get_note. A deleted note stays invisible to the bridge.';

const CHANGED_HINT =
  'Offset paging over a note that was re-recorded or edited would skip or duplicate segments. Read again from offset 0 and pass the fresh note_updated_at.';

interface SegmentView {
  index: number;
  t_rel: number | null;
  /** `t_rel` of the next segment in the full transcript; `null` on the last one. */
  t_rel_next: number | null;
  speaker: string;
  speaker_name: string | null;
  speaker_is_placeholder: boolean;
  speaker_status: string | null;
  source: string | null;
  text: string;
}

interface TranscriptPayload {
  note_id: number;
  note_title: string | null;
  note_updated_at: string | null;
  kind: TranscriptKind;
  format: TranscriptFormat;
  time_unit: TimeUnit | null;
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

async function readNote(routes: BridgeRoutes, id: number): Promise<RawNote> {
  try {
    return await routes.getNote(id);
  } catch (err) {
    if (err instanceof BridgeHttpError && err.status === 404) {
      throw new ToolError('not_found', `there is no note with id ${id}`, { hint: NOT_FOUND_HINT });
    }
    throw err;
  }
}

/**
 * The caller pages by offset, so a note that changed between two pages would
 * silently shift the window. Both sides are normalised first: the agent may
 * echo back either the ISO stamp we returned or the raw SQLite one.
 */
function assertUnchanged(expected: string | undefined, actual: string | null): void {
  if (expected === undefined) return;
  const normalised = toIsoZ(expected) ?? expected.trim();
  if (normalised === (actual ?? '')) return;
  throw new ToolError('transcript_changed', 'transcript changed, restart from offset 0', {
    hint: CHANGED_HINT,
    details: { expected_updated_at: expected, note_updated_at: actual },
  });
}

function pageOf<T>(items: T[], offset: number, limit: number): { page: T[]; hasMore: boolean } {
  const page = items.slice(offset, offset + limit);
  return { page, hasMore: offset + page.length < items.length };
}

export function registerGetNoteTranscript(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'get_note_transcript',
    title: 'Read a note transcript',
    description: DESCRIPTION,
    schema: getNoteTranscriptSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    maxResultChars: MAX_RESULT_CHARS,
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        const note = await readNote(routes, args.note_id);
        const updatedAt = toIsoZ(note.updated_at);
        assertUnchanged(args.expect_updated_at, updatedAt);

        const parsed = parseTranscript(typeof note.transcript === 'string' ? note.transcript : null);
        const offset = args.offset ?? DEFAULT_SEGMENT_OFFSET;
        const limit = args.limit ?? DEFAULT_SEGMENT_LIMIT;

        const payload: TranscriptPayload = {
          note_id: args.note_id,
          note_title: typeof note.title === 'string' ? note.title : null,
          note_updated_at: updatedAt,
          kind: parsed.kind,
          format: args.format,
          time_unit: null,
          total_segments: parsed.segments.length,
          speaker_names_note: SPEAKER_NAMES_NOTE,
        };
        if (parsed.warning) payload.warning = parsed.warning;

        if (parsed.kind === null) return withEmpty(payload, args.format, offset, limit);
        if (parsed.kind === 'plain') {
          return withPlain(payload, parsed.chunks, args.format, offset, limit);
        }

        // Taken over every segment, never over the page: a per-page minimum
        // would restart the clock at zero on the second page.
        const minTs = minTimestamp(parsed.segments);
        // `relative` is only a placeholder for the arithmetic below: with no
        // minimum every t_rel is null whatever the unit, so it is never reported.
        const unit: TimeUnit = minTs === null ? 'relative' : detectTimeUnit(minTs);
        payload.time_unit = minTs === null ? null : unit;
        payload.time_note = minTs === null ? NO_TIME_NOTE : TIME_NOTES[unit];

        const normalized = normalizeSegments(parsed.segments, minTs, unit);
        const kept = normalized.filter((segment) => matches(segment, args.speaker, args.source));

        if (args.format === 'speakers') {
          payload.speakers = speakerStats(parsed.segments, minTs, unit);
          return payload;
        }

        if (args.format === 'text') {
          const blocks = mergeConsecutive(
            kept.map((segment) => parsed.segments[segment.index]!),
            {
              minTs,
              unit,
              maxGapSeconds: MERGE_GAP_SECONDS,
              // Passed rather than left to default, so the reported numbers are
              // the ones that actually shaped the text.
              maxChars: DEFAULT_BLOCK_CHARS,
            },
          );
          const rendered = renderText(blocks, { maxChars: TEXT_MAX_CHARS });
          if (kept.length !== normalized.length) payload.notice = FILTERED_TEXT_NOTE;
          payload.filtered_segments = kept.length;
          payload.text = rendered.text;
          payload.truncated = rendered.truncated;
          payload.max_chars = TEXT_MAX_CHARS;
          payload.merge_note = MERGE_NOTE;
          payload.merge_gap_seconds = MERGE_GAP_SECONDS;
          payload.merge_max_chars = DEFAULT_BLOCK_CHARS;
          return payload;
        }

        const { page, hasMore } = pageOf(kept, offset, limit);
        payload.filtered_segments = kept.length;
        payload.offset = offset;
        payload.limit = limit;
        payload.has_more = hasMore;
        payload.next_offset = hasMore ? offset + page.length : null;
        payload.segments = page.map((segment) => ({
          index: segment.index,
          t_rel: segment.t_rel,
          t_rel_next: normalized[segment.index + 1]?.t_rel ?? null,
          speaker: segment.speaker,
          speaker_name: segment.speaker_name,
          speaker_is_placeholder: segment.speaker_is_placeholder,
          speaker_status: segment.speaker_status,
          source: segment.source,
          text: segment.text,
        }));
        return payload;
      }),
  });
}

function matches(
  segment: NormalizedSegment,
  speaker: string | undefined,
  source: string | undefined,
): boolean {
  // The agent may have seen either the raw key or the resolved label.
  if (speaker !== undefined && segment.speaker !== speaker && segment.label !== speaker) return false;
  if (source !== undefined && segment.source !== source) return false;
  return true;
}

function withEmpty(
  payload: TranscriptPayload,
  format: TranscriptFormat,
  offset: number,
  limit: number,
): TranscriptPayload {
  payload.notice = EMPTY_NOTE;
  if (format === 'speakers') payload.speakers = [];
  else if (format === 'text') {
    payload.text = '';
    payload.truncated = false;
    payload.max_chars = TEXT_MAX_CHARS;
  } else {
    payload.segments = [];
    payload.filtered_segments = 0;
    payload.offset = offset;
    payload.limit = limit;
    payload.has_more = false;
    payload.next_offset = null;
  }
  return payload;
}

function withPlain(
  payload: TranscriptPayload,
  chunks: string[],
  format: TranscriptFormat,
  offset: number,
  limit: number,
): TranscriptPayload {
  payload.notice = PLAIN_NOTE;
  payload.total_chunks = chunks.length;

  if (format === 'speakers') {
    payload.speakers = [];
    return payload;
  }
  if (format === 'text') {
    const full = chunks.join('\n\n');
    payload.text = full.slice(0, TEXT_MAX_CHARS);
    payload.truncated = full.length > TEXT_MAX_CHARS;
    payload.max_chars = TEXT_MAX_CHARS;
    return payload;
  }

  const { page, hasMore } = pageOf(chunks, offset, limit);
  payload.segments = [];
  payload.chunks = page;
  payload.offset = offset;
  payload.limit = limit;
  payload.has_more = hasMore;
  payload.next_offset = hasMore ? offset + page.length : null;
  return payload;
}
