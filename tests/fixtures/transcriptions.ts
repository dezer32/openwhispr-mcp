import type { RawTranscription } from '../../src/bridge/types.js';

/** FROZEN: build variants with `makeTranscription({...})`. */
export function makeTranscription(overrides: Partial<RawTranscription> = {}): RawTranscription {
  const id = overrides.id ?? 1;
  return {
    id,
    text: `Dictation number ${id}.`,
    timestamp: '2026-09-07 12:00:00',
    created_at: '2026-09-07 12:00:00',
    raw_text: `dictation number ${id}`,
    has_audio: 1,
    audio_duration_ms: 4200,
    provider: 'local',
    model: 'whisper-large-v3',
    status: 'completed',
    error_message: null,
    error_code: null,
    route_kind: 'dictation',
    client_transcription_id: `ct-${id}`,
    cloud_id: null,
    sync_status: 'local',
    deleted_at: null,
    ...overrides,
  };
}

/** The `timestamp` column type is unconfirmed; both shapes must round-trip. */
export const TIMESTAMP_SHAPES = {
  sqliteString: '2026-09-07 12:00:00',
  epochMs: 1_788_000_000_000,
} as const;
