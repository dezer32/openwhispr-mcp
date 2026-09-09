import { Buffer } from 'node:buffer';
import type { RequestSpec } from '../deps.js';
import type { Envelope, ErrorEnvelope } from './types.js';
import {
  BridgeHttpError,
  BridgeTransportError,
  OpenWhisprError,
  kindForStatus,
} from './errors.js';

export interface HttpClientOptions {
  host: string;
  port: number;
  token: string;
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** Session-level cancellation, combined with the per-request timeout. */
  signal?: AbortSignal;
}

/** Upstream error text may carry SQL and filesystem paths, so it is kept short. */
const MAX_UPSTREAM_MESSAGE_CHARS = 200;

const UNREACHABLE_HINT =
  'The handshake file is stale or the app stopped: restart OpenWhispr and retry.';

const TIMEOUT_HINT = 'The app may be busy; retry, or raise OPENWHISPR_MCP_TIMEOUT_MS.';

const RESPONSE_TOO_LARGE_HINT =
  'Ask for fewer rows (lower `limit`) or raise OPENWHISPR_MCP_MAX_RESPONSE_BYTES.';

/**
 * Nothing on a failing call says whether the app processed the request. A POST
 * that timed out, lost its socket, or answered more than we would read may well
 * have committed — so `create_note` retried blindly leaves the user with two
 * identical notes. Retrying a read costs nothing, so only `spec.mutating` gets
 * this warning, and it comes first because it is what must not be skipped.
 */
const MUTATION_UNCERTAIN_ACTION =
  'Do NOT repeat it blindly: check the current state first with list_notes, get_note or list_folders, and only retry if the change is not there.';

const MUTATION_UNCERTAIN_HINT =
  `This request changes data and may already have been applied even though no answer came back. ${MUTATION_UNCERTAIN_ACTION}`;

/** The answer did arrive here — it was only too large to read — so a write is likelier still. */
const MUTATION_UNREAD_ANSWER_HINT =
  `This request changes data and the app did answer it; only the answer could not be read in full, so the change may well have been applied. ${MUTATION_UNCERTAIN_ACTION}`;

function transportHint(mutating: boolean, readHint: string, mutatingTail: string): string {
  return mutating ? `${MUTATION_UNCERTAIN_HINT} ${mutatingTail}` : readHint;
}

function buildUrl(spec: RequestSpec, options: HttpClientOptions): URL {
  const url = new URL(`http://${options.host}:${options.port}${spec.path}`);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

/** Walks the `cause` chain undici hides its socket errors behind. */
function describeFailure(err: unknown): { code?: string; message: string } {
  const messages: string[] = [];
  let code: string | undefined;
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    const node = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === undefined && typeof node.code === 'string') code = node.code;
    if (typeof node.message === 'string') messages.push(node.message);
    current = node.cause;
  }
  return { code, message: messages.join(': ') || String(err) };
}

/**
 * Discriminates the three ways a `fetch` can fail. The external signal is checked
 * first: `AbortSignal.any` leaves it untouched when only the timeout fires.
 */
function transportFailure(
  err: unknown,
  spec: RequestSpec,
  options: HttpClientOptions,
  timeout: AbortSignal,
): BridgeTransportError {
  const mutating = spec.mutating === true;
  if (options.signal?.aborted) {
    return new BridgeTransportError('cancelled', 'the bridge request was cancelled', {
      ...(mutating ? { hint: MUTATION_UNCERTAIN_HINT } : {}),
      cause: err,
    });
  }
  if (timeout.aborted) {
    return new BridgeTransportError('timeout', `the bridge did not answer within ${options.timeoutMs} ms`, {
      hint: transportHint(
        mutating,
        TIMEOUT_HINT,
        'If it did not go through, raise OPENWHISPR_MCP_TIMEOUT_MS before sending it again.',
      ),
      details: { timeoutMs: options.timeoutMs },
      cause: err,
    });
  }
  // Everything left is a socket-level fault — ECONNREFUSED against a stale port,
  // ECONNRESET / "socket hang up" when the app quit mid-call, EHOSTUNREACH.
  const { code, message } = describeFailure(err);
  return new BridgeTransportError('bridge_unreachable', `cannot reach the bridge: ${message}`, {
    hint: transportHint(
      mutating,
      UNREACHABLE_HINT,
      'The handshake file is stale or the app stopped: restart OpenWhispr before deciding.',
    ),
    details: code === undefined ? undefined : { code },
    cause: err,
  });
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'data' in value;
}

