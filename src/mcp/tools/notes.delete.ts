import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../../deps.js';
import { deleteNoteSchema } from '../../schemas/writes.js';
import { defineTool } from '../defineTool.js';

/**
 * `destructiveHint` is advice, not a gate: a client is free to ignore it and
 * call straight through. Saying so in the description is the only protection
 * this tool has, and that is a deliberate choice — a confirmation argument
 * would just be another field an agent fills in by itself.
 */
const DESCRIPTION =
  'Delete a note from the local OpenWhispr app. There is no confirmation step ' +
  'and no undo on this path, so confirm with the user before calling it. The ' +
  'bridge answers 204 without saying whether the id existed.';

const NO_CONFIRMATION_NOTE =
  'The bridge answers 204 without confirming the row existed; a delete of an unknown id also succeeds. Treat this as "the app was asked to delete this id", not as proof a note was there.';

export function registerDeleteNote(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'delete_note',
    title: 'Delete a note',
    description: DESCRIPTION,
    schema: deleteNoteSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        await routes.deleteNote(args.note_id);
        return { deleted: true, note_id: args.note_id, notice: NO_CONFIRMATION_NOTE };
      }),
  });
}
