import { describe, expect, it } from 'vitest';

import { renderTranscriptDoc } from '../../../src/domain/transcriptDoc.js';
import {
  EMPTY_NOTE,
  MERGE_NOTE,
  NO_TIME_NOTE,
  PLAIN_NOTE,
  SPEAKER_NAMES_NOTE,
  TIME_NOTES,
} from '../../../src/domain/transcriptNotes.js';
import {
  BASE_EPOCH_MS,
  LEGACY_PLAIN_TRANSCRIPT,
  epochSecondSegments,
  jsonTranscript,
  makeSegment,
  twoSpeakerSegments,
} from '../../fixtures/transcripts.js';

const BIG = 400_000;

function doc(transcript: string | null, maxChars = BIG): { text: string; truncated: boolean } {
  return renderTranscriptDoc(
    {
      noteId: 13,
      title: 'Weekly sync',
      noteType: 'meeting',
      updatedAt: '2026-09-08T08:31:48Z',
      transcript,
    },
    { maxChars },
  );
}

describe('renderTranscriptDoc on a diarized transcript', () => {
  it('opens with the note title and the header facts', () => {
    const { text, truncated } = doc(jsonTranscript(twoSpeakerSegments(6)));

    expect(truncated).toBe(false);
    expect(text.startsWith('# Weekly sync — transcript\n')).toBe(true);
    expect(text).toContain('- note_id: 13');
    expect(text).toContain('- note_type: meeting');
    expect(text).toContain('- updated_at: 2026-09-08T08:31:48Z');
    expect(text).toContain('- segments: 6');
    expect(text).toContain('- time_unit: ms');
  });

  it('names the note by id when it has no title', () => {
    const { text } = renderTranscriptDoc(
      {
        noteId: 7,
        title: null,
        noteType: null,
        updatedAt: null,
        transcript: jsonTranscript(twoSpeakerSegments(2)),
      },
      { maxChars: BIG },
    );
    expect(text.startsWith('# Note 7 — transcript\n')).toBe(true);
    expect(text).toContain('- note_type: null');
    expect(text).toContain('- updated_at: null');
  });

  it('tabulates the speakers with segments, words and share', () => {
    const { text } = doc(jsonTranscript(twoSpeakerSegments(6)));

    expect(text).toContain('## Speakers');
    expect(text).toContain('| speaker | segments | words | share |');
    // Both speakers say three of the six lines, so the split is even.
    expect(text).toMatch(/\| you \| 3 \| \d+ \| 50%/);
    expect(text).toMatch(/\| speaker_0 \| 3 \| \d+ \| 50%/);
  });

  it('carries the same caveats the tool returns', () => {
    const { text } = doc(jsonTranscript(twoSpeakerSegments(6)));

    expect(text).toContain(`> ${SPEAKER_NAMES_NOTE}`);
    expect(text).toContain(`> ${MERGE_NOTE}`);
    expect(text).toContain(`> ${TIME_NOTES.ms}`);
  });

  it('renders the body as clock-stamped speaker lines under one heading', () => {
    const { text } = doc(jsonTranscript(twoSpeakerSegments(6)));
    const body = text.slice(text.indexOf('## Transcript'));

    // `You` is flagged as a placeholder name, so the raw key stays the label.
    expect(body).toContain('[00:00] you: Line 1');
    expect(body).toContain('[00:05] speaker_0: Line 2');
    expect(body).toContain('[00:25] speaker_0: Line 6');
    // Six segments alternate speaker, so nothing merges: six lines.
    expect(body.match(/^\[\d\d:\d\d\]/gm)).toHaveLength(6);
  });

  it('reports epoch seconds as seconds rather than milliseconds', () => {
    // 40-second steps, so each segment opens its own line rather than merging:
    // read as milliseconds the last clock would be [00:00], not [02:00].
    const { text } = doc(jsonTranscript(epochSecondSegments(4, 40)));
    expect(text).toContain('- time_unit: s');
    expect(text).toContain(`> ${TIME_NOTES.s}`);
    expect(text).toContain('[02:00] you: Second-based line 4.');
  });
});

describe('renderTranscriptDoc on the other shapes of the column', () => {
  it('says a note without a transcript is not a failure', () => {
    const { text, truncated } = doc(null);

    expect(truncated).toBe(false);
    expect(text).toContain('- segments: 0');
    expect(text).toContain('- time_unit: null');
    expect(text).toContain(`> ${EMPTY_NOTE}`);
    expect(text).not.toContain('## Transcript');
    expect(text).not.toContain('## Speakers');
  });

  it('serves legacy flat text as-is and says so', () => {
    const { text, truncated } = doc(LEGACY_PLAIN_TRANSCRIPT);

    expect(truncated).toBe(false);
    expect(text).toContain(`> ${PLAIN_NOTE}`);
    expect(text).toContain('## Transcript');
    expect(text).toContain('This is a legacy transcript stored as plain text.');
    expect(text).toContain('It has paragraphs but no speaker information at all.');
    // No diarization means no speaker table and no merge caveat to give.
    expect(text).not.toContain('## Speakers');
    expect(text).not.toContain(MERGE_NOTE);
  });

  it('keeps "no timestamps" apart from "timestamps that are already relative"', () => {
    const segments = [0, 1, 2].map((i) =>
      makeSegment({ text: `Untimed line ${i + 1}.`, timestamp: null as unknown as number }),
    );
    const { text } = doc(jsonTranscript(segments));

    expect(text).toContain('- time_unit: null');
    expect(text).toContain(`> ${NO_TIME_NOTE}`);
    expect(text).toContain('[--:--] you: Untimed line 1.');
  });
});

describe('renderTranscriptDoc truncation', () => {
  const long = jsonTranscript(
    Array.from({ length: 400 }, (_, i) =>
      makeSegment({
        text: `Line ${i + 1} of a long meeting with a fair number of words in it.`,
        timestamp: BASE_EPOCH_MS + i * 31_000,
      }),
    ),
  );

  it('stays whole while it fits', () => {
    const { text, truncated } = renderTranscriptDoc(
      { noteId: 13, title: 'Long one', noteType: 'meeting', updatedAt: null, transcript: long },
      { maxChars: BIG },
    );
    expect(truncated).toBe(false);
    expect(text).not.toContain('Truncated');
    expect(text).toContain('Line 400 of a long meeting');
  });

  it('cuts inside the budget and says where to read the rest', () => {
    const maxChars = 6_000;
    const { text, truncated } = renderTranscriptDoc(
      { noteId: 13, title: 'Long one', noteType: 'meeting', updatedAt: null, transcript: long },
      { maxChars },
    );

    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(maxChars);
    expect(text).toMatch(/> Truncated at /);
    expect(text).toContain('format="segments"');
    expect(text).toContain('note_id: 13');
    // Cut on a line boundary: the last transcript line is whole.
    const lines = text.split('\n').filter((line) => line.startsWith('['));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines[lines.length - 1]).toMatch(/words in it\.$/);
  });

  it('still answers when the budget cannot even hold the header', () => {
    const { text, truncated } = renderTranscriptDoc(
      { noteId: 13, title: 'Long one', noteType: 'meeting', updatedAt: null, transcript: long },
      { maxChars: 40 },
    );
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.startsWith('# Long one — transcript')).toBe(true);
  });

  it('truncates flat text too', () => {
    const { text, truncated } = doc('x'.repeat(50_000), 5_000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(5_000);
    expect(text).toMatch(/> Truncated at /);
  });
});
