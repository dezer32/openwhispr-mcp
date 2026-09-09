/**
 * Error taxonomy shared by the bridge client and the MCP error mapper.
 *
 * Anything an agent can react to travels as a typed error and is rendered as an
 * `isError: true` tool result. Genuine programming faults are left to throw.
 */

export type ErrorKind =
  // discovery / handshake
  | 'bridge_not_running'
  | 'config_unreadable'
  | 'config_invalid'
  // transport
  | 'bridge_unreachable'
  | 'timeout'
  | 'cancelled'
  | 'response_too_large'
  | 'request_too_large'
  | 'upstream_protocol'
  // upstream status codes
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_argument'
  | 'upstream_error'
  // domain errors the bridge reports as HTTP 500
  | 'folder_not_found'
  | 'folder_name_conflict'
  | 'write_failed'
  | 'internal_bug'
  // MCP-side domain errors
  | 'snapshot_expired'
  | 'transcript_changed';

export interface ToolErrorPayload {
  kind: ErrorKind;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export interface OpenWhisprErrorInit {
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Base class for every error that becomes a structured tool result. */
export class OpenWhisprError extends Error {
  readonly kind: ErrorKind;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(kind: ErrorKind, message: string, init: OpenWhisprErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.kind = kind;
    this.hint = init.hint;
    this.details = init.details;
  }

  toPayload(): ToolErrorPayload {
    const payload: ToolErrorPayload = { kind: this.kind, message: this.message };
    if (this.hint) payload.hint = this.hint;
    if (this.details && Object.keys(this.details).length > 0) payload.details = this.details;
    return payload;
  }
}

/** Handshake file missing, unreadable or malformed. */
export class BridgeConfigError extends OpenWhisprError {}

/** Socket-level failure: refused, timed out, cancelled, oversized or unparseable. */
export class BridgeTransportError extends OpenWhisprError {}

/**
 * A non-2xx HTTP response. The raw upstream message is carried separately so it
 * only reaches the agent under `OPENWHISPR_MCP_DEBUG=1` — after an app update it
 * may contain SQL fragments or filesystem paths.
 */
export class BridgeHttpError extends OpenWhisprError {
  readonly status: number;
  readonly upstreamCode: string | undefined;
  readonly upstreamMessage: string | undefined;

  constructor(
    args: {
      status: number;
      kind?: ErrorKind;
      message?: string;
      upstreamCode?: string;
      upstreamMessage?: string;
    },
    init: OpenWhisprErrorInit = {},
  ) {
    super(args.kind ?? kindForStatus(args.status), args.message ?? `bridge returned HTTP ${args.status}`, init);
    this.status = args.status;
    this.upstreamCode = args.upstreamCode;
    this.upstreamMessage = args.upstreamMessage;
  }
}

/** Domain error raised by the MCP layer itself (expired snapshot, changed transcript, …). */
export class ToolError extends OpenWhisprError {}

export function kindForStatus(status: number): ErrorKind {
  switch (status) {
    case 400:
      return 'invalid_argument';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    default:
      return 'upstream_error';
  }
}

export function isUnauthorized(err: unknown): err is BridgeHttpError {
  return err instanceof BridgeHttpError && err.status === 401;
}
