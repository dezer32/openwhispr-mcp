import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  type ListResourcesResult,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';

import {
  BridgeHttpError,
  ToolError,
  type ErrorKind,
  type ToolErrorPayload,
} from '../../bridge/errors.js';
import type { RawNote } from '../../bridge/types.js';
import type { ToolDeps } from '../../deps.js';
import { toIsoZ } from '../../domain/dates.js';
import { describeTranscript, type TranscriptShape } from '../../domain/projections.js';
import { renderTranscriptDoc } from '../../domain/transcriptDoc.js';
import {
  TRANSCRIPT_MIME_TYPE,
  TRANSCRIPT_URI_TEMPLATE,
  parseTranscriptNoteId,
  transcriptUri,
} from '../../domain/transcriptUri.js';
import { logWarn } from '../../log.js';
import { mapToolError } from '../errorMap.js';

/**
 * Every note's transcript as one markdown document.
 *
 * `get_note_transcript` cannot hand over a whole meeting: `format:"text"` stops
 * at 20 000 characters and `format:"segments"` needs seven to nine paged calls
 * for a real recording. This is the same data as one read.
 *
 * Nothing is cached on disk. The document is rendered from the bridge on every
 * read, which costs one HTTP call and keeps the server free of a cache that
 * would need invalidating whenever the app re-records a note.
 */

const RESOURCE_NAME = 'note_transcript';

const DESCRIPTION =
  'A note transcript as one markdown document: header facts, a per-speaker table, the caveats that ' +
  'apply to the labels and the times, then the full "[mm:ss] speaker: …" body. Rendered from the app ' +
  'on every read.';

const NOT_FOUND_HINT =
  'Note ids come from resources/list, list_notes, search_notes or get_note. A deleted note stays invisible to the bridge.';

const BAD_ID_HINT = `The URI must be ${TRANSCRIPT_URI_TEMPLATE} with a positive integer note id.`;

/** Only these two are the caller's mistake; everything else is the app or the bridge. */
const CALLER_FAULT = new Set<ErrorKind>(['not_found', 'invalid_argument']);

function titleOf(note: RawNote): string {
  const title = typeof note.title === 'string' ? note.title.trim() : '';
  return title === '' ? `Note ${note.id}` : title;
}

/** `size` is deliberately absent: see `describeResource`'s caller for why. */
function describeResource(note: RawNote, shape: TranscriptShape): string {
  const segments =
    shape.kind === 'json' && shape.segment_count !== null
      ? `${shape.segment_count} transcript ${shape.segment_count === 1 ? 'segment' : 'segments'}`
      : 'legacy flat-text transcript';
  const updatedAt = toIsoZ(note.updated_at);
  const noteType = typeof note.note_type === 'string' && note.note_type !== '' ? note.note_type : 'note';
  return updatedAt === null
    ? `${noteType}, ${segments}`
    : `${noteType}, ${segments}, updated ${updatedAt}`;
}

/**
 * A client pulls `resources/list` by itself and often, and a closed OpenWhispr is
 * a normal state rather than a fault — so an unreachable bridge answers with an
 * empty list. `health` is where a diagnosis belongs.
 */
async function listTranscripts(
  deps: ToolDeps,
  signal: AbortSignal | undefined,
): Promise<ListResourcesResult> {
  let notes: RawNote[];
  try {
    notes = await deps.withSession({ signal }, (routes) =>
      routes.listNotes({ limit: deps.config.maxUpstreamLimit }),
    );
  } catch (err) {
    logWarn('resources/list found no reachable bridge', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { resources: [] };
  }

  const resources: Resource[] = [];
  for (const note of notes ?? []) {
    const shape = describeTranscript(typeof note.transcript === 'string' ? note.transcript : null);
    if (shape.kind === null) continue;
    resources.push({
      uri: transcriptUri(note.id),
      // `name` stays programmatic and stable; `title` is what a picker shows.
      name: `note-${note.id}-transcript`,
      title: titleOf(note),
      description: describeResource(note, shape),
      mimeType: TRANSCRIPT_MIME_TYPE,
      // `size` is left unset on purpose: the only cheap number is the length of
      // the raw JSON column, roughly three times the rendered document, and a
      // wrong size in the metadata is worse than none.
    });
  }
  return { resources };
}

async function readTranscript(
  deps: ToolDeps,
  uri: URL,
  variables: Variables,
  signal: AbortSignal | undefined,
): Promise<ReadResourceResult> {
  // A template variable arrives as a string, or as an array of them when the
  // client repeats it; the first value is the one the URI was matched on.
  const raw = variables.note_id;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const noteId = typeof first === 'string' ? parseTranscriptNoteId(first) : null;
  if (noteId === null) {
    return fail(
      new ToolError('invalid_argument', `"${String(first ?? '')}" is not a note id`, {
        hint: BAD_ID_HINT,
      }),
      deps,
      signal,
    );
  }

  try {
    const note = await deps.withSession({ signal }, (routes) => routes.getNote(noteId));
    const doc = renderTranscriptDoc(
      {
        noteId,
        title: typeof note.title === 'string' ? note.title : null,
        noteType: typeof note.note_type === 'string' ? note.note_type : null,
        updatedAt: toIsoZ(note.updated_at),
        transcript: typeof note.transcript === 'string' ? note.transcript : null,
      },
      { maxChars: deps.config.maxResultChars },
    );
    return {
      contents: [{ uri: uri.href, mimeType: TRANSCRIPT_MIME_TYPE, text: doc.text }],
    };
  } catch (err) {
    if (err instanceof BridgeHttpError && err.status === 404) {
      return fail(
        new ToolError('not_found', `there is no note with id ${noteId}`, { hint: NOT_FOUND_HINT }),
        deps,
        signal,
      );
    }
    return fail(err, deps, signal);
  }
}

/**
 * `resources/read` has no `isError` envelope, so a failure has to be a protocol
 * error. The body is still the `{error:{kind,message,hint}}` JSON the tools
 * return, so an agent reads the same `kind` either way.
 */
class ResourceReadError extends McpError {
  constructor(code: ErrorCode, payload: ToolErrorPayload) {
    const body = JSON.stringify({ error: payload }, null, 2);
    super(code, body, payload);
    // `McpError` prefixes its message with `MCP error <code>: `, and the client
    // prefixes it again when it rebuilds the error from the wire — so the
    // prefix is dropped here and the agent sees it exactly once.
    this.message = body;
  }
}

async function fail(err: unknown, deps: ToolDeps, signal: AbortSignal | undefined): Promise<never> {
  const payload = await mapToolError(err, { deps, toolName: RESOURCE_NAME, signal });
  throw new ResourceReadError(
    CALLER_FAULT.has(payload.kind) ? ErrorCode.InvalidParams : ErrorCode.InternalError,
    payload,
  );
}

export function registerTranscriptResource(server: McpServer, deps: ToolDeps): void {
  server.registerResource(
    RESOURCE_NAME,
    new ResourceTemplate(TRANSCRIPT_URI_TEMPLATE, {
      list: (extra) => listTranscripts(deps, extra.signal),
    }),
    {
      title: 'Note transcript (markdown)',
      description: DESCRIPTION,
      mimeType: TRANSCRIPT_MIME_TYPE,
    },
    (uri, variables, extra) => readTranscript(deps, uri, variables, extra.signal),
  );
}
