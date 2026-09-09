import { afterEach, describe, expect, it, vi } from 'vitest';
import { withBridgeSession } from '../../../src/bridge/session.js';
import {
  BridgeConfigError,
  BridgeHttpError,
  BridgeTransportError,
} from '../../../src/bridge/errors.js';
import { loadConfig, type Config } from '../../../src/config.js';
import type { FakeResponse } from '../../helpers/fakeBridge.js';
import { startFakeBridge, type FakeBridge } from '../../helpers/fakeBridge.js';
import { makeNote } from '../../fixtures/notes.js';
import { DEFAULT_FOLDERS } from '../../fixtures/folders.js';

let bridge: FakeBridge | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

function configFor(b: FakeBridge, overrides: Partial<Config> = {}): Config {
  const base = loadConfig({ OPENWHISPR_BRIDGE_CONFIG: b.configPath } as NodeJS.ProcessEnv);
  return { ...base, timeoutMs: 3_000, ...overrides };
}

const UNAUTHORIZED: FakeResponse = {
  status: 401,
  json: { error: { code: 'unauthorized', message: 'Invalid or missing token' } },
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the session to reject');
}

describe('withBridgeSession', () => {
  it('pins the handshake and runs fn exactly once', async () => {
    const b = (bridge = await startFakeBridge({ state: { health: { status: 'ok' } } }));
    const attempts: number[] = [];
    const health = await withBridgeSession(configFor(b), {}, async (routes, session) => {
      attempts.push(session.attempt);
      expect(session.host).toBe('127.0.0.1');
      expect(session.port).toBe(b.port);
      expect(session.mutationCommitted).toBe(false);
      return routes.health();
    });
    expect(health).toEqual({ status: 'ok' });
    expect(attempts).toEqual([1]);
  });

  it('flips mutationCommitted once a mutating call succeeds', async () => {
    const b = (bridge = await startFakeBridge());
    const flags: boolean[] = [];
    await withBridgeSession(configFor(b), {}, async (routes, session) => {
      flags.push(session.mutationCommitted);
      await routes.listFolders();
      flags.push(session.mutationCommitted);
      await routes.createNote({ title: 'x' });
      flags.push(session.mutationCommitted);
    });
    expect(flags).toEqual([false, false, true]);
  });

  it('replays fn once after a 401, using the re-read token', async () => {
    const b = (bridge = await startFakeBridge({ state: { health: { status: 'ok' } } }));
    let passes = 0;
    const result = await withBridgeSession(configFor(b), {}, async (routes, session) => {
      passes += 1;
      // The app rotated its token while we held the old one.
      if (passes === 1) await b.rotateToken();
      return { health: await routes.health(), attempt: session.attempt };
    });
    expect(passes).toBe(2);
    expect(result).toEqual({ health: { status: 'ok' }, attempt: 2 });
    expect(b.requests.filter((r) => r.path === '/v1/health')).toHaveLength(2);
  });

  it('follows an app restart that moved the bridge to a new port', async () => {
    const b = (bridge = await startFakeBridge({ state: { health: { status: 'ok' } } }));
    const stalePort = b.port;
    let served = 0;
    b.on('GET', '/v1/health', () => {
      served += 1;
      return served === 1 ? UNAUTHORIZED : { status: 200, json: { data: { status: 'ok' } } };
    });

    let passes = 0;
    const ports: number[] = [];
    const health = await withBridgeSession(configFor(b), {}, async (routes, session) => {
      passes += 1;
      ports.push(session.port);
      try {
        return await routes.health();
      } catch (err) {
        // The 401 was the app shutting down; by the time we re-read the file it
        // is back on a different port with a different token.
        if (passes === 1) await b.restart();
        throw err;
      }
    });

    expect(health).toEqual({ status: 'ok' });
    expect(passes).toBe(2);
    expect(ports).toEqual([stalePort, b.port]);
    expect(b.port).not.toBe(stalePort);
  });

  it('does not replay a 401 that follows a committed mutation', async () => {
    const b = (bridge = await startFakeBridge());
    let passes = 0;
    const err = await rejection(
      withBridgeSession(configFor(b), {}, async (routes) => {
        passes += 1;
        await routes.createNote({ title: 'only once' });
        await b.rotateToken();
        return routes.health();
      }),
    );
    expect(passes).toBe(1);
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect((err as BridgeHttpError).kind).toBe('unauthorized');
    expect((err as BridgeHttpError).hint).toMatch(/manual|retry/i);
    expect(b.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(b.state.notes).toHaveLength(1);
  });

  it('propagates a 401 raised on the second attempt', async () => {
    const b = (bridge = await startFakeBridge());
    let passes = 0;
    const err = await rejection(
      withBridgeSession(configFor(b), {}, async (routes) => {
        passes += 1;
        await b.rotateToken();
        return routes.health();
      }),
    );
    expect(passes).toBe(2);
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect((err as BridgeHttpError).status).toBe(401);
  });

  it('aborts sibling requests before replaying', async () => {
    const b = (bridge = await startFakeBridge({ state: { folders: DEFAULT_FOLDERS } }));
    let served = 0;
    b.on('GET', '/v1/health', () => {
      served += 1;
      return served === 1 ? UNAUTHORIZED : { status: 200, json: { data: { status: 'ok' } } };
    });
    b.on('GET', '/v1/folders/list', () => new Promise<FakeResponse>(() => {}));

    const siblings: Array<Promise<unknown>> = [];
    await withBridgeSession(configFor(b), {}, async (routes) => {
      siblings.push(routes.listFolders().catch((err: unknown) => err));
      return routes.health();
    });

    const outcome = await siblings[0];
    expect(outcome).toBeInstanceOf(BridgeTransportError);
    expect((outcome as BridgeTransportError).kind).toBe('cancelled');
  });

  it('aborts requests still in flight when fn returns', async () => {
    const b = (bridge = await startFakeBridge());
    b.on('GET', '/v1/folders/list', () => new Promise<FakeResponse>(() => {}));
    let pending: Promise<unknown> | undefined;
    await withBridgeSession(configFor(b), {}, async (routes) => {
      pending = routes.listFolders().catch((err: unknown) => err);
      return 'done';
    });
    const outcome = await pending;
    expect((outcome as BridgeTransportError).kind).toBe('cancelled');
  });

  it('never replays a dropped socket', async () => {
    const b = (bridge = await startFakeBridge());
    b.fault('closeSocket');
    let passes = 0;
    const err = await rejection(
      withBridgeSession(configFor(b), {}, async (routes) => {
        passes += 1;
        return routes.createNote({ title: 'do not duplicate me' });
      }),
    );
    expect(passes).toBe(1);
    expect((err as BridgeTransportError).kind).toBe('bridge_unreachable');
    expect(b.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('honours the caller cancellation signal', async () => {
    const b = (bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 1 })] } }));
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(
      withBridgeSession(configFor(b), { signal: controller.signal }, (routes) => routes.listNotes()),
    );
    expect((err as BridgeTransportError).kind).toBe('cancelled');
  });

  it('surfaces a missing handshake without ever calling fn', async () => {
    const b = (bridge = await startFakeBridge());
    await b.removeConfig();
    let called = false;
    const err = await rejection(
      withBridgeSession(configFor(b), {}, async (routes) => {
        called = true;
        return routes.health();
      }),
    );
    expect(called).toBe(false);
    expect(err).toBeInstanceOf(BridgeConfigError);
    expect((err as BridgeConfigError).kind).toBe('bridge_not_running');
  });

  it('logs the port and attempt but never the token', async () => {
    const b = (bridge = await startFakeBridge());
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const previousDebug = process.env.OPENWHISPR_MCP_DEBUG;
    process.env.OPENWHISPR_MCP_DEBUG = '1';
    try {
      let passes = 0;
      await withBridgeSession(configFor(b), {}, async (routes) => {
        passes += 1;
        if (passes === 1) await b.rotateToken();
        return routes.health();
      });
    } finally {
      spy.mockRestore();
      if (previousDebug === undefined) delete process.env.OPENWHISPR_MCP_DEBUG;
      else process.env.OPENWHISPR_MCP_DEBUG = previousDebug;
    }
    const stderr = written.join('');
    expect(stderr).toContain('bridge session');
    expect(stderr).toContain(String(b.port));
    expect(stderr).toContain('"attempt":2');
    expect(stderr).not.toContain(b.token);
    expect(stderr).not.toContain(b.token.slice(0, 16));
  });
});
