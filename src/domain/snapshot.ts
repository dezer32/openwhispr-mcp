import { randomBytes } from 'node:crypto';
import { ToolError } from '../bridge/errors.js';
import type { NoteSummary } from './projections.js';

/**
 * Snapshot pagination for `list_notes`.
 *
 * A real keyset cursor is impossible over this bridge: there is no server-side
 * predicate to resume from, and `ORDER BY updated_at DESC` carries no secondary
 * key — with `LIMIT` applied, rows sharing an `updated_at` may come back in any
 * subset and any order. Resuming with `updated_at < last_seen` would therefore
 * both skip and duplicate rows without ever saying so.
 *
 * So pages are cut from a snapshot instead: one upstream read, projected down to
 * summaries and held in memory, sliced by index. Inside a snapshot `has_more` is
 * exact. The honest cost is that the snapshot ages and expires — which the tool
 * reports rather than hides.
 */

export interface SnapshotFilters {
  note_type?: string;
  folder_id?: number;
}

export interface NoteSnapshot {
  id: string;
  /** Identifies the filter set the rows were read with; see `fingerprintFilters`. */
  fingerprint: string;
  createdAt: number;
  rows: NoteSummary[];
  /** The upstream read came back at exactly the cap, so rows are likely missing. */
  saturated: boolean;
  /**
   * The folder listing failed while the snapshot was built, so every
   * `folder_name` in `rows` is null. Pages 2..N never touch the bridge, so the
   * fact has to travel with the snapshot or it is lost after the first page.
   */
  folderNamesUnavailable: boolean;
}

export interface Cursor {
  v: 1;
  /** Snapshot id. */
  s: string;
  /** Index of the first row of the next page. */
  i: number;
}

export interface FilterDrift {
  field: string;
  snapshot: string | null;
  current: string | null;
}

export const CURSOR_VERSION = 1;

/**
 * The filters that decide *which rows* a snapshot holds. `page_size` is
 * deliberately absent: it changes how the rows are cut, not the set, so the same
 * snapshot stays valid when the caller asks for a different page size.
 */
const FILTER_FIELDS = ['note_type', 'folder_id'] as const;

const ABSENT = '*';
const CURSOR_HINT =
  'Pass a next_cursor value from a previous list_notes result verbatim, or omit cursor to start a new listing.';

export function newSnapshotId(): string {
  return randomBytes(9).toString('base64url');
}

export function fingerprintFilters(filters: SnapshotFilters): string {
  return FILTER_FIELDS.map((field) => {
    const value = filters[field];
    const encoded =
      value === undefined || value === null ? ABSENT : encodeURIComponent(String(value));
    return `${field}=${encoded}`;
  }).join(';');
}

function parseFingerprint(fingerprint: string): Map<string, string | null> {
  const parsed = new Map<string, string | null>();
  for (const part of fingerprint.split(';')) {
    if (part === '') continue;
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const field = part.slice(0, separator);
    const raw = part.slice(separator + 1);
    parsed.set(field, raw === ABSENT ? null : safeDecode(raw));
  }
  return parsed;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A fingerprint is our own output, so this is unreachable in practice; a
    // malformed escape must still not take the whole tool call down.
    return value;
  }
}

/**
 * Which filters differ between the snapshot and the current call. The tool turns
 * this into an error that names the field, so the agent is not left guessing why
 * its cursor was refused.
 */
export function fingerprintDrift(snapshot: string, current: string): FilterDrift[] {
  const before = parseFingerprint(snapshot);
  const after = parseFingerprint(current);
  const fields = new Set([...before.keys(), ...after.keys()]);

  const drift: FilterDrift[] = [];
  for (const field of fields) {
    const snapshotValue = before.get(field) ?? null;
    const currentValue = after.get(field) ?? null;
    if (snapshotValue !== currentValue) {
      drift.push({ field, snapshot: snapshotValue, current: currentValue });
    }
  }
  return drift;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function reject(reason: string): never {
  throw new ToolError('invalid_argument', `the cursor is not usable: ${reason}`, {
    hint: CURSOR_HINT,
  });
}

export function decodeCursor(raw: string): Cursor {
  if (typeof raw !== 'string' || raw.trim() === '') reject('it is empty');

  let parsed: unknown;
  try {
    // `Buffer.from(_, 'base64url')` silently drops invalid characters rather
    // than throwing, so the JSON parse below is what actually rejects garbage.
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    reject('it is not a cursor produced by list_notes');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reject('it is not a cursor produced by list_notes');
  }

  const candidate = parsed as Partial<Cursor>;
  if (candidate.v !== CURSOR_VERSION) {
    reject(`cursor version ${JSON.stringify(candidate.v)} is not supported by this server`);
  }
  if (typeof candidate.s !== 'string' || candidate.s === '') {
    reject('it carries no snapshot id');
  }
  if (typeof candidate.i !== 'number' || !Number.isInteger(candidate.i) || candidate.i < 0) {
    reject('its offset is not a non-negative integer');
  }

  return { v: CURSOR_VERSION, s: candidate.s, i: candidate.i };
}

/**
 * `nextIndex` is `null` at the end of the snapshot even when it is saturated:
 * a cursor pointing past the last row would slice an empty page while data does
 * exist upstream, which reads as "no more notes" and is a lie.
 */
export function sliceSnapshot(
  snapshot: NoteSnapshot,
  offset: number,
  pageSize: number,
): { rows: NoteSummary[]; nextIndex: number | null } {
  const total = snapshot.rows.length;
  const start = Math.min(Math.max(0, offset), total);
  const end = Math.min(total, start + Math.max(0, pageSize));
  return {
    rows: snapshot.rows.slice(start, end),
    nextIndex: end < total ? end : null,
  };
}
