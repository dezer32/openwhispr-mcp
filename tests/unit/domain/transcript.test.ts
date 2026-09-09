import { describe, expect, it, vi } from 'vitest';

import {
  CHUNK_CHARS,
  detectTimeUnit,
  mergeConsecutive,
  minTimestamp,
  normalizeSegments,
  parseTranscript,
  renderText,
  speakerStats,
  toRelativeSeconds,
} from '../../../src/domain/transcript.js';
import {
  BASE_EPOCH_MS,
  BROKEN_JSON_TRANSCRIPT,
  LEGACY_PLAIN_TRANSCRIPT,
  epochSecondSegments,
  jsonTranscript,
  makeSegment,
  relativeSegments,
  twoSpeakerSegments,
} from '../../fixtures/transcripts.js';

const BASE_EPOCH_S = Math.floor(BASE_EPOCH_MS / 1000);

describe('detectTimeUnit', () => {
  it('reads epoch milliseconds as ms', () => {
    expect(detectTimeUnit(BASE_EPOCH_MS)).toBe('ms');
  });

  it('reads epoch seconds as s — the value the app itself divides by 1000', () => {
    expect(detectTimeUnit(BASE_EPOCH_S)).toBe('s');
  });

  it('reads small values as already relative', () => {
    expect(detectTimeUnit(0)).toBe('relative');
    expect(detectTimeUnit(5)).toBe('relative');
    expect(detectTimeUnit(3_600)).toBe('relative');
  });

  it('puts the boundaries exactly where the doc says', () => {
    expect(detectTimeUnit(1e11)).toBe('s');
    expect(detectTimeUnit(1e11 + 1)).toBe('ms');
    expect(detectTimeUnit(1e9)).toBe('relative');
    expect(detectTimeUnit(1e9 + 1)).toBe('s');
  });
});

describe('toRelativeSeconds', () => {
  it('converts epoch milliseconds to seconds from the first segment', () => {
    expect(toRelativeSeconds(BASE_EPOCH_MS + 5_000, BASE_EPOCH_MS, 'ms')).toBe(5);
    expect(toRelativeSeconds(BASE_EPOCH_MS, BASE_EPOCH_MS, 'ms')).toBe(0);
  });

  it('does NOT divide epoch seconds by 1000 — the app heuristic is wrong here', () => {
    // The app treats anything above 1e9 as milliseconds, so 15 seconds becomes 0.015.
    expect(toRelativeSeconds(BASE_EPOCH_S + 15, BASE_EPOCH_S, 's')).toBe(15);
  });

  it('passes already-relative values through as a plain difference', () => {
    expect(toRelativeSeconds(20, 0, 'relative')).toBe(20);
    expect(toRelativeSeconds(20, 5, 'relative')).toBe(15);
  });

  it('rounds away binary-float noise', () => {
    expect(toRelativeSeconds(BASE_EPOCH_MS + 1, BASE_EPOCH_MS, 'ms')).toBe(0.001);
  });
});

describe('minTimestamp', () => {
  it('takes the minimum over every segment, not the first one', () => {
    const segments = [
      makeSegment({ timestamp: BASE_EPOCH_MS + 9_000 }),
      makeSegment({ timestamp: BASE_EPOCH_MS }),
      makeSegment({ timestamp: BASE_EPOCH_MS + 4_000 }),
    ];
    expect(minTimestamp(segments)).toBe(BASE_EPOCH_MS);
  });

  it('ignores segments whose timestamp is missing or not a finite number', () => {
    const segments = [
      makeSegment({ timestamp: null }),
      makeSegment({ timestamp: Number.NaN }),
      makeSegment({ timestamp: BASE_EPOCH_MS + 1_000 }),
    ];
    expect(minTimestamp(segments)).toBe(BASE_EPOCH_MS + 1_000);
  });

  it('returns null when no segment carries a usable timestamp', () => {
    expect(minTimestamp([makeSegment({ timestamp: null })])).toBeNull();
    expect(minTimestamp([])).toBeNull();
  });
});

