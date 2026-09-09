import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';
import { TOOL_NAMES } from '../../src/mcp/tools/index.js';
import { readBridgeConfig } from '../../src/bridge/configFile.js';
import { bridgeRequest } from '../../src/bridge/httpClient.js';
import { loadConfig } from '../../src/config.js';

/**
 * Opt-in contract check against the REAL OpenWhispr bridge.
 *
 * Read-only: it never mutates the user's data. It is also the only place where
 * the exact wording of the app's domain-500 messages is asserted — matching
 * strings from a closed-source app is best-effort, and a fixture test would keep
 * passing after an app update while silently testing nothing.
 */
const CONFIG_PATH = process.env.OPENWHISPR_BRIDGE_CONFIG ?? join(homedir(), '.openwhispr', 'cli-bridge.json');

function handshakeReadable(): boolean {
  try {
    accessSync(CONFIG_PATH, constants.R_OK);
    return true;
  } catch {
    // Swallows ENOENT *and* EACCES/EPERM: inside a sandbox ~/.openwhispr/ answers
    // "Operation not permitted", and a bare ENOENT check would fail instead of skip.
    return false;
  }
}

const live = process.env.OPENWHISPR_LIVE === '1' && handshakeReadable();

describe.skipIf(!live)('live bridge (read-only)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('advertises all 15 tools', async () => {
    const tools = await harness.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('health reports the live port', async () => {
    const body = await harness.callJson<{ ok: boolean; bridge: { port: number } }>('health');
    expect(body.ok).toBe(true);
    expect(body.bridge.port).toBeGreaterThanOrEqual(1);
  });

  it('lists folders', async () => {
    const body = await harness.callJson<{ folders: { id: number; name: string }[] }>('list_folders');
    expect(Array.isArray(body.folders)).toBe(true);
    for (const folder of body.folders) {
      expect(typeof folder.id).toBe('number');
      expect(typeof folder.name).toBe('string');
    }
  });

  it('lists notes and never leaks the transcript column', async () => {
    const body = await harness.callJson<{ notes: Record<string, unknown>[] }>('list_notes', { page_size: 5 });
    for (const note of body.notes) {
      expect(note).not.toHaveProperty('transcript');
      expect(note).not.toHaveProperty('cloud_id');
      expect(note).not.toHaveProperty('sync_status');
      expect(String(note.updated_at ?? '')).toMatch(/Z$/);
    }
  });

  it('lists transcriptions', async () => {
    const body = await harness.callJson<{ transcriptions: unknown[] }>('list_transcriptions', { limit: 5 });
    expect(Array.isArray(body.transcriptions)).toBe(true);
  });

  it('lists the dictionary', async () => {
    const body = await harness.callJson<{ words: string[] }>('list_dictionary');
    expect(Array.isArray(body.words)).toBe(true);
  });

  it('aggregates usage without touching the cloud plan', async () => {
    const body = await harness.callJson<{
      plan: { available: boolean };
      limitations: string[];
    }>('get_usage', { notes_limit: 20, transcriptions_limit: 20 });
    expect(body.plan.available).toBe(false);
    expect(body.limitations.length).toBeGreaterThan(0);
  });

  /**
   * The contract check the fixture tests cannot make: that the app still phrases
   * its errors the way `errorMap`'s regex table expects. Triggering a *folder*
   * error would require a write, and this suite never writes — so the check uses
   * the one domain-500 a read can provoke: an unvalidated `limit` reaching SQL.
   * If this fails after an app update, `errorMap` is what needs fixing.
   */
  it('still leaks "datatype mismatch" for an unvalidated limit, as errorMap expects', async () => {
    const handshake = await readBridgeConfig(CONFIG_PATH);
    const config = loadConfig();
    await expect(
      bridgeRequest(
        { method: 'GET', path: '/v1/notes/list', query: { limit: 'abc' } },
        {
          host: handshake.host,
          port: handshake.port,
          token: handshake.token,
          timeoutMs: config.timeoutMs,
          maxRequestBytes: config.maxRequestBytes,
          maxResponseBytes: config.maxResponseBytes,
        },
      ),
    ).rejects.toMatchObject({
      status: 500,
      upstreamMessage: expect.stringMatching(/datatype mismatch/i),
    });
  });

  it('reports a missing note as not_found, not as a 500', async () => {
    const result = await harness.call('get_note', { note_id: 2_000_000_000 });
    expect(result.isError).toBe(true);
    expect(toolError(result).kind).toBe('not_found');
  });
});

describe.skipIf(live)('live bridge (skipped)', () => {
  it('is opt-in: set OPENWHISPR_LIVE=1 with OpenWhispr running', () => {
    expect(live).toBe(false);
  });
});
