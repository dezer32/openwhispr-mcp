import { describe, expect, it } from 'vitest';

import {
  buildFtsQuery,
  buildPreview,
  buildSnippet,
  findMatchedFields,
  tokenize,
} from '../../../src/domain/ftsQuery.js';
import { makeNote } from '../../fixtures/notes.js';

describe('tokenize', () => {
  it('mirrors the bridge tokenizer on "C++"', () => {
    // Documented side effect: the "+" characters are separators, so the query
    // degrades to the prefix `"C"*` and matches everything starting with C.
    expect(tokenize('C++')).toEqual(['C']);
  });

  it('splits cyrillic on punctuation', () => {
    expect(tokenize('Привет, мир!')).toEqual(['Привет', 'мир']);
    expect(tokenize('научно-технический прогресс')).toEqual(['научно', 'технический', 'прогресс']);
  });

  it('treats hyphens and apostrophes as separators (unlike countWords)', () => {
    expect(tokenize('state-of-the-art')).toEqual(['state', 'of', 'the', 'art']);
    expect(tokenize("don't")).toEqual(['don', 't']);
  });

  it('reduces FTS operators and wildcards to ordinary terms', () => {
    // The bridge does not strip them: it wraps every token in quotes, which
    // makes `AND`/`OR`/`NEAR` inert search terms rather than operators.
    expect(tokenize('foo* "bar"')).toEqual(['foo', 'bar']);
    expect(tokenize('NEAR(x, y)')).toEqual(['NEAR', 'x', 'y']);
    expect(tokenize('a AND b OR c NOT d')).toEqual(['a', 'AND', 'b', 'OR', 'c', 'NOT', 'd']);
    expect(tokenize('title:plan ^boost')).toEqual(['title', 'plan', 'boost']);
  });

  it('keeps underscores but drops tokens made only of them', () => {
    expect(tokenize('_private __ x')).toEqual(['_private', 'x']);
    expect(tokenize('___')).toEqual([]);
  });

  it('normalises to NFC so combining marks stay inside one token', () => {
    expect(tokenize('éclair')).toEqual(['éclair']);
  });

  it('returns an empty array for punctuation-only, empty and emoji-only input', () => {
    expect(tokenize('!!! ??? ...')).toEqual([]);
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('🎉 🚀')).toEqual([]);
    expect(tokenize('* " ( ) :')).toEqual([]);
  });

  it('keeps digits', () => {
    expect(tokenize('42 items v2')).toEqual(['42', 'items', 'v2']);
  });
});

describe('buildFtsQuery', () => {
  it('joins quoted prefix terms with implicit AND', () => {
    expect(buildFtsQuery('hello world')).toBe('"hello"* "world"*');
  });

  it('reproduces the degraded "C++" query', () => {
    expect(buildFtsQuery('C++')).toBe('"C"*');
  });

  it('returns an empty string when nothing tokenizes', () => {
    expect(buildFtsQuery('!!!')).toBe('');
    expect(buildFtsQuery('')).toBe('');
  });
});

describe('buildPreview', () => {
  it('returns short text unchanged', () => {
    expect(buildPreview('short text', 200)).toBe('short text');
  });

  it('collapses newlines and runs of whitespace into single spaces', () => {
    expect(buildPreview('line one\nline two', 200)).toBe('line one line two');
    expect(buildPreview('  padded \t\n text  ', 200)).toBe('padded text');
  });

  it('cuts on a word boundary and marks the cut', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const preview = buildPreview(text, 30);
    expect(preview.length).toBeLessThanOrEqual(30);
    expect(preview.endsWith('…')).toBe(true);
    const body = preview.slice(0, -1);
    expect(text.startsWith(body)).toBe(true);
    expect(body).toBe('alpha bravo charlie delta');
  });

  it('never exceeds maxChars, ellipsis included', () => {
    const text = 'word '.repeat(200).trim();
    for (const max of [1, 2, 5, 17, 40, 199, 200]) {
      expect(buildPreview(text, max).length).toBeLessThanOrEqual(max);
    }
  });

  it('hard-cuts a single word that has no boundary to fall back to', () => {
    const preview = buildPreview('a'.repeat(300), 10);
    expect(preview).toBe(`${'a'.repeat(9)}…`);
  });

  it('does not append an ellipsis when the text fits exactly', () => {
    const text = 'exactly ten';
    expect(buildPreview(text, text.length)).toBe(text);
  });

  it('returns an empty string for null, undefined, blank and a non-positive budget', () => {
    expect(buildPreview(null, 200)).toBe('');
    expect(buildPreview(undefined, 200)).toBe('');
    expect(buildPreview('   ', 200)).toBe('');
    expect(buildPreview('anything', 0)).toBe('');
  });
});

