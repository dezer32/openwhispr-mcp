import { readFile } from 'node:fs/promises';
import { BRIDGE_HOST } from '../config.js';
import { logDebug } from '../log.js';
import { BridgeConfigError } from './errors.js';

export interface BridgeHandshake {
  host: string;
  port: number;
  token: string;
  /** Path the handshake was read from, for diagnostics. */
  path: string;
}

const START_HINT =
  'Start the OpenWhispr app (the bridge writes ~/.openwhispr/cli-bridge.json while it runs).';

/**
 * The file holds the live token, so neither its contents nor any excerpt of them
 * may reach a message, a log line or `details`.
 */
function invalid(path: string, reason: string): BridgeConfigError {
  return new BridgeConfigError('config_invalid', `bridge handshake file is invalid: ${reason}`, {
    hint: 'The file was written by another program or by an incompatible app version; restart OpenWhispr.',
    details: { path },
  });
}

/**
 * Reads and validates `~/.openwhispr/cli-bridge.json`.
 *
 * The port is deliberately not checked against 8200-8219: the app only scans that
 * window, it does not promise to stay in it.
 */
export async function readBridgeConfig(path: string): Promise<BridgeHandshake> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new BridgeConfigError('bridge_not_running', `no bridge handshake file at ${path}`, {
        hint: START_HINT,
        details: { path },
        cause: err,
      });
    }
    throw new BridgeConfigError('config_unreadable', `cannot read the bridge handshake file at ${path}`, {
      hint: 'Check that the file is owned by you and readable (the app writes it with mode 0600).',
      details: { path, code },
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid(path, 'not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(path, 'not a JSON object');
  }

  const file = parsed as Record<string, unknown>;

  const port = file.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid(path, 'port is not an integer in 1..65535');
  }

  const token = file.token;
  if (typeof token !== 'string' || token.trim() === '') {
    throw invalid(path, 'token is missing or empty');
  }

  // The bridge only ever binds loopback, so any other host means a forged file.
  const host = file.host === undefined ? BRIDGE_HOST : file.host;
  if (host !== BRIDGE_HOST) {
    throw invalid(path, `host is not the loopback address ${BRIDGE_HOST}`);
  }

  logDebug('bridge handshake', { path, host, port });
  return { host, port, token, path };
}
