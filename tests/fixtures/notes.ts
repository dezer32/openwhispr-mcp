import type { RawNote } from '../../src/bridge/types.js';

/**
 * FROZEN: build variants with `makeNote({...})` instead of editing this file —
 * several agents share it.
 */
let nextId = 1;

export function resetNoteIds(start = 1): void {
  nextId = start;
}

/** A full 30-column row, including the sync columns the projections must hide. */
export function makeNote(overrides: Partial<RawNote> = {}): RawNote {
  const id = overrides.id ?? nextId++;
  return {
    id,
    title: `Note ${id}`,
    content: `Body of note ${id}.`,
    note_type: 'personal',
    source_file: null,
    audio_duration_seconds: null,
    created_at: '2026-09-01 10:00:00',
    updated_at: '2026-09-08 08:31:48',
    enhanced_content: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    cloud_id: `cloud-${id}`,
    folder_id: 1,
    transcript: null,
    calendar_event_id: null,
    participants: null,
    diarization_enabled: 0,
    expected_speaker_count: null,
    client_note_id: `client-${id}`,
    sync_status: 'synced',
    deleted_at: null,
    is_shared: 0,
    share_token: null,
    space_id: null,
    account_id: 42,
    left_team: 0,
    updated_by_user_id: 7,
    cloud_updated_at: '2026-09-08 08:31:50',
    owner_user_id: 7,
    created_by_user_id: 7,
    ...overrides,
  };
}

/** Columns a projection must never leak. */
export const SYNC_ONLY_KEYS = [
  'cloud_id',
  'client_note_id',
  'sync_status',
  'is_shared',
  'share_token',
  'space_id',
  'account_id',
  'left_team',
  'updated_by_user_id',
  'cloud_updated_at',
  'owner_user_id',
  'created_by_user_id',
  'enhanced_at_content_hash',
  'deleted_at',
] as const;

export function makeNotes(count: number, overrides: (index: number) => Partial<RawNote> = () => ({})): RawNote[] {
  return Array.from({ length: count }, (_, i) => makeNote(overrides(i)));
}