describe('findMatchedFields', () => {
  it('reports the searchable fields a token actually hit', () => {
    const note = makeNote({
      title: 'Project plan',
      content: 'nothing relevant here',
      enhanced_content: 'Improved project notes',
    });
    expect(findMatchedFields(note, ['proj'])).toEqual(['title', 'enhanced_content']);
  });

  it('explains a hit that is only visible in the hidden enhanced_content', () => {
    const note = makeNote({
      title: 'Weekly sync',
      content: 'agenda and notes',
      enhanced_content: 'Summary: quarterly budget review',
    });
    expect(findMatchedFields(note, ['budget'])).toEqual(['enhanced_content']);
  });

  it('keeps the field order title, content, enhanced_content', () => {
    const note = makeNote({
      title: 'alpha',
      content: 'alpha',
      enhanced_content: 'alpha',
    });
    expect(findMatchedFields(note, ['alpha'])).toEqual(['title', 'content', 'enhanced_content']);
  });

  it('matches case-insensitively and by prefix only', () => {
    const note = makeNote({ title: 'PROJECTION', content: 'reproject', enhanced_content: null });
    expect(findMatchedFields(note, ['proj'])).toEqual(['title']);
    expect(findMatchedFields(note, ['project'])).toEqual(['title']);
    expect(findMatchedFields(note, ['ject'])).toEqual([]);
  });

  it('matches cyrillic', () => {
    const note = makeNote({ title: 'Отчёт по продажам', content: null, enhanced_content: null });
    expect(findMatchedFields(note, ['прода'])).toEqual(['title']);
  });

  it('returns an empty array for no tokens, no match and empty fields', () => {
    const note = makeNote({ title: 'Project plan', content: 'body', enhanced_content: null });
    expect(findMatchedFields(note, [])).toEqual([]);
    expect(findMatchedFields(note, ['missing'])).toEqual([]);
    expect(findMatchedFields(makeNote({ title: null, content: null, enhanced_content: null }), ['x'])).toEqual([]);
  });

  it('reports a field when any one of the tokens hits it', () => {
    const note = makeNote({ title: 'Roadmap', content: 'budget', enhanced_content: null });
    expect(findMatchedFields(note, ['budget', 'nothing'])).toEqual(['content']);
  });
});

describe('buildSnippet', () => {
  const text = [
    'The quarterly planning meeting covered hiring, tooling and the migration schedule.',
    'We agreed that the budget review happens before any new headcount is approved.',
    'Everything else was deferred to the next session.',
  ].join('\n');

  it('windows around the first hit and marks both cut edges', () => {
    const snippet = buildSnippet(text, ['budget'], 60);
    expect(snippet).not.toBeNull();
    const value = snippet as string;
    expect(value.length).toBeLessThanOrEqual(60);
    expect(value).toContain('budget');
    expect(value.startsWith('…')).toBe(true);
    expect(value.endsWith('…')).toBe(true);
    expect(text.replace(/\s+/g, ' ')).toContain(value.replace(/^…|…$/g, '').trim());
  });

  it('omits the leading ellipsis when the hit is at the very start', () => {
    const snippet = buildSnippet(text, ['quarterly'], 40) as string;
    expect(snippet.startsWith('…')).toBe(false);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(40);
  });

  it('omits the trailing ellipsis when the window reaches the end', () => {
    const snippet = buildSnippet(text, ['deferred'], 60) as string;
    expect(snippet.endsWith('…')).toBe(false);
    expect(snippet.startsWith('…')).toBe(true);
  });

  it('returns the whole collapsed text when it fits in the budget', () => {
    expect(buildSnippet('a short line about budgets', ['budget'], 200)).toBe('a short line about budgets');
  });

  it('matches by prefix, case-insensitively', () => {
    expect(buildSnippet(text, ['MIGRAT'], 50)).toContain('migration');
  });

  it('cuts on word boundaries', () => {
    const snippet = buildSnippet(text, ['budget'], 60) as string;
    const body = snippet.replace(/^…|…$/g, '').trim();
    const flat = text.replace(/\s+/g, ' ');
    const at = flat.indexOf(body);
    expect(at).toBeGreaterThan(-1);
    if (at > 0) expect(flat.charAt(at - 1)).toBe(' ');
    const after = at + body.length;
    if (after < flat.length) expect(flat.charAt(after)).toBe(' ');
  });

  it('never exceeds maxChars for any budget', () => {
    for (const max of [1, 3, 8, 20, 61, 200]) {
      const snippet = buildSnippet(text, ['budget'], max);
      if (snippet !== null) expect(snippet.length).toBeLessThanOrEqual(max);
    }
  });

  it('returns null when nothing matches or there is nothing to search', () => {
    expect(buildSnippet(text, ['absent'], 60)).toBeNull();
    expect(buildSnippet(text, [], 60)).toBeNull();
    expect(buildSnippet(null, ['budget'], 60)).toBeNull();
    expect(buildSnippet(undefined, ['budget'], 60)).toBeNull();
    expect(buildSnippet('   ', ['budget'], 60)).toBeNull();
    expect(buildSnippet(text, ['budget'], 0)).toBeNull();
  });
});
