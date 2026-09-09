import { isDebug } from './config.js';

/**
 * stdout belongs to the MCP stdio transport. Every diagnostic goes to stderr —
 * a single `console.log` here corrupts the protocol stream.
 */
type Fields = Record<string, unknown>;

const SECRET_KEYS = /^(token|authorization|auth|secret|password)$/i;

/** Replaces anything that looks like a credential with a length-only marker. */
export function redact(fields: Fields | undefined): Fields | undefined {
  if (!fields) return undefined;
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = typeof v === 'string' ? `<redacted:${v.length}>` : '<redacted>';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Fields);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: string, message: string, fields?: Fields): void {
  const payload = redact(fields);
  const suffix = payload && Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : '';
  process.stderr.write(`[openwhispr-mcp] ${level} ${message}${suffix}\n`);
}

export function logDebug(message: string, fields?: Fields): void {
  if (!isDebug()) return;
  emit('debug', message, fields);
}

export function logInfo(message: string, fields?: Fields): void {
  emit('info', message, fields);
}

export function logWarn(message: string, fields?: Fields): void {
  emit('warn', message, fields);
}

export function logError(message: string, fields?: Fields): void {
  emit('error', message, fields);
}
