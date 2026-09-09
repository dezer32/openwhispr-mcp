import { describe, expect, it } from 'vitest';

import { countChars, countWords } from '../../../src/domain/words.js';

describe('countWords', () => {
  it('counts plain latin words', () => {
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('  spaced   out  ')).toBe(2);
    expect(countWords('line one\nline two')).toBe(4);
  });

  it('counts cyrillic words', () => {
    expect(countWords('Привет, мир!')).toBe(2);
    expect(countWords('Съешь ещё этих мягких французских булок')).toBe(6);
  });

  it('keeps hyphenated words whole', () => {
    expect(countWords('state-of-the-art')).toBe(1);
    expect(countWords('научно-технический прогресс')).toBe(2);
  });

  it('keeps apostrophes inside words, straight and typographic', () => {
    expect(countWords("don't")).toBe(1);
    expect(countWords('don’t')).toBe(1);
    expect(countWords("it's a dog's life")).toBe(4);
  });

  it('ignores emoji and punctuation-only input', () => {
    expect(countWords('🎉')).toBe(0);
    expect(countWords('🎉 🚀')).toBe(0);
    expect(countWords('hi 🎉 there')).toBe(2);
    expect(countWords('!!! ... ???')).toBe(0);
    expect(countWords('— – …')).toBe(0);
  });

  it('counts numbers and alphanumerics as words', () => {
    expect(countWords('42 items')).toBe(2);
    expect(countWords('v2 release')).toBe(2);
  });

  it('does not start a word on a leading hyphen or apostrophe', () => {
    expect(countWords('-leading')).toBe(1);
    expect(countWords("'quoted'")).toBe(1);
    expect(countWords('- - -')).toBe(0);
  });

  it('returns 0 for empty, null and undefined', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });

  it('is stable across repeated calls (no leaking regex state)', () => {
    const text = 'one two three';
    expect(countWords(text)).toBe(3);
    expect(countWords(text)).toBe(3);
    expect(countWords(text)).toBe(3);
  });
});

describe('countChars', () => {
  it('counts UTF-16 code units, matching `content_chars`', () => {
    expect(countChars('abc')).toBe(3);
    expect(countChars('мир')).toBe(3);
    // A surrogate pair counts as two: cheap, monotonic and consistent with `.length`.
    expect(countChars('🎉')).toBe(2);
  });

  it('counts whitespace and newlines', () => {
    expect(countChars('a b')).toBe(3);
    expect(countChars('a\nb')).toBe(3);
  });

  it('returns 0 for empty, null and undefined', () => {
    expect(countChars('')).toBe(0);
    expect(countChars(null)).toBe(0);
    expect(countChars(undefined)).toBe(0);
  });
});
