import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from '../../deps.js';

import { registerTranscriptResource } from './transcript.js';

/**
 * The resources this server publishes. Their URI shape lives in
 * `domain/transcriptUri.ts`, which the note projections read too.
 *
 * Registering any resource at all makes the SDK declare
 * `resources.listChanged: true` by itself (`server/mcp.js`), which is a promise
 * of notifications this server does not send: a transcript changes only when the
 * app re-records a note, and nothing here watches for that. A client that
 * re-lists on its own schedule sees the change; one that waits to be told will not.
 */
export function registerAllResources(server: McpServer, deps: ToolDeps): void {
  registerTranscriptResource(server, deps);
}
