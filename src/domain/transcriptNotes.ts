import type { TimeUnit } from './transcript.js';

/**
 * The caveats a transcript reader has to be told about, in one place.
 *
 * Both `get_note_transcript` and the transcript resource render the same rows
 * with the same three thresholds, so both owe the reader the same warnings.
 * Duplicating the wording would let the two drift until the tool and the
 * resource disagreed about what the numbers mean.
 */

export const SPEAKER_NAMES_NOTE =
  'Speaker labels come from the transcript itself. Readable names live in the app\'s speaker_mappings table, which the CLI bridge does not expose, so speaker and speaker_name may be placeholders such as speaker_0.';

export const PLAIN_NOTE =
  'This transcript is legacy flat text: no speaker labels and no timestamps. It is served as chunks of about 2000 characters, paged with offset/limit.';

export const EMPTY_NOTE =
  'This note has no transcript. Only recordings produce one; a note written by hand never has it, and that is not an error.';

export const TIME_NOTES: Record<TimeUnit, string> = {
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
export const NO_TIME_NOTE =
  'Not one segment in this transcript carries a timestamp, so time_unit is null and t_rel, t_rel_next and the per-speaker times are null throughout; rendered lines show --:--. That is what the recording stored, not a failure to read it.';

/**
 * Rendering is the only place where segments are folded together, so the three
 * thresholds that decide it have to be visible: without them a caller counts the
 * rendered lines and reports them as turns of the conversation.
 */
export const MERGE_NOTE =
  `Rendered lines are not diarization turns. Consecutive segments are folded into one line only while the speaker is the same, source (mic/system) is the same, the start-to-start gap stays under merge_gap_seconds and the line stays under merge_max_chars — so the line count is an artifact of these three thresholds. Use format=segments for the raw segments.`;

/**
 * A same-speaker run is one turn while the pauses inside it stay short; past
 * this it is a new turn. Segments carry no `end`, so the gap is measured
 * start-to-start and the threshold is deliberately generous.
 */
export const MERGE_GAP_SECONDS = 30;
