import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RawNote } from '../../bridge/types.js';
import type { ToolDeps } from '../../deps.js';
import { createFolderIndex, FOLDER_NAMES_UNAVAILABLE_NOTE } from '../../domain/folderIndex.js';
import { buildFtsQuery, buildSnippet, findMatchedFields, tokenize } from '../../domain/ftsQuery.js';
import { CONTENT_PREVIEW_CHARS, toNoteSummary } from '../../domain/projections.js';
import { searchNotesSchema } from '../../schemas/notes.js';
import { defineTool } from '../defineTool.js';

const DESCRIPTION =
  'Full-text (FTS5 prefix AND) search over note titles, bodies and AI-enhanced text. ' +
  'Every word becomes a required prefix term, so all of them must appear. There is no ' +
  'semantic search and no relevance score. Returns note summaries with matched_in and a ' +
  'snippet; use list_notes to browse and get_note for a full body.';

const SEMANTIC_NOTE =
  'The bridge exposes keyword search only: the app has a semantic/vector index, but it is not ' +
  'reachable over the CLI bridge, and no relevance score is returned. Rows arrive in the bridge’s ' +
  'own bm25 rank order.';

const TRUNCATED_NOTE =
  'The bridge returned exactly `limit` rows and reports no has_more, so more matches may exist: ' +
  'raise limit or add another word to narrow the query.';

const TOKENIZER_NOTE =
  'Everything except letters, digits and underscore is dropped before the query is built, and each ' +
  'surviving token becomes a prefix term: "C++" is searched as "C"* and matches every word starting ' +
  'with C. See fts_query for what the bridge actually ran.';

const OPERATOR_NOTE =
  'AND, OR, NOT and NEAR are not operators here — the bridge quotes every token, so they turn into ' +
  'ordinary required words that must appear in the note. Terms are always combined with an implicit AND.';

/** Order in which a snippet source is tried; the title is already in the summary. */
const SNIPPET_FIELDS = ['content', 'enhanced_content', 'title'] as const;

function pickSnippet(
  note: RawNote,
  tokens: string[],
): { snippet: string | null; snippet_field: string | null } {
  for (const field of SNIPPET_FIELDS) {
    const value = note[field];
    if (typeof value !== 'string' || value === '') continue;
    const snippet = buildSnippet(value, tokens, CONTENT_PREVIEW_CHARS);
    if (snippet !== null) return { snippet, snippet_field: field };
  }
  return { snippet: null, snippet_field: null };
}

export function registerSearchNotes(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'search_notes',
    title: 'Search notes',
    description: DESCRIPTION,
    schema: searchNotesSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        const folders = createFolderIndex(routes);
        // The raw query goes upstream: the bridge runs its own tokenizer, and
        // pre-building the FTS query here would double-quote every term.
        const rows = await routes.searchNotes({ q: args.q, limit: args.limit });
        const tokens = tokenize(args.q);

        const notes = [];
        for (const row of rows) {
          notes.push({
            ...toNoteSummary(row, await folders.nameOf(row.folder_id)),
            // `enhanced_content` is indexed but hidden, so a hit there would
            // otherwise look like a match on text the agent cannot see.
            matched_in: findMatchedFields(row, tokens),
            ...pickSnippet(row, tokens),
          });
        }

        const complete = rows.length < args.limit;
        return {
          notes,
          limit: args.limit,
          tokens_used: tokens,
          fts_query: buildFtsQuery(args.q),
          match_semantics: 'FTS5 prefix AND',
          score_available: false,
          complete,
          notice: complete ? SEMANTIC_NOTE : `${SEMANTIC_NOTE} ${TRUNCATED_NOTE}`,
          tokenizer_note: TOKENIZER_NOTE,
          operator_note: OPERATOR_NOTE,
          ...(folders.namesUnavailable
            ? { folder_names_unavailable: true, folder_names_note: FOLDER_NAMES_UNAVAILABLE_NOTE }
            : {}),
        };
      }),
  });
}
