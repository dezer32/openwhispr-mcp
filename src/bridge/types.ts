/**
 * Wire shapes of the OpenWhispr CLI bridge. `Raw*` types mirror the SQLite rows
 * as the bridge serialises them (`SELECT *`), including the sync columns the MCP
 * layer projects away. Everything is optional because the app grows its schema
 * with unversioned `ALTER TABLE` chains.
 */

/**
 * Both envelopes are read by `httpClient`, on purpose: a wire type nothing
 * references documents the wire only until the app changes it, and after that
 * it documents nothing while still looking authoritative.
 */
export interface Envelope<T> {
  data: T;
}

/** Non-2xx bodies; every field is `unknown` because the bridge does not validate them. */
export interface ErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export interface RawNote {
  id: number;
  title?: string | null;
  content?: string | null;
  note_type?: string | null;
  source_file?: string | null;
  audio_duration_seconds?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  enhanced_content?: string | null;
  enhancement_prompt?: string | null;
  enhanced_at_content_hash?: string | null;
  cloud_id?: string | null;
  folder_id?: number | null;
  transcript?: string | null;
  calendar_event_id?: string | null;
  participants?: string | null;
  diarization_enabled?: number | boolean | null;
  expected_speaker_count?: number | null;
  client_note_id?: string | null;
  sync_status?: string | null;
  deleted_at?: string | null;
  is_shared?: number | boolean | null;
  share_token?: string | null;
  space_id?: string | number | null;
  account_id?: string | number | null;
  left_team?: number | boolean | null;
  updated_by_user_id?: string | number | null;
  cloud_updated_at?: string | null;
  owner_user_id?: string | number | null;
  created_by_user_id?: string | number | null;
  [key: string]: unknown;
}

export interface RawFolder {
  id: number;
  name?: string | null;
  is_default?: number | boolean | null;
  sort_order?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  client_folder_id?: string | null;
  cloud_id?: string | null;
  sync_status?: string | null;
  deleted_at?: string | null;
  space_id?: string | number | null;
  account_id?: string | number | null;
  left_team?: number | boolean | null;
  [key: string]: unknown;
}

export interface RawTranscription {
  id: number;
  text?: string | null;
  /** Unconfirmed type: may be an epoch number or a SQLite datetime string. */
  timestamp?: string | number | null;
  created_at?: string | null;
  raw_text?: string | null;
  has_audio?: number | boolean | null;
  audio_duration_ms?: number | null;
  provider?: string | null;
  model?: string | null;
  status?: string | null;
  error_message?: string | null;
  error_code?: string | null;
  route_kind?: string | null;
  client_transcription_id?: string | null;
  cloud_id?: string | null;
  sync_status?: string | null;
  deleted_at?: string | null;
  [key: string]: unknown;
}

/** `GET /v1/health` payload; shape beyond `status` is not contractual. */
export interface RawHealth {
  status?: string;
  version?: string;
  [key: string]: unknown;
}

/** One segment of a JSON `notes.transcript`. No `start`/`end`/`words` exist. */
export interface RawTranscriptSegment {
  text?: string | null;
  source?: string | null;
  /** Epoch milliseconds in observed data, but seconds and relative values occur. */
  timestamp?: number | null;
  speaker?: string | null;
  speakerName?: string | null;
  speakerIsPlaceholder?: boolean | null;
  suggestedName?: string | null;
  suggestedProfileId?: string | number | null;
  speakerStatus?: string | null;
  speakerLocked?: boolean | null;
  speakerLockSource?: string | null;
  [key: string]: unknown;
}
