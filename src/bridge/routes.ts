import type {
  BridgeRoutes,
  BridgeSession,
  DictionaryUpdateParams,
  NoteCreateParams,
  NoteUpdateParams,
  NotesListParams,
  NotesSearchParams,
  RequestSpec,
  TranscriptionsListParams,
} from '../deps.js';
import type { RawFolder, RawHealth, RawNote, RawTranscription } from './types.js';
import { BridgeTransportError } from './errors.js';

/**
 * Typed wrappers over the 13 bridge routes this server uses. Deleting a
 * transcription or its audio is deliberately not exposed.
 *
 * `session.request` has already unwrapped `{data}`, so a list route only has to
 * assert that what came out of the envelope really is a list.
 */
export function createRoutes(session: BridgeSession): BridgeRoutes {
  async function list<T>(spec: RequestSpec): Promise<T[]> {
    const data = await session.request<unknown>(spec);
    if (!Array.isArray(data)) {
      throw new BridgeTransportError(
        'upstream_protocol',
        `the bridge answered ${spec.path} with something other than a list`,
        { details: { path: spec.path, received: data === null ? 'null' : typeof data } },
      );
    }
    return data as T[];
  }

  return {
    health: () => session.request<RawHealth>({ method: 'GET', path: '/v1/health' }),

    listNotes: (params: NotesListParams = {}) =>
      list<RawNote>({
        method: 'GET',
        path: '/v1/notes/list',
        query: { note_type: params.note_type, limit: params.limit, folder_id: params.folder_id },
      }),

    searchNotes: (params: NotesSearchParams) =>
      list<RawNote>({
        method: 'GET',
        path: '/v1/notes/search',
        query: { q: params.q, limit: params.limit },
      }),

    getNote: (id: number) => session.request<RawNote>({ method: 'GET', path: `/v1/notes/${id}` }),

    createNote: (params: NoteCreateParams) =>
      session.request<RawNote>({
        method: 'POST',
        path: '/v1/notes/create',
        body: params,
        mutating: true,
      }),

    updateNote: (id: number, patch: NoteUpdateParams) =>
      session.request<unknown>({
        method: 'PATCH',
        path: `/v1/notes/${id}`,
        body: patch,
        mutating: true,
      }),

    deleteNote: async (id: number) => {
      await session.request<void>({ method: 'DELETE', path: `/v1/notes/${id}`, mutating: true });
    },

    listFolders: () => list<RawFolder>({ method: 'GET', path: '/v1/folders/list' }),

    createFolder: (name: string) =>
      session.request<RawFolder>({
        method: 'POST',
        path: '/v1/folders/create',
        body: { name },
        mutating: true,
      }),

    listDictionary: () => session.request<unknown>({ method: 'GET', path: '/v1/dictionary/list' }),

    updateDictionary: (params: DictionaryUpdateParams) =>
      session.request<unknown>({
        method: 'POST',
        path: '/v1/dictionary/update',
        body: params,
        mutating: true,
      }),

    listTranscriptions: (params: TranscriptionsListParams = {}) =>
      list<RawTranscription>({
        method: 'GET',
        path: '/v1/transcriptions/list',
        query: { limit: params.limit },
      }),

    getTranscription: (id: number) =>
      session.request<RawTranscription>({ method: 'GET', path: `/v1/transcriptions/${id}` }),
  };
}
