/**
 * Word and character counts for note bodies and transcription text.
 *
 * A "word" starts with a letter or digit and may carry combining marks,
 * hyphens and apostrophes, so `state-of-the-art` and `don’t` count as one.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;

export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  return (text.match(WORD) ?? []).length;
}

/**
 * UTF-16 code units, i.e. plain `.length`. Not grapheme clusters: this is the
 * same number every JSON consumer sees as the length of the string, and it is
 * what `content_chars` in the note projections promises.
 */
export function countChars(text: string | null | undefined): number {
  if (!text) return 0;
  return text.length;
}
