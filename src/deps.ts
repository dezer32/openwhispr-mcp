import type { Config } from './config.js';
import type {
  RawFolder,
  RawHealth,
  RawNote,
  RawTranscription,
} from './bridge/types.js';

/** One HTTP call against the bridge, described declaratively. */
export interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path only, e.g. `/v1/notes/list`. */
  path: string;
  /** `undefined` values are dropped rather than serialised as the string "undefined". */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Marks a call that changes state. Once one of these has succeeded inside a
   * session, a later 401 must NOT replay the session — the replay would create
   * a duplicate note or folder.
   */
  mutating?: boolean;
}

/**
 * A session pins `{port, token}` for the whole tool call, so a set of parallel
 * reads cannot be stitched together from two different app instances.
 */
export interface BridgeSession {
  readonly host: string;
  readonly port: number;
  /** 1 on the first pass, 2 after a 401 forced the handshake to be re-read. */
  readonly attempt: number;
  /** Aborted when the session is torn down; combine with per-request timeouts. */
  readonly signal: AbortSignal;
  /** True once a `mutating` request has completed successfully. */
  readonly mutationCommitted: boolean;
  /**
   * Performs the call and unwraps the `{data}` envelope.
   * A `204` resolves to `undefined` without parsing a body.
   */
  request<T>(spec: RequestSpec): Promise<T>;
}

export interface NotesListParams {
  note_type?: string;
  limit?: number;
  folder_id?: number;
}

export interface NotesSearchParams {
  q: string;
  limit?: number;
}

export interface NoteCreateParams {
  title?: string;
  content?: string;
  note_type?: string;
  source_file?: string;
  audio_duration_seconds?: number;
  folder_id?: number;
}

/** Only the fields `db.updateNote` whitelists and the MCP layer is willing to send. */
export interface NoteUpdateParams {
  title?: string;
  content?: string;
  folder_id?: number;
}

export interface DictionaryUpdateParams {
  add?: string[];
  remove?: string[];
}

export interface TranscriptionsListParams {
  limit?: number;
}

/** Typed wrappers over the 13 bridge routes this server exposes. */
export interface BridgeRoutes {
  health(): Promise<RawHealth>;
  listNotes(params?: NotesListParams): Promise<RawNote[]>;
  searchNotes(params: NotesSearchParams): Promise<RawNote[]>;
  getNote(id: number): Promise<RawNote>;
  createNote(params: NoteCreateParams): Promise<RawNote>;
  updateNote(id: number, patch: NoteUpdateParams): Promise<unknown>;
  deleteNote(id: number): Promise<void>;
  listFolders(): Promise<RawFolder[]>;
  createFolder(name: string): Promise<RawFolder>;
  /** Shape is not contractual; normalise at the domain layer. */
  listDictionary(): Promise<unknown>;
  updateDictionary(params: DictionaryUpdateParams): Promise<unknown>;
  listTranscriptions(params?: TranscriptionsListParams): Promise<RawTranscription[]>;
  getTranscription(id: number): Promise<RawTranscription>;
}

/** Generic TTL + LRU store; `domain/snapshot.ts` builds the list-notes cursor on top. */
export interface SnapshotStore<V = unknown> {
  get(key: string): V | undefined;
  put(key: string, value: V): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

export interface WithSessionOptions {
  /** Cancellation signal from the MCP tool call. */
  signal?: AbortSignal;
}

/**
 * Everything a tool needs, injected so tests never touch the network or the
 * real handshake file.
 */
export interface ToolDeps {
  config: Config;
  /** Injectable clock (snapshot TTL, usage period buckets). */
  now(): number;
  snapshots: SnapshotStore<unknown>;
  /**
   * Runs `fn` inside a single session. On a 401 the session aborts its
   * in-flight requests, re-reads the handshake file and replays `fn` exactly
   * once — unless a mutating request has already committed.
   */
  withSession<T>(
    options: WithSessionOptions,
    fn: (routes: BridgeRoutes, session: BridgeSession) => Promise<T>,
  ): Promise<T>;
}
