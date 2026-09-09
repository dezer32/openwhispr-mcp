import type { RawNote } from '../bridge/types.js';

/**
 * A mirror of the bridge's FTS5 query builder plus the presentation helpers the
 * search tool needs.
 *
 * The bridge tokenizer (`/src/helpers/noteSearch.js`) normalises the query to
 * NFC, matches it against the `TOKEN` pattern below, keeps only the tokens that
 * contain a letter or a digit, and turns each one into `"token"*` joined by
 * spaces (implicit AND).
 * Note what that does NOT do: it never strips FTS operators. `AND`, `OR`,
 * `NEAR` and `*` survive as ordinary terms because the quoting makes them inert,
 * and `C++` collapses to the prefix `"C"*`. We reproduce the behaviour exactly
 * so `tokens_used` and the matched-field diagnostics describe the query the
 * bridge really ran.
 */
const TOKEN = /[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu;
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;
const WHITESPACE_RUN = /\s+/g;
const ELLIPSIS = '…';

/** The fields `notes_fts` indexes, in the order they are reported. */
const SEARCH_FIELDS = ['title', 'content', 'enhanced_content'] as const;

export function tokenize(query: string): string[] {
  if (typeof query !== 'string') return [];
  const matched = query.normalize('NFC').match(TOKEN) ?? [];
  // A token of underscores alone carries no signal; the bridge drops it too.
  return matched.filter((token) => HAS_ALPHANUMERIC.test(token));
}

export function buildFtsQuery(query: string): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) return '';
  // The doubling is unreachable for tokenizer output (a quote is a separator);
  // it is kept so the mirror stays exact.
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' ');
}

/** Collapses every whitespace run to one space so previews stay single-line. */
function flatten(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text).replace(WHITESPACE_RUN, ' ').trim();
}

function normaliseTokens(tokens: string[]): string[] {
  return tokens
    .filter((token): token is string => typeof token === 'string' && token !== '')
    .map((token) => token.normalize('NFC').toLowerCase());
}

interface Hit {
  start: number;
  end: number;
}

/** First word of `haystack` that starts with one of the (already lowercased) needles. */
function firstHit(haystack: string, needles: string[]): Hit | null {
  const lowered = haystack.normalize('NFC').toLowerCase();
  for (const match of lowered.matchAll(TOKEN)) {
    const word = match[0];
    if (needles.some((needle) => word.startsWith(needle))) {
      return { start: match.index, end: match.index + word.length };
    }
  }
  return null;
}

/**
 * `maxChars` bounds the returned string including the ellipsis, so a preview can
 * be dropped into a fixed-width budget without re-measuring.
 */
export function buildPreview(text: string | null | undefined, maxChars: number): string {
  const flat = flatten(text);
  if (flat === '' || maxChars <= 0) return '';
  if (flat.length <= maxChars) return flat;

  const budget = maxChars - 1; // one slot for the ellipsis
  let cut = flat.slice(0, budget);
  if (flat.charAt(budget) !== ' ') {
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  cut = cut.trimEnd();
  return `${cut}${ELLIPSIS}`;
}

/**
 * Which indexed fields a token really hit. `enhanced_content` is indexed but
 * hidden by default, so without this a search result can look unexplainable.
 */
export function findMatchedFields(note: RawNote, tokens: string[]): string[] {
  const needles = normaliseTokens(tokens);
  if (needles.length === 0) return [];

  const fields: string[] = [];
  for (const field of SEARCH_FIELDS) {
    const value = note[field];
    if (typeof value !== 'string' || value === '') continue;
    if (firstHit(value, needles)) fields.push(field);
  }
  return fields;
}

/** A window around the first hit, or `null` when no token matches. */
export function buildSnippet(
  text: string | null | undefined,
  tokens: string[],
  maxChars: number,
): string | null {
  const flat = flatten(text);
  if (flat === '' || maxChars <= 0) return null;

  const needles = normaliseTokens(tokens);
  if (needles.length === 0) return null;

  const hit = firstHit(flat, needles);
  if (!hit) return null;
  if (flat.length <= maxChars) return flat;

  const lead = Math.max(0, Math.floor((maxChars - (hit.end - hit.start)) / 2));
  let start = Math.max(0, hit.start - lead);

  let budget = maxChars - (start > 0 ? 1 : 0);
  if (budget <= 0) return null;
  let end = Math.min(flat.length, start + budget);
  if (end < flat.length) {
    budget -= 1; // room for the trailing ellipsis
    if (budget <= 0) return null;
    end = Math.min(flat.length, start + budget);
  }

  // Snap both edges inwards to word boundaries; never past the hit itself.
  if (start > 0 && flat.charAt(start - 1) !== ' ') {
    const nextSpace = flat.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < hit.start) start = nextSpace + 1;
  }
  if (end < flat.length && flat.charAt(end) !== ' ') {
    const previousSpace = flat.lastIndexOf(' ', end);
    if (previousSpace >= hit.end) end = previousSpace;
  }
  if (end <= start) return null;

  const body = flat.slice(start, end).trim();
  if (body === '') return null;

  const prefix = start > 0 ? ELLIPSIS : '';
  const suffix = end < flat.length ? ELLIPSIS : '';
  return `${prefix}${body}${suffix}`;
}
