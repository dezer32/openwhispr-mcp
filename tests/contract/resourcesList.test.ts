import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';

import { MAX_UPSTREAM_LIMIT } from '../../src/config.js';
import { TRANSCRIPT_URI_TEMPLATE } from '../../src/domain/transcriptUri.js';
import { makeNote, resetNoteIds } from '../fixtures/notes.js';
import {
  LEGACY_PLAIN_TRANSCRIPT,
  jsonTranscript,
  twoSpeakerSegments,
} from '../fixtures/transcripts.js';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { startHarness, type Harness } from '../helpers/mcpHarness.js';

/**
 * `resources/list` is pulled by the client itself, unprompted and often, so its
 * shape — and its behaviour with the app closed — is a contract.
 */
let bridge: FakeBridge | undefined;
let harness: Harness | undefined;

async function boot(notes: Record<string, unknown>[]): Promise<void> {
  bridge = await startFakeBridge({ state: { notes } });
  harness = await startHarness({ bridgeConfigPath: bridge.configPath });
}

function byUri(resources: Resource[]): Record<string, Resource> {
  return Object.fromEntries(resources.map((resource) => [resource.uri, resource]));
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

describe('resources/list', () => {
  it('lists exactly the notes that have a transcript', async () => {
    await boot([
      makeNote({ id: 1, transcript: jsonTranscript(twoSpeakerSegments(4)) }),
      makeNote({ id: 2, transcript: null }),
      makeNote({ id: 3, transcript: LEGACY_PLAIN_TRANSCRIPT }),
      makeNote({ id: 4, transcript: '   ' }),
    ]);

    const resources = await harness!.listResources();

    expect(resources.map((r) => r.uri)).toEqual([
      'openwhispr://notes/1/transcript.md',
      'openwhispr://notes/3/transcript.md',
    ]);
  });

  it('declares markdown and a human title on every entry', async () => {
    await boot([
      makeNote({ id: 7, title: 'Weekly sync', transcript: jsonTranscript(twoSpeakerSegments(9)) }),
    ]);

    const [resource] = await harness!.listResources();

    expect(resource!.mimeType).toBe('text/markdown');
    expect(resource!.title).toBe('Weekly sync');
    expect(resource!.name).toBe('note-7-transcript');
    expect(resource!.description).toContain('personal');
    expect(resource!.description).toContain('9 transcript segments');
    expect(resource!.description).toContain('2026-09-08T08:31:48Z');
  });

  it('leaves size unset rather than guessing one', async () => {
    await boot([makeNote({ id: 1, transcript: jsonTranscript(twoSpeakerSegments(4)) })]);
    const [resource] = await harness!.listResources();
    // The raw column is JSON, three times the size of the rendered document —
    // a cheap number here would be a wrong one.
    expect(resource!.size).toBeUndefined();
  });

  it('describes a legacy flat-text transcript without inventing a segment count', async () => {
    await boot([makeNote({ id: 5, title: null, transcript: LEGACY_PLAIN_TRANSCRIPT })]);
    const [resource] = await harness!.listResources();

    expect(resource!.title).toBe('Note 5');
    expect(resource!.description).toContain('legacy flat-text transcript');
    expect(resource!.description).not.toMatch(/\d+ transcript segments/);
  });

  it('advertises the URI template', async () => {
    await boot([]);
    const { resourceTemplates } = await harness!.client.listResourceTemplates();

    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([TRANSCRIPT_URI_TEMPLATE]);
    expect(resourceTemplates[0]!.mimeType).toBe('text/markdown');
  });

  it('reads the notes in one upstream call, capped at the upstream limit', async () => {
    await boot([makeNote({ id: 1, transcript: jsonTranscript(twoSpeakerSegments(4)) })]);
    await harness!.listResources();

    const listCalls = bridge!.requests.filter((r) => r.path === '/v1/notes/list');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.query.limit).toBe(String(MAX_UPSTREAM_LIMIT));
  });

  it('answers with an empty list — not an error — when the app is not running', async () => {
    harness = await startHarness({ bridgeConfigPath: '/nonexistent/openwhispr/cli-bridge.json' });
    await expect(harness.listResources()).resolves.toEqual([]);
  });

  it('answers with an empty list when the app dies between reads', async () => {
    await boot([makeNote({ id: 1, transcript: jsonTranscript(twoSpeakerSegments(4)) })]);
    expect(await harness!.listResources()).toHaveLength(1);

    await bridge!.close();
    await bridge!.removeConfig();
    expect(await harness!.listResources()).toEqual([]);
  });
});
