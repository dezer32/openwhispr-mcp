import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError } from '../../bridge/errors.js';
import type { ToolDeps } from '../../deps.js';
import { createFolderIndex, FOLDER_NAMES_UNAVAILABLE_NOTE } from '../../domain/folderIndex.js';
import { toNoteDetail } from '../../domain/projections.js';
import { updateNoteSchema } from '../../schemas/writes.js';
import { defineTool } from '../defineTool.js';

const DESCRIPTION =
  "Change a note's title, content or folder in the local OpenWhispr app. " +
  'note_type, transcript and enhanced_content are deliberately not writable. ' +
  'Rewriting content leaves any existing enhanced_content in place and the app ' +
  'keeps treating it as current; the reply warns when that happens.';

/**
 * The app decides whether `enhanced_content` is still current by comparing
 * `content` against `enhanced_at_content_hash` — a hash we cannot compute and
 * the bridge will not accept, so it stays whatever it was before the edit.
 */
const STALE_ENHANCEMENT_WARNING =
  'This note has enhanced_content, and the bridge gives no way to update the hash the app compares it against. The enhancement is now stale but the app will keep showing it as if it matched the new content. Re-run the enhancement in the app if that matters.';

/** `db.updateNote` answers `{success:false}` with no reason at all when it writes nothing. */
function assertWritten(response: unknown): void {
  if (
    typeof response === 'object' &&
    response !== null &&
    (response as { success?: unknown }).success === false
  ) {
    throw new ToolError('write_failed', 'the app reported that the note was not written', {
      hint: 'The bridge returns no reason for this. Re-read the note with get_note to see what its current state is before retrying.',
    });
  }
}

export function registerUpdateNote(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'update_note',
    title: 'Update a note',
    description: DESCRIPTION,
    schema: updateNoteSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        // Read first, always: it decides whether the enhancement warning is due
        // and turns an unknown id into not_found before anything is written.
        // Nothing has mutated yet, so a 401 here can still replay the callback.
        const before = await routes.getNote(args.note_id);
        const hadEnhancement = (before.enhanced_content ?? '') !== '';

        assertWritten(
          await routes.updateNote(args.note_id, {
            title: args.title,
            content: args.content,
            folder_id: args.folder_id,
          }),
        );

        // The PATCH answers `{success:true}`, not the row, so the note has to be
        // read back to report what is actually stored.
        const after = await routes.getNote(args.note_id);
        // The projection has already coerced folder_id out of the raw row —
        // SQLite may hand it over as text — so the name is looked up from that
        // rather than from the column a second time.
        const detail = toNoteDetail(after, null, { includeEnhanced: false });
        const folders = createFolderIndex(routes);
        const folderName = await folders.nameOf(detail.folder_id);

        return {
          updated: true,
          note: { ...detail, folder_name: folderName },
          ...(args.content !== undefined && hadEnhancement
            ? { warning: STALE_ENHANCEMENT_WARNING }
            : {}),
          ...(folders.namesUnavailable
            ? { folder_names_unavailable: true, folder_names_note: FOLDER_NAMES_UNAVAILABLE_NOTE }
            : {}),
        };
      }),
  });
}
