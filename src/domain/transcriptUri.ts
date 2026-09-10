/**
 * The one place the transcript resource URI is spelled out.
 *
 * `domain/projections.ts` puts the URI on every note summary and
 * `mcp/resources/transcript.ts` matches it back to a note id. If the two spellings
 * drifted apart the agent would be handed a link this server cannot read, so both
 * read it from here. It lives in `domain/` rather than `mcp/` because the
 * projection imports it: the reverse dependency would invert the layers.
 */

/** RFC 6570 template, exactly as advertised in `resources/templates/list`. */
export const TRANSCRIPT_URI_TEMPLATE = 'openwhispr://notes/{note_id}/transcript.md';

export const TRANSCRIPT_MIME_TYPE = 'text/markdown';

export function transcriptUri(noteId: number): string {
  return `openwhispr://notes/${noteId}/transcript.md`;
}

/**
 * Note ids are positive integers, the same domain as the `note_id` tool
 * argument. Anything else — `abc`, `1.5`, `-1`, `007`, a value past 2^53 — is not
 * a note id and is refused here, instead of becoming a bridge call whose 404
 * would blame the app for a malformed URI.
 */
export function parseTranscriptNoteId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,17}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
