import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './deps.js';
import { registerAllResources } from './mcp/resources/index.js';
import { registerAll } from './mcp/tools/index.js';

export const SERVER_NAME = 'openwhispr';
export const SERVER_VERSION = '0.2.0';

const INSTRUCTIONS = [
  'Read-and-write access to the local OpenWhispr app (notes, folders, meeting transcripts,',
  'dictation history, custom dictionary) through the app’s loopback CLI bridge.',
  'The app must be running: every tool fails with kind "bridge_not_running" otherwise.',
  'List results are capped by the upstream API and report "complete": false when the cap was hit.',
].join(' ');

/** Builds the server. Performs no I/O — every side effect goes through `deps`. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerAll(server, deps);
  registerAllResources(server, deps);
  return server;
}
