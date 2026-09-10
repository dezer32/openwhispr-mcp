import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { EMPTY_NOTE, PLAIN_NOTE } from '../../src/domain/transcriptNotes.js';
import { transcriptUri } from '../../src/domain/transcriptUri.js';
import { makeNote, resetNoteIds } from '../fixtures/notes.js';
import {
  BROKEN_JSON_TRANSCRIPT,
  LEGACY_PLAIN_TRANSCRIPT,
  jsonTranscript,
  twoSpeakerSegments,
} from '../fixtures/transcripts.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { startHarness, type Harness, type HarnessOptions } from '../helpers/mcpHarness.js';

let bridge: FakeBridge | undefined;
let harness: Harness | undefined;

async function boot(
  notes: Record<string, unknown>[],
  options: Omit<HarnessOptions, 'bridgeConfigPath'> = {},
): Promise<void> {
  bridge = await startFakeBridge({ state: { notes } });
  harness = await startHarness({ ...options, bridgeConfigPath: bridge.configPath });
}

async function readText(noteId: number): Promise<string> {
  const uri = transcriptUri(noteId);
  const result = await harness!.readResource(uri);
  expect(result.contents).toHaveLength(1);
  const content = result.contents[0];
  if (content === undefined || !('text' in content)) {
    throw new Error(`${uri} came back as a blob, not text: ${JSON.stringify(result)}`);
  }
  expect(content.uri).toBe(uri);
  expect(content.mimeType).toBe('text/markdown');
  return content.text;
}

async function readFailure(uri: string): Promise<McpError> {
  const err: unknown = await harness!.readResource(uri).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(McpError);
  return err as McpError;
}

beforeEach(() => {
  resetNoteIds(1);
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
  bridge = undefined;
});

describe('reading a transcript resource', () => {
  it('hands over a 300-segment meeting in one read, whole', async () => {
    await boot([
      makeNote({
        id: 13,
        title: 'Weekly sync',
        note_type: 'meeting',
        transcript: jsonTranscript(twoSpeakerSegments(300)),
      }),
    ]);

    const text = await readText(13);

    expect(text.startsWith('# Weekly sync — transcript\n')).toBe(true);
    expect(text).toContain('- segments: 300');
    expect(text).toContain('Line 1 with a few words in it.');
    expect(text).toContain('Line 300 with a few words in it.');
    // Speakers alternate, so nothing merges and every segment is its own line.
    expect(text.match(/^\[\d\d:\d\d\]/gm)).toHaveLength(300);
    expect(text).not.toContain('Truncated at');
  });

  it('serves a legacy flat-text transcript', async () => {
    await boot([makeNote({ id: 3, transcript: LEGACY_PLAIN_TRANSCRIPT })]);
    const text = await readText(3);

    expect(text).toContain(PLAIN_NOTE);
    expect(text).toContain('This is a legacy transcript stored as plain text.');
  });

  it('is not an error for a note that has no transcript', async () => {
    await boot([makeNote({ id: 5, transcript: null })]);
    const text = await readText(5);

    expect(text).toContain(EMPTY_NOTE);
    expect(text).toContain('- segments: 0');
  });

  it('degrades a truncated JSON write to text and says so', async () => {
    await boot([makeNote({ id: 6, transcript: BROKEN_JSON_TRANSCRIPT })]);
    const text = await readText(6);

    expect(text).toContain('truncated mid-write');
    expect(text).toContain('most likely a truncated write');
  });

  it('cuts at the result cap instead of failing, and says where the rest is', async () => {
    await boot([makeNote({ id: 13, transcript: jsonTranscript(twoSpeakerSegments(300)) })], {
      config: { maxResultChars: 4_000 },
    });

    const text = await readText(13);

    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain('> Truncated at 4000 characters');
    expect(text).toContain('format="segments"');
  });
});

describe('failing to read a transcript resource', () => {
  it('reports a missing note as not_found, in the same envelope the tools use', async () => {
    await boot([makeNote({ id: 1 })]);
    const err = await readFailure(transcriptUri(999));

    // The client re-prefixes the wire message, so the JSON body follows exactly
    // one `MCP error <code>: ` — never two.
    expect(err.message).toMatch(/^MCP error -32602: \{\n/);
    const payload = JSON.parse(err.message.slice(err.message.indexOf('{'))) as {
      error: { kind: string; message: string; hint?: string };
    };
    expect(payload.error.kind).toBe('not_found');
    expect(payload.error.message).toContain('999');
    expect(payload.error.hint).toContain('list_notes');
  });

  it('refuses a note_id that is not one', async () => {
    await boot([makeNote({ id: 1 })]);
    const err = await readFailure('openwhispr://notes/abc/transcript.md');

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('"kind": "invalid_argument"');
  });

  it('reports the app being closed as bridge_not_running', async () => {
    harness = await startHarness({ bridgeConfigPath: '/nonexistent/openwhispr/cli-bridge.json' });
    const err = await readFailure(transcriptUri(1));

    expect(err.message).toContain('"kind": "bridge_not_running"');
  });

  it('does not answer for a neighbouring path under the same scheme', async () => {
    await boot([makeNote({ id: 1 })]);
    const err = await readFailure('openwhispr://notes/1/other.md');
    expect(err.message).toMatch(/not found/i);
  });
});
