import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeRoutes, ToolDeps } from '../../deps.js';
import { normalizeDictionary, type DictionaryView } from '../../domain/usage.js';
import {
  listDictionarySchema,
  normalizeWordList,
  updateDictionarySchema,
} from '../../schemas/writes.js';
import { defineTool } from '../defineTool.js';

const LIST_DESCRIPTION =
  'List the custom dictionary of the local OpenWhispr app — the words the ' +
  'transcriber is told to spell a particular way (product names, jargon, names ' +
  'of people). Returns the words themselves plus the shape the app stored them in.';

const UPDATE_DESCRIPTION =
  'Add or remove words in the custom dictionary of the local OpenWhispr app. ' +
  'Words are trimmed and de-duplicated, and case is significant. Returns what ' +
  'was sent plus the dictionary as it reads back afterwards.';

const UNREADABLE_SHAPE_WARNING =
  'The bridge answered with a dictionary shape this server does not recognise (it accepts a list of strings, a list of {word} rows, or {words: [...]}). The word list is reported as empty because nothing could be read out of it — that is not the same as the dictionary being empty.';

interface DictionaryPayload {
  words: string[];
  count: number;
  raw_shape: string;
  warning?: string;
}

function payloadFor(view: DictionaryView): DictionaryPayload {
  const payload: DictionaryPayload = {
    words: view.words,
    count: view.words.length,
    raw_shape: view.raw_shape,
  };
  if (view.raw_shape === 'unrecognized') payload.warning = UNREADABLE_SHAPE_WARNING;
  else if (view.unrecognized_entries > 0) {
    payload.warning = `${view.unrecognized_entries} entries were skipped: they were neither a string nor a {word} row. The word list below is what could be read.`;
  }
  return payload;
}

/** The bridge's dictionary payload is not contractual, so it is normalised on the way out. */
async function readDictionary(routes: BridgeRoutes): Promise<DictionaryPayload> {
  return payloadFor(normalizeDictionary(await routes.listDictionary()));
}

export function registerDictionary(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'list_dictionary',
    title: 'List dictionary words',
    description: LIST_DESCRIPTION,
    schema: listDictionarySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, (routes) => readDictionary(routes)),
  });

  defineTool(server, deps, {
    name: 'update_dictionary',
    title: 'Update dictionary words',
    description: UPDATE_DESCRIPTION,
    schema: updateDictionarySchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        const add = normalizeWordList(args.add);
        const remove = normalizeWordList(args.remove);
        const sent = {
          ...(add.length > 0 ? { add } : {}),
          ...(remove.length > 0 ? { remove } : {}),
        };

        await routes.updateDictionary(sent);
        // The update answers with no useful body, so the list is read back. Note
        // that the write has already committed: a 401 on this read cannot be
        // replayed and surfaces as unauthorized rather than a silent retry.
        return { updated: true, sent, ...(await readDictionary(routes)) };
      }),
  });
}
