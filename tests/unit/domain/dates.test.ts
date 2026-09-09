import { afterEach, describe, expect, it, vi } from 'vitest';

import { monthKey, parseSqliteUtc, toIsoZ, withinLastDays } from '../../../src/domain/dates.js';

/** The exact value the app writes for `2026-09-08 08:31:48` (SQLite CURRENT_TIMESTAMP is UTC). */
const SQLITE_SAMPLE = '2026-09-08 08:31:48';
const SAMPLE_MS = Date.UTC(2026, 8, 8, 8, 31, 48);

describe('parseSqliteUtc', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads a SQLite datetime as UTC, not as local time', () => {
    expect(parseSqliteUtc(SQLITE_SAMPLE)).toBe(SAMPLE_MS);
  });

  it('disagrees with a naive `new Date(s)` in a non-UTC zone', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(new Date().getTimezoneOffset()).not.toBe(0); // guards the stub itself
    expect(new Date(SQLITE_SAMPLE).getTime()).not.toBe(SAMPLE_MS);
    expect(parseSqliteUtc(SQLITE_SAMPLE)).toBe(SAMPLE_MS);
  });

  it('is stable across timezones', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(parseSqliteUtc(SQLITE_SAMPLE)).toBe(SAMPLE_MS);
    vi.stubEnv('TZ', 'Pacific/Kiritimati');
    expect(parseSqliteUtc(SQLITE_SAMPLE)).toBe(SAMPLE_MS);
  });

  it('accepts ISO strings with a zone, with milliseconds and with an offset', () => {
    expect(parseSqliteUtc('2026-09-08T08:31:48Z')).toBe(SAMPLE_MS);
    expect(parseSqliteUtc('2026-09-08T08:31:48.000Z')).toBe(SAMPLE_MS);
    expect(parseSqliteUtc('2026-09-08T08:31:48.123Z')).toBe(SAMPLE_MS + 123);
    expect(parseSqliteUtc('2026-09-08T11:31:48+03:00')).toBe(SAMPLE_MS);
    expect(parseSqliteUtc('2026-09-08T11:31:48+0300')).toBe(SAMPLE_MS);
  });

  it('treats a zoneless ISO string as UTC too', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(parseSqliteUtc('2026-09-08T08:31:48')).toBe(SAMPLE_MS);
  });

  it('accepts a date-only string as UTC midnight', () => {
    expect(parseSqliteUtc('2026-09-08')).toBe(Date.UTC(2026, 8, 8));
  });

  it('accepts a SQLite datetime with fractional seconds', () => {
    expect(parseSqliteUtc('2026-09-08 08:31:48.500')).toBe(SAMPLE_MS + 500);
  });

  it('reads numbers above 1e11 as epoch milliseconds', () => {
    expect(parseSqliteUtc(1_788_000_000_000)).toBe(1_788_000_000_000);
  });

  it('reads numbers above 1e9 as epoch seconds', () => {
    expect(parseSqliteUtc(1_788_000_000)).toBe(1_788_000_000_000);
  });

  it('rejects numbers too small to be an epoch', () => {
    expect(parseSqliteUtc(0)).toBeNull();
    expect(parseSqliteUtc(1_000_000)).toBeNull();
    expect(parseSqliteUtc(-1_788_000_000_000)).toBeNull();
    expect(parseSqliteUtc(Number.NaN)).toBeNull();
    expect(parseSqliteUtc(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null for null, undefined, empty and garbage input', () => {
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc(undefined)).toBeNull();
    expect(parseSqliteUtc('')).toBeNull();
    expect(parseSqliteUtc('   ')).toBeNull();
    expect(parseSqliteUtc('not a date')).toBeNull();
    expect(parseSqliteUtc('0000-00-00 00:00:00')).toBeNull();
  });

  it('never throws', () => {
    expect(() => parseSqliteUtc('9999-99-99 99:99:99')).not.toThrow();
  });
});

describe('toIsoZ', () => {
  it('renders a SQLite datetime without milliseconds and with a Z suffix', () => {
    expect(toIsoZ(SQLITE_SAMPLE)).toBe('2026-09-08T08:31:48Z');
  });

  it('drops milliseconds even when the source carries them', () => {
    expect(toIsoZ('2026-09-08T08:31:48.123Z')).toBe('2026-09-08T08:31:48Z');
  });

  it('renders epoch numbers in both scales', () => {
    expect(toIsoZ(1_788_000_000_000)).toBe('2026-08-29T10:40:00Z');
    expect(toIsoZ(1_788_000_000)).toBe('2026-08-29T10:40:00Z');
  });

  it('returns null for unparseable input', () => {
    expect(toIsoZ(null)).toBeNull();
    expect(toIsoZ('')).toBeNull();
    expect(toIsoZ('nope')).toBeNull();
  });
});

describe('monthKey', () => {
  it('buckets by UTC month', () => {
    expect(monthKey(SQLITE_SAMPLE)).toBe('2026-09');
  });

  it('does not slip into the previous month in a western zone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(monthKey('2026-09-01 00:30:00')).toBe('2026-09');
    vi.unstubAllEnvs();
  });

  it('does not slip into the next month in an eastern zone', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(monthKey('2026-12-31 23:30:00')).toBe('2026-12');
    vi.unstubAllEnvs();
  });

  it('pads single-digit months', () => {
    expect(monthKey('2026-01-05 00:00:00')).toBe('2026-01');
  });

  it('returns null for unparseable input', () => {
    expect(monthKey(undefined)).toBeNull();
    expect(monthKey('garbage')).toBeNull();
  });
});

describe('withinLastDays', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  const DAY = 86_400_000;

  it('accepts a timestamp inside the window', () => {
    expect(withinLastDays(new Date(now - 3 * DAY).toISOString(), 7, now)).toBe(true);
  });

  it('rejects a timestamp older than the window', () => {
    expect(withinLastDays(new Date(now - 8 * DAY).toISOString(), 7, now)).toBe(false);
  });

  it('includes the exact boundary', () => {
    expect(withinLastDays(new Date(now - 7 * DAY).toISOString(), 7, now)).toBe(true);
    expect(withinLastDays(new Date(now - 7 * DAY - 1).toISOString(), 7, now)).toBe(false);
  });

  it('accepts future timestamps (clock skew is not staleness)', () => {
    expect(withinLastDays(new Date(now + DAY).toISOString(), 7, now)).toBe(true);
  });

  it('works with SQLite datetimes and epoch numbers', () => {
    expect(withinLastDays('2026-09-08 08:31:48', 1, now)).toBe(true);
    expect(withinLastDays(Math.floor((now - DAY) / 1000), 2, now)).toBe(true);
  });

  it('is false for unparseable input and for a non-positive window', () => {
    expect(withinLastDays(null, 7, now)).toBe(false);
    expect(withinLastDays('garbage', 7, now)).toBe(false);
    expect(withinLastDays(new Date(now).toISOString(), 0, now)).toBe(false);
    expect(withinLastDays(new Date(now).toISOString(), -1, now)).toBe(false);
    expect(withinLastDays(new Date(now).toISOString(), Number.NaN, now)).toBe(false);
  });
});