describe('parseTranscript', () => {
  it('treats a missing transcript as an empty result, not an error', () => {
    for (const raw of [null, undefined, '', '   \n  ']) {
      const parsed = parseTranscript(raw);
      expect(parsed).toEqual({ kind: null, segments: [], chunks: [] });
    }
  });

  it('parses a JSON array of segments', () => {
    const segments = twoSpeakerSegments(6);
    const parsed = parseTranscript(jsonTranscript(segments));

    expect(parsed.kind).toBe('json');
    expect(parsed.segments).toHaveLength(6);
    expect(parsed.segments[0]!.text).toBe('Line 1 with a few words in it.');
    expect(parsed.chunks).toEqual([]);
    expect(parsed.warning).toBeUndefined();
  });

  it('parses the column once, not once per discriminator', () => {
    // The real column reaches 240 KB and this runs on every get_note_transcript,
    // including format=speakers.
    const raw = jsonTranscript(twoSpeakerSegments(4));
    const spy = vi.spyOn(JSON, 'parse');
    try {
      parseTranscript(raw);
      const parsesOfTheColumn = spy.mock.calls.filter(([text]) => text === raw).length;
      expect(parsesOfTheColumn).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts an empty JSON array as a JSON transcript with no segments', () => {
    const parsed = parseTranscript('[]');
    expect(parsed.kind).toBe('json');
    expect(parsed.segments).toEqual([]);
  });

  it('tolerates leading whitespace before the discriminating bracket', () => {
    expect(parseTranscript(`\n  ${jsonTranscript(relativeSegments(2))}`).kind).toBe('json');
  });

  it('degrades a truncated JSON write to plain text and says so', () => {
    const parsed = parseTranscript(BROKEN_JSON_TRANSCRIPT);

    expect(parsed.kind).toBe('plain');
    expect(parsed.segments).toEqual([]);
    expect(parsed.chunks.join('')).toContain('truncated mid-write');
    expect(parsed.warning).toMatch(/json/i);
  });

  it('drops array entries that are not objects and warns about them', () => {
    const raw = JSON.stringify([makeSegment({ text: 'kept' }), null, 'stray']);
    const parsed = parseTranscript(raw);

    expect(parsed.kind).toBe('json');
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]!.text).toBe('kept');
    expect(parsed.warning).toMatch(/2/);
  });

  it('chunks legacy flat text on paragraph boundaries', () => {
    const parsed = parseTranscript(LEGACY_PLAIN_TRANSCRIPT);

    expect(parsed.kind).toBe('plain');
    expect(parsed.segments).toEqual([]);
    expect(parsed.chunks).toEqual([LEGACY_PLAIN_TRANSCRIPT]);
  });

  it('keeps paragraphs whole while filling chunks up to the size target', () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i + 1}. ${'word '.repeat(60).trim()}`,
    );
    const parsed = parseTranscript(paragraphs.join('\n\n'));

    expect(parsed.chunks.length).toBeGreaterThan(1);
    for (const chunk of parsed.chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHARS);
    // Nothing was cut mid-paragraph and nothing was lost.
    expect(parsed.chunks.flatMap((chunk) => chunk.split('\n\n'))).toEqual(paragraphs);
  });

  it('hard-splits a single paragraph that is bigger than one chunk', () => {
    const parsed = parseTranscript('x'.repeat(CHUNK_CHARS * 2 + 10));

    expect(parsed.chunks).toHaveLength(3);
    for (const chunk of parsed.chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(parsed.chunks.join('')).toBe('x'.repeat(CHUNK_CHARS * 2 + 10));
  });
});

describe('normalizeSegments', () => {
  it('numbers segments and resolves their relative time', () => {
    const raw = twoSpeakerSegments(3);
    const normalized = normalizeSegments(raw, BASE_EPOCH_MS, 'ms');

    expect(normalized.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(normalized.map((s) => s.t_rel)).toEqual([0, 5, 10]);
    expect(normalized[1]!.speaker).toBe('speaker_0');
    expect(normalized[1]!.source).toBe('system');
  });

  it('keeps epoch-second transcripts on a seconds scale', () => {
    const raw = epochSecondSegments(4, 5);
    const normalized = normalizeSegments(raw, minTimestamp(raw)!, 's');
    expect(normalized.map((s) => s.t_rel)).toEqual([0, 5, 10, 15]);
  });

  it('leaves t_rel null when a segment has no usable timestamp', () => {
    const normalized = normalizeSegments([makeSegment({ timestamp: null })], null, 'relative');
    expect(normalized[0]!.t_rel).toBeNull();
  });

  it('falls back to a stable placeholder when the speaker key is missing', () => {
    const normalized = normalizeSegments([makeSegment({ speaker: null })], 0, 'relative');
    expect(normalized[0]!.speaker).toBe('unknown');
    expect(normalized[0]!.label).toBe('unknown');
  });

  it('prefers a real speaker name over the raw key, but never a placeholder one', () => {
    const [real, placeholder] = normalizeSegments(
      [
        makeSegment({ speaker: 'speaker_0', speakerName: 'Ada', speakerIsPlaceholder: false }),
        makeSegment({ speaker: 'speaker_1', speakerName: 'Speaker 2', speakerIsPlaceholder: true }),
      ],
      0,
      'relative',
    );

    expect(real!.label).toBe('Ada');
    expect(placeholder!.label).toBe('speaker_1');
    expect(placeholder!.speaker_name).toBe('Speaker 2');
  });
});

describe('mergeConsecutive', () => {
  it('folds a run of segments from the same speaker into one block', () => {
    const raw = [
      makeSegment({ text: 'One.', timestamp: BASE_EPOCH_MS, speaker: 'you' }),
      makeSegment({ text: 'Two.', timestamp: BASE_EPOCH_MS + 1_000, speaker: 'you' }),
      makeSegment({ text: 'Three.', timestamp: BASE_EPOCH_MS + 2_000, speaker: 'speaker_0' }),
    ];
    const blocks = mergeConsecutive(raw, { minTs: BASE_EPOCH_MS, unit: 'ms' });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe('One. Two.');
    expect(blocks[0]!.segment_count).toBe(2);
    expect(blocks[0]!.t_rel).toBe(0);
    expect(blocks[0]!.t_rel_last).toBe(1);
    expect(blocks[1]!.text).toBe('Three.');
  });

  it('starts a new block when the audio source changes', () => {
    const raw = [
      makeSegment({ text: 'Mic.', timestamp: BASE_EPOCH_MS, speaker: 'you', source: 'mic' }),
      makeSegment({ text: 'System.', timestamp: BASE_EPOCH_MS + 1_000, speaker: 'you', source: 'system' }),
    ];
    expect(mergeConsecutive(raw, { minTs: BASE_EPOCH_MS, unit: 'ms' })).toHaveLength(2);
  });

  it('starts a new block when the gap exceeds maxGapSeconds', () => {
    const raw = [
      makeSegment({ text: 'Before.', timestamp: BASE_EPOCH_MS, speaker: 'you' }),
      makeSegment({ text: 'After.', timestamp: BASE_EPOCH_MS + 60_000, speaker: 'you' }),
    ];
    const opts = { minTs: BASE_EPOCH_MS, unit: 'ms' as const };

    expect(mergeConsecutive(raw, opts)).toHaveLength(1);
    expect(mergeConsecutive(raw, { ...opts, maxGapSeconds: 30 })).toHaveLength(2);
  });

  it('caps a block at maxChars so one speaker cannot produce an unbounded line', () => {
    const raw = Array.from({ length: 6 }, (_, i) =>
      makeSegment({ text: 'abcd', timestamp: BASE_EPOCH_MS + i * 1_000, speaker: 'you' }),
    );
    const blocks = mergeConsecutive(raw, { minTs: BASE_EPOCH_MS, unit: 'ms', maxChars: 10 });

    expect(blocks.map((b) => b.text)).toEqual(['abcd abcd', 'abcd abcd', 'abcd abcd']);
  });

  it('skips segments with no text at all', () => {
    const raw = [
      makeSegment({ text: '', timestamp: BASE_EPOCH_MS }),
      makeSegment({ text: 'Kept.', timestamp: BASE_EPOCH_MS + 1_000 }),
    ];
    const blocks = mergeConsecutive(raw, { minTs: BASE_EPOCH_MS, unit: 'ms' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe('Kept.');
  });
});

describe('renderText', () => {
  function blocksOf(raw = twoSpeakerSegments(4)) {
    return mergeConsecutive(raw, { minTs: minTimestamp(raw)!, unit: 'ms' });
  }

  it('renders [mm:ss] speaker: text lines', () => {
    const { text, truncated } = renderText(blocksOf(), { maxChars: 10_000 });

    expect(truncated).toBe(false);
    expect(text.split('\n')).toEqual([
      '[00:00] you: Line 1 with a few words in it.',
      '[00:05] speaker_0: Line 2 with a few words in it.',
      '[00:10] you: Line 3 with a few words in it.',
      '[00:15] speaker_0: Line 4 with a few words in it.',
    ]);
  });

  it('switches to h:mm:ss past the hour mark', () => {
    const raw = [
      makeSegment({ text: 'Start.', timestamp: BASE_EPOCH_MS }),
      makeSegment({ text: 'Later.', timestamp: BASE_EPOCH_MS + 3_599_000, speaker: 'speaker_0' }),
      makeSegment({ text: 'Much later.', timestamp: BASE_EPOCH_MS + 3_725_000, speaker: 'you' }),
    ];
    const { text } = renderText(blocksOf(raw), { maxChars: 10_000 });

    expect(text.split('\n')[1]).toBe('[59:59] speaker_0: Later.');
    expect(text.split('\n')[2]).toBe('[1:02:05] you: Much later.');
  });

  it('marks a segment with no timestamp instead of inventing one', () => {
    const raw = [makeSegment({ text: 'No clock.', timestamp: null })];
    const { text } = renderText(mergeConsecutive(raw, { minTs: null, unit: 'relative' }), {
      maxChars: 1_000,
    });
    expect(text).toBe('[--:--] you: No clock.');
  });

  it('truncates on a line boundary and flags it', () => {
    const { text, truncated } = renderText(blocksOf(), { maxChars: 95 });

    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(95);
    expect(text.split('\n')).toEqual([
      '[00:00] you: Line 1 with a few words in it.',
      '[00:05] speaker_0: Line 2 with a few words in it.',
    ]);
  });

  it('hard-cuts when even the first line does not fit', () => {
    const { text, truncated } = renderText(blocksOf(), { maxChars: 12 });
    expect(truncated).toBe(true);
    expect(text).toHaveLength(12);
  });

  it('returns an empty, untruncated string for no blocks', () => {
    expect(renderText([], { maxChars: 100 })).toEqual({ text: '', truncated: false });
  });
});

describe('speakerStats', () => {
  it('reports per-speaker counts, words and the span they cover', () => {
    const raw = twoSpeakerSegments(4);
    const stats = speakerStats(raw, BASE_EPOCH_MS, 'ms');

    expect(stats).toEqual([
      { speaker: 'you', segments: 2, words: 16, first_t_rel: 0, last_t_rel: 10, share_pct: 50 },
      {
        speaker: 'speaker_0',
        segments: 2,
        words: 16,
        first_t_rel: 5,
        last_t_rel: 15,
        share_pct: 50,
      },
    ]);
  });

  it('orders speakers by first appearance so the shape of the recording is readable', () => {
    const raw = [
      makeSegment({ text: 'b', timestamp: BASE_EPOCH_MS + 1_000, speaker: 'speaker_1' }),
      makeSegment({ text: 'a a a', timestamp: BASE_EPOCH_MS, speaker: 'speaker_0' }),
    ];
    expect(speakerStats(raw, BASE_EPOCH_MS, 'ms').map((s) => s.speaker)).toEqual([
      'speaker_0',
      'speaker_1',
    ]);
  });

  it('rounds share_pct to one decimal and does not force the total to 100', () => {
    const raw = [
      makeSegment({ text: 'one', speaker: 'a', timestamp: BASE_EPOCH_MS }),
      makeSegment({ text: 'two', speaker: 'b', timestamp: BASE_EPOCH_MS + 1_000 }),
      makeSegment({ text: 'three', speaker: 'c', timestamp: BASE_EPOCH_MS + 2_000 }),
    ];
    const stats = speakerStats(raw, BASE_EPOCH_MS, 'ms');

    expect(stats.map((s) => s.share_pct)).toEqual([33.3, 33.3, 33.3]);
    expect(stats.reduce((sum, s) => sum + s.share_pct, 0)).toBeCloseTo(99.9, 5);
  });

  it('reports 0% rather than NaN when nothing has any words', () => {
    const stats = speakerStats([makeSegment({ text: '...', speaker: 'a' })], BASE_EPOCH_MS, 'ms');
    expect(stats[0]!.share_pct).toBe(0);
    expect(stats[0]!.words).toBe(0);
  });

  it('leaves the span null when the speaker has no usable timestamps', () => {
    const stats = speakerStats([makeSegment({ text: 'hi', timestamp: null })], null, 'relative');
    expect(stats[0]!.first_t_rel).toBeNull();
    expect(stats[0]!.last_t_rel).toBeNull();
  });

  it('is empty for a transcript with no segments', () => {
    expect(speakerStats([], null, 'relative')).toEqual([]);
  });
});
