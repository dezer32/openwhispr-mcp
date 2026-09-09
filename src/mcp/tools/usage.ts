import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../../deps.js';
import { buildUsageReport } from '../../domain/usage.js';
import { getUsageSchema } from '../../schemas/usage.js';
import { defineTool } from '../defineTool.js';

const DESCRIPTION =
  'Summarise what is stored in the local OpenWhispr app: how many notes, ' +
  'folders, transcriptions and dictionary words there are, split by type, ' +
  'folder and month, with word, character and audio totals. Counts come from a ' +
  'capped read, and the reply lists exactly what it cannot see.';

export function registerUsage(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'get_usage',
    title: 'Summarise stored data',
    description: DESCRIPTION,
    schema: getUsageSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        // One session, so all four lists come from the same app instance on the
        // same pinned port — counters stitched from two instances would be
        // nonsense. `SELECT *` already carries everything the report needs, so
        // there is no per-note follow-up.
        const [folders, notes, transcriptions, dictionary] = await Promise.all([
          routes.listFolders(),
          routes.listNotes({ limit: args.notes_limit }),
          routes.listTranscriptions({ limit: args.transcriptions_limit }),
          routes.listDictionary(),
        ]);

        return buildUsageReport(
          { folders, notes, transcriptions, dictionary },
          {
            now: ctx.deps.now(),
            notesLimit: args.notes_limit,
            transcriptionsLimit: args.transcriptions_limit,
            includeTranscriptStats: args.include_transcript_stats,
          },
        );
      }),
  });
}
