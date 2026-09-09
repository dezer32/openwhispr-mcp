import { loadConfig, type Config } from './config.js';
import { createTtlStore } from './domain/snapshotStore.js';
import { withBridgeSession } from './bridge/session.js';
import type { ToolDeps } from './deps.js';

export const SNAPSHOT_TTL_MS = 120_000;
export const SNAPSHOT_MAX_ENTRIES = 3;

export interface RuntimeOptions {
  config?: Config;
  now?: () => number;
}

/** Wires the production dependencies. Tests build their own `ToolDeps`. */
export function createDeps(options: RuntimeOptions = {}): ToolDeps {
  const config = options.config ?? loadConfig();
  const now = options.now ?? (() => Date.now());
  const snapshots = createTtlStore<unknown>({
    ttlMs: SNAPSHOT_TTL_MS,
    maxEntries: SNAPSHOT_MAX_ENTRIES,
    now,
  });
  return {
    config,
    now,
    snapshots,
    withSession: (sessionOptions, fn) => withBridgeSession(config, sessionOptions, fn),
  };
}
