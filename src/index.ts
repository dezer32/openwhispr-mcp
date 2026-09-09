#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDeps } from './runtime.js';
import { createServer, SERVER_VERSION } from './server.js';
import { logError, logInfo } from './log.js';

const USAGE = `openwhispr-mcp ${SERVER_VERSION} — MCP server for the local OpenWhispr app.

It speaks MCP over stdio and takes no arguments: an MCP client spawns it and owns
both ends of the pipe. Run it by hand only to check that the install works.

Usage
  npx -y openwhispr-mcp              start the server on stdio
  npx -y openwhispr-mcp --version    print the version and exit
  npx -y openwhispr-mcp --help       print this text and exit

Register it with Claude Code
  claude mcp add --scope user openwhispr -- npx -y openwhispr-mcp

Requirements
  The OpenWhispr app must be running: its CLI bridge only exists while it is up.

Environment
  OPENWHISPR_BRIDGE_CONFIG           handshake file (default ~/.openwhispr/cli-bridge.json)
  OPENWHISPR_MCP_DEBUG               echo raw upstream error text back to the agent
  OPENWHISPR_MCP_TIMEOUT_MS          per-request timeout in ms (default 20000)
  OPENWHISPR_MCP_MAX_RESPONSE_BYTES  response byte cap (default 67108864)
  OPENWHISPR_MCP_MAX_RESULT_CHARS    cap on a tool's JSON result (default 400000)
`;

async function main(): Promise<void> {
  const deps = createDeps();
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo('server ready on stdio', { config_path: deps.config.bridgeConfigPath });
}

/**
 * stdout belongs to the MCP transport, but only from the moment `main` connects
 * it. These two flags answer and exit before that, so they may use it — an
 * unrecognised argument is left alone and still starts the server, because a
 * client that grows a new flag must not be met with a dead process.
 */
const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write(`openwhispr-mcp ${SERVER_VERSION}\n`);
} else if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE);
} else {
  main().catch((err: unknown) => {
    logError('fatal', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
    process.exitCode = 1;
  });
}
