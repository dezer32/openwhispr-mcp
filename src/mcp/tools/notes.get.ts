import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeHttpError, ToolError } from '../../bridge/errors.js';
import type { ToolDeps } from '../../deps.js';
import { createFolderIndex, FOLDER_NAMES_UNAVAILABLE_NOTE } from '../../domain/folderIndex.js';
import { toNoteDetail } from '../../domain/projections.js';
import { getNoteSchema } from '../../schemas/notes.js';
import { defineTool } from '../defineTool.js';

const DESCRIPTION =
  'Read one note by id: title, folder, timestamps and the full content body. ' +
  'The transcript is never included — it reaches 240 KB — so a meeting note reports ' +
  'transcript_segment_count and a hint pointing at get_note_transcript. ' +
  'Set include_enhanced to also receive the AI-cleaned version of the text.';

/**
 * The bridge answers 404 for three distinct situations and never says which,
 * because `getNoteById` filters on `deleted_at IS NULL` inside the same query.
 */
const NOT_FOUND_HINT =
  'The bridge cannot tell these apart: the note never existed, it was deleted (deleted notes stay ' +
  'in the database but are invisible over the bridge), or it belongs to an account or space the app ' +
  'is not signed into. Call list_notes to see the ids that are reachable right now.';

const ENHANCED_NOTE =
  'This note also has an AI-enhanced version of its text. Pass include_enhanced: true to receive ' +
  'enhanced_content; it is withheld by default because it roughly doubles the size of the result.';

export function registerGetNote(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'get_note',
    title: 'Read a note',
    description: DESCRIPTION,
    schema: getNoteSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        const folders = createFolderIndex(routes);

        let raw;
        try {
          raw = await routes.getNote(args.note_id);
        } catch (err) {
          if (err instanceof BridgeHttpError && err.status === 404) {
            throw new ToolError(
              'not_found',
              `no note with id ${args.note_id} is visible over the bridge`,
              { hint: NOT_FOUND_HINT, details: { note_id: args.note_id } },
            );
          }
          throw err;
        }

        const note = toNoteDetail(raw, await folders.nameOf(raw.folder_id), {
          includeEnhanced: args.include_enhanced,
        });

        const result: Record<string, unknown> = { note };
        if (note.has_enhanced_content && !args.include_enhanced) {
          result.enhanced_content_note = ENHANCED_NOTE;
        }
        if (folders.namesUnavailable) {
          result.folder_names_unavailable = true;
          result.folder_names_note = FOLDER_NAMES_UNAVAILABLE_NOTE;
        }
        return result;
      }),
  });
}
