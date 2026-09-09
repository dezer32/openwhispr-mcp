import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from '../../deps.js';
import { logInfo } from '../../log.js';
import { defineTool } from '../defineTool.js';

/**
 * The handshake is volatile by design, so the agent is told rather than left to
 * infer why an id or a port it cached a minute ago no longer works.
 */
const HANDSHAKE_NOTE =
  'Port and token are regenerated on every app restart; this server re-reads the handshake file on each call.';

const DESCRIPTION =
  'Check that the local OpenWhispr app is running and its CLI bridge is reachable. ' +
  'Returns the bridge host and port, the handshake file path and the app version. ' +
  'Call this first when another tool fails with bridge_not_running, bridge_unreachable ' +
  'or unauthorized — the port and token change on every app restart.';

export function registerHealth(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'health',
    title: 'Check the OpenWhispr bridge',
    description: DESCRIPTION,
    schema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (_args, ctx) =>
      ctx.deps.withSession({ signal: ctx.signal }, async (routes, session) => {
        const raw = await routes.health();
        const status = typeof raw?.status === 'string' ? raw.status : null;
        // Several instances may be up on 8200-8219 and the handshake file keeps
        // only the last writer, so the port is the one way to know who answered.
        logInfo('bridge health', { host: session.host, port: session.port, status });
        return {
          ok: status === null || status === 'ok',
          bridge: {
            host: session.host,
            port: session.port,
            config_path: ctx.deps.config.bridgeConfigPath,
          },
          upstream: {
            status,
            version: typeof raw?.version === 'string' ? raw.version : null,
          },
          notice: HANDSHAKE_NOTE,
        };
      }),
  });
}
