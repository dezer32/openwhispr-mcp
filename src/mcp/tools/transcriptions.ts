import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeHttpError, ToolError } from '../../bridge/errors.js';
import { MAX_UPSTREAM_LIMIT } from '../../config.js';
import type { ToolDeps } from '../../deps.js';
import { toTranscription } from '../../domain/projections.js';
import { getTranscriptionSchema, listTranscriptionsSchema } from '../../schemas/transcript.js';
import { defineTool } from '../defineTool.js';

/**
 * `transcriptions` is the dictation history. It is a separate stream from
 * `notes` — the database has neither a foreign key nor a `note_id` — and an
 * agent that assumes otherwise will read the wrong thing, so every response
 * says so.
 */
const NO_LINK_NOTE =
  'Dictations are a separate history with no link to notes: the database has no foreign key and no note_id, so a dictation cannot be traced to the note it ended up in. A recording note keeps its own transcript — read that with get_note_transcript.';

const HIDDEN_ROWS =
  'The bridge hides soft-deleted dictations and every row with status "discarded", so an empty or short result is not proof that nothing was dictated.';

const NO_PAGINATION =
  `The bridge offers no pagination, only a limit over the newest rows by timestamp. Raise limit (max ${MAX_UPSTREAM_LIMIT}) to reach older dictations.`;

const LOCAL_STATUS_FILTER =
  'status is applied locally, after limit already cut the window: older dictations with this status are simply not in the fetched rows. Raise limit to widen it.';

const LIST_DESCRIPTION =
  'List the OpenWhispr dictation history (newest first): text, provider, model, status and audio duration. ' +
  'These rows are NOT note transcripts and cannot be linked to a note — use get_note_transcript for those. ' +
  'Discarded and deleted dictations are invisible here.';

const GET_DESCRIPTION =
  'Read one dictation from the history by id, with its full text, provider, model, status and any error. ' +
  'Ids come from list_transcriptions. A dictation is not linked to any note — use get_note_transcript for a note transcript.';

const NOT_FOUND_HINT =
  'Either the id never existed, or the dictation was discarded or soft-deleted — the bridge hides both, so they cannot be read back. Call list_transcriptions for the ids that are visible.';

export function registerTranscriptions(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'list_transcriptions',
    title: 'List dictation history',
    description: LIST_DESCRIPTION,
    schema: listTranscriptionsSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        const rows = await routes.listTranscriptions({ limit: args.limit });
        const kept = args.status === undefined ? rows : rows.filter((row) => row.status === args.status);

        const limitations = [HIDDEN_ROWS, NO_PAGINATION];
        if (args.status !== undefined) limitations.push(LOCAL_STATUS_FILTER);

        return {
          transcriptions: kept.map((row) => toTranscription(row)),
          limit: args.limit,
          fetched: rows.length,
          returned: kept.length,
          // A full page means the window was capped, not that the history ended.
          complete: rows.length < args.limit,
          status_filter: args.status ?? null,
          notice: NO_LINK_NOTE,
          limitations,
        };
      }),
  });

  defineTool(server, deps, {
    name: 'get_transcription',
    title: 'Read one dictation',
    description: GET_DESCRIPTION,
    schema: getTranscriptionSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        try {
          const row = await routes.getTranscription(args.transcription_id);
          return { transcription: toTranscription(row, { includeRaw: true }), notice: NO_LINK_NOTE };
        } catch (err) {
          if (err instanceof BridgeHttpError && err.status === 404) {
            throw new ToolError(
              'not_found',
              `there is no readable dictation with id ${args.transcription_id}`,
              { hint: NOT_FOUND_HINT },
            );
          }
          throw err;
        }
      }),
  });
}
