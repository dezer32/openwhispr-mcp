import type { RawTranscriptSegment } from '../../src/bridge/types.js';

/** FROZEN: build variants with `makeSegment({...})` / `jsonTranscript(...)`. */
export const BASE_EPOCH_MS = 1_788_000_000_000; // 2026-08-29T10:40:00Z

export function makeSegment(overrides: Partial<RawTranscriptSegment> = {}): RawTranscriptSegment {
  return {
    text: 'Hello there.',
    source: 'mic',
    timestamp: BASE_EPOCH_MS,
    speaker: 'you',
    speakerName: null,
    speakerIsPlaceholder: true,
    suggestedName: null,
    suggestedProfileId: null,
    speakerStatus: 'provisional',
    speakerLocked: false,
    speakerLockSource: null,
    ...overrides,
  };
}

export function jsonTranscript(segments: RawTranscriptSegment[]): string {
  return JSON.stringify(segments);
}

/**
 * Two speakers, epoch-millisecond timestamps, five seconds apart.
 */
export function twoSpeakerSegments(count = 6, stepMs = 5_000): RawTranscriptSegment[] {
  return Array.from({ length: count }, (_, i) =>
    makeSegment({
      text: `Line ${i + 1} with a few words in it.`,
      timestamp: BASE_EPOCH_MS + i * stepMs,
      speaker: i % 2 === 0 ? 'you' : 'speaker_0',
      source: i % 2 === 0 ? 'mic' : 'system',
      speakerName: i % 2 === 0 ? 'You' : null,
    }),
  );
}

/** Same shape, but timestamps are epoch SECONDS — the app's own heuristic breaks here. */
export function epochSecondSegments(count = 4, stepS = 5): RawTranscriptSegment[] {
  const base = Math.floor(BASE_EPOCH_MS / 1000);
  return Array.from({ length: count }, (_, i) =>
    makeSegment({ text: `Second-based line ${i + 1}.`, timestamp: base + i * stepS }),
  );
}

/** Timestamps already relative to the start of the recording. */
export function relativeSegments(count = 4, stepS = 5): RawTranscriptSegment[] {
  return Array.from({ length: count }, (_, i) =>
    makeSegment({ text: `Relative line ${i + 1}.`, timestamp: i * stepS }),
  );
}

/** Legacy flat text: no JSON, no diarization. */
export const LEGACY_PLAIN_TRANSCRIPT = [
  'This is a legacy transcript stored as plain text.',
  '',
  'It has paragraphs but no speaker information at all.',
].join('\n');

/** Starts with "[" so the app's discriminator says JSON, but parsing fails. */
export const BROKEN_JSON_TRANSCRIPT = '[{"text":"truncated mid-write"';
