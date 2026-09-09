import {
  BridgeHttpError,
  OpenWhisprError,
  type ErrorKind,
  type ToolErrorPayload,
} from '../bridge/errors.js';
import type { RawFolder } from '../bridge/types.js';
import { logWarn } from '../log.js';
import type { ToolDeps } from '../deps.js';

export interface MapErrorContext {
  deps: ToolDeps;
  toolName: string;
  signal?: AbortSignal;
}

interface DomainRule {
  pattern: RegExp;
  kind: ErrorKind;
  message: string;
  hint: string;
}

/**
 * Anchors a known bridge message so a stray substring — `"note: Folder not
 * found there"` — cannot trigger the mapping, while still tolerating the
 * wrappers the bridge may add (`Error: <text>`, a trailing period).
 */
function anchored(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:\\w*error:\\s*)?${escaped}\\.?$`, 'i');
}

/**
 * The bridge reports its domain failures as HTTP 500 `internal_error`, so the
 * status code carries no information and the message is all we have. Ordered
 * most specific first; anchoring makes the order documentation rather than a
 * correctness requirement.
 */
const DOMAIN_RULES: DomainRule[] = [
  {
    pattern: anchored('Folder not found in the active account scope'),
    kind: 'folder_not_found',
    message: 'the folder is not visible in the account scope the app is signed into',
    hint: 'Call list_folders and use one of the ids it returns; folders from another account or space are invisible here.',
  },
  {
    pattern: anchored('Folder not found'),
    kind: 'folder_not_found',
    message: 'the folder does not exist',
    hint: 'Call list_folders and use one of the ids it returns.',
  },
  {
    pattern: anchored('A folder with that name already exists'),
    kind: 'folder_name_conflict',
    message: 'a folder with that name already exists',
    hint: 'Pick a different name, or reuse the existing folder id from list_folders.',
  },
  {
    pattern: anchored('Folder name is required'),
    kind: 'invalid_argument',
    message: 'the folder name must be a non-empty string',
    hint: 'Pass a name with at least one non-whitespace character.',
  },
  {
    pattern: anchored('Failed to write note'),
    kind: 'write_failed',
    message: 'the app rejected the write',
    hint: 'The bridge reports write failures without a reason, so there is nothing specific to correct here. Retry once; if it keeps failing, check the OpenWhispr app itself.',
  },
];

/** A SQL error that escaped the app: the bridge validates no input at all. */
const SQLITE_FAULT = /^(?:\w*error:\s*)?(?:datatype mismatch|SQLITE_[A-Z_]+)/i;

const SQLITE_HINT =
  'Most likely an invalid argument leaked into SQL — the bridge does not validate its inputs. Re-check argument types (numeric ids, integer limits); report this if they look right.';

const ENRICHED_KINDS = new Set<ErrorKind>(['folder_not_found', 'folder_name_conflict']);

const AVAILABLE_FOLDERS_NOTE =
  'available_folders was read after the failure, so it may already come from a different app instance — the bridge port and token change on every app restart.';

/**
 * Normalises anything thrown inside a tool handler into the payload the agent
 * sees. Raw upstream text always reaches stderr; it only reaches the agent when
 * `OPENWHISPR_MCP_DEBUG=1`, because after an app update it may carry SQL and paths.
 */
export async function mapToolError(err: unknown, ctx: MapErrorContext): Promise<ToolErrorPayload> {
  if (err instanceof OpenWhisprError) {
    const payload = err instanceof BridgeHttpError ? mapHttpError(err, ctx) : err.toPayload();
    return withAvailableFolders(payload, ctx);
  }

  if (isAbortError(err)) {
    return { kind: 'cancelled', message: 'the tool call was cancelled before it finished' };
  }

  logWarn('unexpected tool failure', {
    tool: ctx.toolName,
    error: err instanceof Error ? err.stack ?? err.message : describe(err),
  });
  return {
    kind: 'internal_bug',
    message: describe(err),
    hint: 'This is a bug in openwhispr-mcp. Re-run with OPENWHISPR_MCP_DEBUG=1 for details.',
  };
}

function mapHttpError(err: BridgeHttpError, ctx: MapErrorContext): ToolErrorPayload {
  const upstream = (err.upstreamMessage ?? '').trim();
  // Falls back to `message` in case the client put the domain text there; the
  // patterns are anchored, so a generic `bridge returned HTTP 500` matches none.
  const probe = upstream || err.message.trim();

  logWarn('bridge error', {
    tool: ctx.toolName,
    status: err.status,
    code: err.upstreamCode,
    upstream: probe,
  });

  const payload = err.toPayload();
  const rule = DOMAIN_RULES.find((candidate) => candidate.pattern.test(probe));
  if (rule) {
    payload.kind = rule.kind;
    payload.message = rule.message;
    payload.hint = rule.hint;
  } else if (SQLITE_FAULT.test(probe)) {
    payload.kind = 'internal_bug';
    payload.message = 'the app hit a database error';
    payload.hint = SQLITE_HINT;
  }

  payload.details = { ...(payload.details ?? {}), http_status: err.status };
  if (ctx.deps.config.debug && upstream) {
    payload.details.upstream_message = upstream;
  }
  return payload;
}

/**
 * Folder ids only become checkable after the app rejects one, and pre-validating
 * every call would cost a request on the happy path — so the list is fetched
 * lazily, exactly once, and only for the two kinds that can use it.
 */
async function withAvailableFolders(
  payload: ToolErrorPayload,
  ctx: MapErrorContext,
): Promise<ToolErrorPayload> {
  if (!ENRICHED_KINDS.has(payload.kind) || ctx.signal?.aborted) return payload;

  try {
    const folders = await ctx.deps.withSession({ signal: ctx.signal }, (routes) => routes.listFolders());
    payload.details = {
      ...(payload.details ?? {}),
      available_folders: (folders ?? []).map((folder: RawFolder) => ({
        id: folder.id,
        name: folder.name ?? null,
      })),
      available_folders_note: AVAILABLE_FOLDERS_NOTE,
    };
  } catch (lookupFailure) {
    // The original failure is what the agent must act on; a failed lookup on top
    // of it must never replace or mask it.
    logWarn('available_folders lookup failed', {
      tool: ctx.toolName,
      error: describe(lookupFailure),
    });
  }
  return payload;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Never throws: a thrown value may be an object with no prototype at all. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return '<a thrown value that cannot be converted to a string>';
  }
}
