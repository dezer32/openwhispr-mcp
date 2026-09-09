import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../../deps.js';
import { createFolderIndex, FOLDER_NAMES_UNAVAILABLE_NOTE } from '../../domain/folderIndex.js';
import { toNoteDetail } from '../../domain/projections.js';
import { createNoteSchema } from '../../schemas/writes.js';
import { defineTool } from '../defineTool.js';

const DESCRIPTION =
  'Create a note in the local OpenWhispr app. Without folder_id the app files it ' +
  'into its own default folder — see the notice field in the reply. note_type is ' +
  'fixed at creation: update_note cannot change it. Returns the stored note.';

/**
 * The app resolves the default folder by NAME (`Meetings` for a meeting note,
 * `Personal` otherwise), not by the `is_default` flag, so a folder renamed in
 * the UI puts this outside what the bridge can tell us.
 */
const DEFAULT_FOLDER_NOTE =
  'No folder_id was given, so the app filed this note into the folder it looks up by name — "Meetings" for a meeting note, "Personal" otherwise. If that folder was renamed in the app, where the note landed is not something the bridge reveals; folder_id in the reply is what actually happened.';

export function registerCreateNote(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'create_note',
    title: 'Create a note',
    description: DESCRIPTION,
    schema: createNoteSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        // No pre-flight check on folder_id: it would cost a request on every
        // happy path and still race the app between the check and the write.
        // An unknown id comes back as a 500 that errorMap turns into
        // folder_not_found, with the real folder list attached.
        const created = await routes.createNote({
          title: args.title,
          content: args.content,
          note_type: args.note_type,
          folder_id: args.folder_id,
          source_file: args.source_file,
          audio_duration_seconds: args.audio_duration_seconds,
        });

        // The projection has already coerced folder_id out of the raw row —
        // SQLite may hand it over as text — so the name is looked up from that
        // rather than from the column a second time.
        const detail = toNoteDetail(created, null, { includeEnhanced: false });
        const folders = createFolderIndex(routes);
        const folderName = await folders.nameOf(detail.folder_id);

        return {
          created: true,
          note: { ...detail, folder_name: folderName },
          ...(args.folder_id === undefined ? { notice: DEFAULT_FOLDER_NOTE } : {}),
          ...(folders.namesUnavailable
            ? { folder_names_unavailable: true, folder_names_note: FOLDER_NAMES_UNAVAILABLE_NOTE }
            : {}),
        };
      }),
  });
}
