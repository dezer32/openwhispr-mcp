import { describe, expect, it } from 'vitest';
import { isRecord, num, round3 } from '../../../src/domain/coerce.js';
import { EPOCH_MS_FLOOR, EPOCH_S_FLOOR, parseSqliteUtc } from '../../../src/domain/dates.js';
import { detectTimeUnit } from '../../../src/domain/transcript.js';

describe('coerce', () => {
  it('reads a number out of the three spellings SQLite hands over', () => {
    expect(num(42)).toBe(42);
    expect(num('42')).toBe(42);
    expect(num(' -1.5 ')).toBe(-1.5);
  });

  it('refuses anything that is not a finite number', () => {
    for (const value of [null, undefined, '', 'abc', '1px', NaN, Infinity, {}, [], true]) {
      expect(num(value), String(value)).toBeNull();
    }
  });

  it('treats arrays and null as non-records', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('rounds to three decimals', () => {
    expect(round3(0.1 + 0.2)).toBe(0.3);
    expect(round3(1.23456)).toBe(1.235);
    expect(round3(5)).toBe(5);
  });
});

describe('epoch thresholds', () => {
  /**
   * `dates.ts` and `transcript.ts` used to declare these two floors separately.
   * This is the drift that would otherwise pass unnoticed: each module has its
   * own tests, and neither compares itself with the other.
   */
  it('classifies a value the same way in date parsing and in segment timing', () => {
    const seconds = EPOCH_S_FLOOR + 1;
    expect(detectTimeUnit(seconds)).toBe('s');
    expect(parseSqliteUtc(seconds)).toBe(seconds * 1000);

    const milliseconds = EPOCH_MS_FLOOR + 1;
    expect(detectTimeUnit(milliseconds)).toBe('ms');
    expect(parseSqliteUtc(milliseconds)).toBe(milliseconds);

    const relative = EPOCH_S_FLOOR;
    expect(detectTimeUnit(relative)).toBe('relative');
    // Below the seconds floor a number is an offset or a counter, not a date.
    expect(parseSqliteUtc(relative)).toBeNull();
  });
});
