import { describe, expect, it } from 'vitest';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';

import {
  TRANSCRIPT_MIME_TYPE,
  TRANSCRIPT_URI_TEMPLATE,
  parseTranscriptNoteId,
  transcriptUri,
} from '../../../src/domain/transcriptUri.js';

describe('transcriptUri', () => {
  it('builds the URI the template matches', () => {
    expect(transcriptUri(8)).toBe('openwhispr://notes/8/transcript.md');
    expect(new UriTemplate(TRANSCRIPT_URI_TEMPLATE).match(transcriptUri(8))).toEqual({
      note_id: '8',
    });
  });

  it('survives the URL normalisation the SDK applies before matching', () => {
    // `ReadResourceRequest` handling runs the raw URI through `new URL(...)`;
    // a custom scheme that came back changed would never match the template.
    const uri = transcriptUri(13);
    expect(new URL(uri).href).toBe(uri);
    expect(new UriTemplate(TRANSCRIPT_URI_TEMPLATE).match(new URL(uri).href)).toEqual({
      note_id: '13',
    });
  });

  it('does not match a neighbouring path under the same scheme', () => {
    const template = new UriTemplate(TRANSCRIPT_URI_TEMPLATE);
    expect(template.match('openwhispr://notes/8/other.md')).toBeNull();
    expect(template.match('openwhispr://notes/8')).toBeNull();
  });

  it('declares markdown', () => {
    expect(TRANSCRIPT_MIME_TYPE).toBe('text/markdown');
  });
});

describe('parseTranscriptNoteId', () => {
  it('accepts a positive integer', () => {
    expect(parseTranscriptNoteId('1')).toBe(1);
    expect(parseTranscriptNoteId('698')).toBe(698);
  });

  it('refuses anything that is not one', () => {
    for (const raw of ['', '0', '-1', '1.5', '01', ' 1', '1 ', 'abc', '8e3', '1_000', '99999999999999999999']) {
      expect(parseTranscriptNoteId(raw), raw).toBeNull();
    }
  });
});
