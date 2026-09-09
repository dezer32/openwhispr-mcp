#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDeps } from './runtime.js';
import { createServer } from './server.js';
import { logError, logInfo } from './log.js';

async function main(): Promise<void> {
  const deps = createDeps();
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo('server ready on stdio', { config_path: deps.config.bridgeConfigPath });
}

main().catch((err: unknown) => {
  logError('fatal', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exitCode = 1;
});
