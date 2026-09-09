import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default location of the bridge handshake file written by the OpenWhispr app. */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.openwhispr', 'cli-bridge.json');

/** The bridge only ever binds loopback; anything else is rejected with 403 upstream. */
export const BRIDGE_HOST = '127.0.0.1';

/**
 * Ceiling this server puts on a single list read, in place of the pagination the
 * bridge does not have. It caps the `list_notes` snapshot and the
 * `list_transcriptions` limit. `get_usage` deliberately reads past it for
 * transcriptions: it aggregates counts rather than returning the rows.
 */
export const MAX_UPSTREAM_LIMIT = 500;

/** Bridge rejects request bodies above 1 MiB; we check locally before sending. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** The bridge does not cap response size, so the client does. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Hard ceiling on the JSON text a single tool may return. */
export const DEFAULT_MAX_RESULT_CHARS = 400_000;

export interface Config {
  bridgeConfigPath: string;
  maxUpstreamLimit: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
  maxResultChars: number;
  /** When true, raw upstream error messages are echoed back to the agent. */
  debug: boolean;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function isDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENWHISPR_MCP_DEBUG;
  return raw === '1' || raw === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    bridgeConfigPath: env.OPENWHISPR_BRIDGE_CONFIG?.trim() || DEFAULT_CONFIG_PATH,
    maxUpstreamLimit: MAX_UPSTREAM_LIMIT,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxResponseBytes: intFromEnv(env.OPENWHISPR_MCP_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
    timeoutMs: intFromEnv(env.OPENWHISPR_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxResultChars: intFromEnv(env.OPENWHISPR_MCP_MAX_RESULT_CHARS, DEFAULT_MAX_RESULT_CHARS),
    debug: isDebug(env),
  };
}
