import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeConfigError } from '../../src/bridge/errors.js';
import type { RawHealth } from '../../src/bridge/types.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createTtlStore } from '../../src/domain/snapshotStore.js';
import type { BridgeRoutes, BridgeSession, ToolDeps } from '../../src/deps.js';
import { MAX_TOOL_DESCRIPTION_CHARS } from '../../src/mcp/defineTool.js';
import { isSchemaRejection, startHarness, toolError, type Harness } from '../helpers/mcpHarness.js';

function fakeRoutes(health: () => Promise<RawHealth>): BridgeRoutes {
  const missing = (): never => {
    throw new Error('unexpected route call');
  };
  return {
    health,
    listNotes: missing,
    searchNotes: missing,
    getNote: missing,
    createNote: missing,
    updateNote: missing,
    deleteNote: missing,
    listFolders: missing,
    createFolder: missing,
    listDictionary: missing,
    updateDictionary: missing,
    listTranscriptions: missing,
    getTranscription: missing,
  } as BridgeRoutes;
}

function fakeSession(port: number): BridgeSession {
  return {
    host: '127.0.0.1',
    port,
    attempt: 1,
    signal: new AbortController().signal,
    mutationCommitted: false,
    request: async () => {
      throw new Error('unexpected raw request');
    },
  };
}

function makeToolDeps(withSession: ToolDeps['withSession'], configOverrides: Partial<Config> = {}): ToolDeps {
  const config: Config = {
    ...loadConfig({} as NodeJS.ProcessEnv),
    bridgeConfigPath: '/fake/home/.openwhispr/cli-bridge.json',
    ...configOverrides,
  };
  return {
    config,
    now: () => 0,
    snapshots: createTtlStore<unknown>({ ttlMs: 1000, maxEntries: 3, now: () => 0 }),
    withSession,
  };
}

/** A session that answers `/v1/health` with `raw` from the given port. */
function healthyDeps(raw: RawHealth, port = 8207): ToolDeps {
  return makeToolDeps(async (_options, fn) => fn(fakeRoutes(async () => raw), fakeSession(port)));
}

interface HealthResult {
  ok: boolean;
  bridge: { host: string; port: number; config_path: string };
  upstream: { status: string | null; version: string | null };
  notice: string;
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('health', () => {
  it('reports the bridge endpoint, the handshake file and the app version', async () => {
    harness = await startHarness({ deps: healthyDeps({ status: 'ok', version: '1.9.2' }, 8207) });

    const result = await harness.callJson<HealthResult>('health');

    expect(result.ok).toBe(true);
    expect(result.bridge).toEqual({
      host: '127.0.0.1',
      port: 8207,
      config_path: '/fake/home/.openwhispr/cli-bridge.json',
    });
    expect(result.upstream).toEqual({ status: 'ok', version: '1.9.2' });
    expect(result.notice).toMatch(/restart/i);
  });

  it('keeps the port in the payload — it is the only way to tell instances apart', async () => {
    harness = await startHarness({ deps: healthyDeps({ status: 'ok' }, 8213) });
    const result = await harness.callJson<HealthResult>('health');
    expect(result.bridge.port).toBe(8213);
    expect(result.upstream.version).toBeNull();
  });

  it('logs the port to stderr', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      harness = await startHarness({ deps: healthyDeps({ status: 'ok' }, 8211) });
      await harness.callJson<HealthResult>('health');
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toContain('8211');
  });

  it('reports ok:false when the app answers with a status other than ok', async () => {
    harness = await startHarness({ deps: healthyDeps({ status: 'degraded', version: '1.9.2' }) });
    const result = await harness.callJson<HealthResult>('health');
    expect(result.ok).toBe(false);
    expect(result.upstream.status).toBe('degraded');
  });

  it('surfaces bridge_not_running with an actionable hint', async () => {
    harness = await startHarness({
      deps: makeToolDeps(async () => {
        throw new BridgeConfigError('bridge_not_running', 'handshake file not found', {
          hint: 'Start the OpenWhispr app; it writes ~/.openwhispr/cli-bridge.json on launch.',
        });
      }),
    });

    const result = await harness.call('health');
    expect(result.isError).toBe(true);
    const payload = toolError(result);
    expect(payload.kind).toBe('bridge_not_running');
    expect(payload.hint && payload.hint.length).toBeGreaterThan(0);
  });

  it('takes no arguments', async () => {
    harness = await startHarness({ deps: healthyDeps({ status: 'ok' }) });
    expect(isSchemaRejection(await harness.call('health', { verbose: true }))).toBe(true);
  });

  it('is advertised as a read-only, closed-world tool with a short description', async () => {
    harness = await startHarness({ deps: healthyDeps({ status: 'ok' }) });
    const tool = (await harness.listTools()).find((t) => t.name === 'health');

    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
    expect(tool!.description!.length).toBeGreaterThan(40);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
});
