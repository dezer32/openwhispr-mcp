import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../../deps.js';
import { createFolderIndex } from '../../domain/folderIndex.js';
import { toFolder } from '../../domain/projections.js';
import { createFolderSchema, listFoldersSchema } from '../../schemas/writes.js';
import { defineTool } from '../defineTool.js';

const LIST_DESCRIPTION =
  'List the note folders of the local OpenWhispr app, with their ids, names and ' +
  'default flags. Use it to find the folder_id that list_notes, create_note and ' +
  'update_note take. The bridge returns every folder at once — there is no limit ' +
  'and no paging here.';

const CREATE_DESCRIPTION =
  'Create a note folder in the local OpenWhispr app. Names must be unique: a ' +
  'duplicate comes back as folder_name_conflict listing the folders that exist. ' +
  'Creating a folder is the only folder change the bridge allows.';

/** Only two of the CRUD verbs exist upstream, so say which are missing once, here. */
const NO_RENAME_NOTE =
  'The CLI bridge can only list and create folders: it has no route to rename, move or delete one, so those have to be done in the OpenWhispr app itself.';

export function registerFolders(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'list_folders',
    title: 'List folders',
    description: LIST_DESCRIPTION,
    schema: listFoldersSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        // `all()` propagates a failure instead of degrading to an empty list:
        // "you have no folders" would be a lie the caller cannot detect.
        const folders = await createFolderIndex(routes).all();
        return { folders, count: folders.length };
      }),
  });

  defineTool(server, deps, {
    name: 'create_folder',
    title: 'Create a folder',
    description: CREATE_DESCRIPTION,
    schema: createFolderSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        const created = await routes.createFolder(args.name);
        return { created: true, folder: toFolder(created), notice: NO_RENAME_NOTE };
      }),
  });
}
