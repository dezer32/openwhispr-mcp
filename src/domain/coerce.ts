/**
 * The handful of primitives every projection needs when reading bridge rows.
 *
 * They lived in three modules at once — `projections.ts`, `transcript.ts` and
 * `usage.ts` — with identical bodies, which is a seam: raising a threshold or
 * accepting one more numeric spelling in one copy would leave the others behind
 * without a single test noticing.
 */

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** A finite number, or `null`. SQLite's dynamic typing lets an integer column come back as text. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC.test(value.trim())) return Number(value.trim());
  return null;
}

/** A plain object: arrays are excluded, because a JSON array is never a row. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Three decimals: enough for millisecond stamps and audio durations, short of
 * the binary-float noise that shows up once such values are summed.
 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
