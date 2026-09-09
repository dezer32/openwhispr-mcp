import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../../deps.js';

import { registerHealth } from './health.js';
import { registerListNotes } from './notes.list.js';
import { registerGetNote } from './notes.get.js';
import { registerSearchNotes } from './notes.search.js';
import { registerGetNoteTranscript } from './notes.transcript.js';
import { registerCreateNote } from './notes.create.js';
import { registerUpdateNote } from './notes.update.js';
import { registerDeleteNote } from './notes.delete.js';
import { registerFolders } from './folders.js';
import { registerTranscriptions } from './transcriptions.js';
import { registerDictionary } from './dictionary.js';
import { registerUsage } from './usage.js';

/** The 15 tools, in the order they are advertised. */
export const TOOL_NAMES = [
  'health',
  'list_notes',
  'get_note',
  'search_notes',
  'get_note_transcript',
  'create_note',
  'update_note',
  'delete_note',
  'list_folders',
  'create_folder',
  'list_transcriptions',
  'get_transcription',
  'list_dictionary',
  'update_dictionary',
  'get_usage',
] as const;

export function registerAll(server: McpServer, deps: ToolDeps): void {
  registerHealth(server, deps);
  registerListNotes(server, deps);
  registerGetNote(server, deps);
  registerSearchNotes(server, deps);
  registerGetNoteTranscript(server, deps);
  registerCreateNote(server, deps);
  registerUpdateNote(server, deps);
  registerDeleteNote(server, deps);
  registerFolders(server, deps);
  registerTranscriptions(server, deps);
  registerDictionary(server, deps);
  registerUsage(server, deps);
}