/** Streams the body, cancelling as soon as the budget is blown. */
async function readCapped(res: Response, limit: number, mutating: boolean): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BridgeTransportError(
        'response_too_large',
        `the bridge response exceeded the ${limit} byte limit`,
        {
          // "Ask for fewer rows" is advice to send the call again, which for a
          // write means writing again — the answer was cut off, not the write.
          hint: mutating
            ? `${MUTATION_UNREAD_ANSWER_HINT} Raise OPENWHISPR_MCP_MAX_RESPONSE_BYTES so the answer can be read at all.`
            : RESPONSE_TOO_LARGE_HINT,
          details: { limit },
        },
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The raw upstream text goes to `upstreamMessage` and nowhere else: `message` is
 * always shown to the agent, `upstreamMessage` only under OPENWHISPR_MCP_DEBUG.
 * Leaving `message` unset keeps the safe `bridge returned HTTP <status>` default.
 */
function httpError(status: number, text: string): BridgeHttpError {
  let code: string | undefined;
  let upstreamMessage: string | undefined;
  try {
    const parsed = JSON.parse(text) as ErrorEnvelope;
    const envelope = parsed?.error;
    if (envelope && typeof envelope === 'object') {
      if (typeof envelope.code === 'string') code = envelope.code;
      if (typeof envelope.message === 'string') upstreamMessage = envelope.message;
    }
  } catch {
    // Not the documented envelope — keep a short excerpt of whatever came back.
  }
  if (upstreamMessage === undefined && text.trim() !== '') {
    upstreamMessage = text.slice(0, MAX_UPSTREAM_MESSAGE_CHARS);
  }
  return new BridgeHttpError({
    status,
    kind: kindForStatus(status),
    upstreamCode: code,
    upstreamMessage,
  });
}

/**
 * Performs one bridge call and unwraps `{data}`. A `204` resolves to `undefined`
 * without touching the body.
 */
export async function bridgeRequest<T>(spec: RequestSpec, options: HttpClientOptions): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/json',
  };

  let body: string | undefined;
  if (spec.body !== undefined) {
    body = JSON.stringify(spec.body);
    const bytes = Buffer.byteLength(body);
    if (bytes > options.maxRequestBytes) {
      throw new BridgeTransportError(
        'request_too_large',
        `the request body is ${bytes} bytes, over the ${options.maxRequestBytes} byte bridge limit`,
        {
          hint: 'Split the content into smaller notes or shorten it.',
          details: { bytes, limit: options.maxRequestBytes },
        },
      );
    }
    headers['content-type'] = 'application/json';
  }

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  let res: Response;
  try {
    res = await fetch(buildUrl(spec, options), { method: spec.method, headers, body, signal });
  } catch (err) {
    throw transportFailure(err, spec, options, timeout);
  }

  if (res.status === 204) return undefined as T;

  let text: string;
  try {
    text = await readCapped(res, options.maxResponseBytes, spec.mutating === true);
  } catch (err) {
    if (err instanceof OpenWhisprError) throw err;
    throw transportFailure(err, spec, options, timeout);
  }

  if (!res.ok) throw httpError(res.status, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BridgeTransportError(
      'upstream_protocol',
      `the bridge answered HTTP ${res.status} with a body that is not JSON`,
      { details: { status: res.status, path: spec.path }, cause: err },
    );
  }

  // The bridge always sends `{data}`, and for a list it adds `has_more: false`
  // and `next_cursor: null` — both hardcoded upstream, so they are deliberately
  // never read. An app update that drops the envelope must not silently become
  // an `undefined` result, so the shape is checked rather than assumed.
  if (isEnvelope(parsed)) return parsed.data as T;
  return parsed as T;
}
