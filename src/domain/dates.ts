/**
 * Date handling for bridge rows.
 *
 * SQLite writes `CURRENT_TIMESTAMP` as `"2026-09-08 08:31:48"` — UTC with no
 * zone marker. `new Date(s)` reads that as *local* time and silently shifts it,
 * so every timestamp leaving this server goes through `parseSqliteUtc` first.
 */

/** `YYYY-MM-DD` + separator + `HH:MM[:SS[.fff]]` + an optional zone. */
const DATETIME =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const DIGITS = /^\d+$/;
const OFFSET_WITHOUT_COLON = /^([+-]\d{2})(\d{2})$/;
const MILLISECONDS = /\.\d{3}Z$/;

/**
 * Above this a number can only be epoch milliseconds; above 1e9 only seconds.
 *
 * Shared with `transcript.ts`, which classifies segment timestamps by the same
 * two thresholds: declared twice they would drift apart, and no test comparing
 * one module at a time would catch it.
 */
export const EPOCH_MS_FLOOR = 1e11;
export const EPOCH_S_FLOOR = 1e9;

const DAY_MS = 86_400_000;

export type DateInput = string | number | null | undefined;

function fromEpochNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value > EPOCH_MS_FLOOR) return value;
  if (value > EPOCH_S_FLOOR) return value * 1000;
  // Anything smaller is a relative offset, a counter or plain garbage — not a date.
  return null;
}

/** Epoch milliseconds, or `null` for anything that is not a usable timestamp. */
export function parseSqliteUtc(value: DateInput): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return fromEpochNumber(value);
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;
  // The `timestamp` column type is unconfirmed; an epoch may arrive as text.
  if (DIGITS.test(trimmed)) return fromEpochNumber(Number(trimmed));

  const match = DATETIME.exec(trimmed);
  let normalised = trimmed;
  if (match) {
    const [, date, time, zone] = match;
    // No zone means the app wrote UTC, so say so explicitly instead of letting
    // the engine apply the local offset.
    const suffix = zone ? zone.replace(OFFSET_WITHOUT_COLON, '$1:$2') : 'Z';
    normalised = `${date}T${time}${suffix.toUpperCase() === 'Z' ? 'Z' : suffix}`;
  }

  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? null : ms;
}

/** `"2026-09-08T08:31:48Z"` from epoch milliseconds — UTC, never fractional seconds. */
export function epochToIsoZ(ms: number): string {
  return new Date(ms).toISOString().replace(MILLISECONDS, 'Z');
}

/** `"2026-09-08T08:31:48Z"` — always UTC, never fractional seconds. */
export function toIsoZ(value: DateInput): string | null {
  const ms = parseSqliteUtc(value);
  if (ms === null) return null;
  return epochToIsoZ(ms);
}

/** `"2026-09"`, bucketed in UTC so month totals do not shift with the viewer's zone. */
export function monthKey(value: DateInput): string | null {
  const ms = parseSqliteUtc(value);
  if (ms === null) return null;
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * "Not older than `days`". The boundary is inclusive and future timestamps pass:
 * a row stamped ahead of the local clock is skew, not staleness.
 */
export function withinLastDays(value: DateInput, days: number, now: number): boolean {
  if (!Number.isFinite(days) || days <= 0) return false;
  const ms = parseSqliteUtc(value);
  if (ms === null) return false;
  return ms >= now - days * DAY_MS;
}
