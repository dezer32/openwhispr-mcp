import { describe, expect, it, vi } from 'vitest';
import {
  BridgeConfigError,
  BridgeHttpError,
  BridgeTransportError,
  ToolError,
  type ErrorKind,
} from '../../../src/bridge/errors.js';
import { loadConfig, type Config } from '../../../src/config.js';
import { createTtlStore } from '../../../src/domain/snapshotStore.js';
import type { BridgeRoutes, BridgeSession, ToolDeps } from '../../../src/deps.js';
import { mapToolError } from '../../../src/mcp/errorMap.js';
import { makeFolder } from '../../fixtures/folders.js';

/** Config built from an empty env so an ambient OPENWHISPR_MCP_DEBUG cannot leak in. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({} as NodeJS.ProcessEnv), ...overrides };
}

function fakeRoutes(overrides: Partial<BridgeRoutes> = {}): BridgeRoutes {
  const missing = (): never => {
    throw new Error('unexpected route call');
  };
  return {
    health: missing,
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
    ...overrides,
  } as BridgeRoutes;
}

function fakeSession(): BridgeSession {
  return {
    host: '127.0.0.1',
    port: 8200,
    attempt: 1,
    signal: new AbortController().signal,
    mutationCommitted: false,
    request: async () => {
      throw new Error('unexpected raw request');
    },
  };
}

function makeToolDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    config: baseConfig(),
    now: () => 0,
    snapshots: createTtlStore<unknown>({ ttlMs: 1000, maxEntries: 3, now: () => 0 }),
    withSession: async () => {
      throw new Error('withSession must not be called');
    },
    ...overrides,
  };
}

function ctxFor(deps: ToolDeps, signal?: AbortSignal) {
  return { deps, toolName: 'test_tool', signal };
}

/** A 500 carrying a domain message, exactly as the bridge reports one. */
function domain500(message: string): BridgeHttpError {
  return new BridgeHttpError({
    status: 500,
    upstreamCode: 'internal_error',
    upstreamMessage: message,
  });
}

describe('mapToolError — domain errors reported as HTTP 500', () => {
  const cases: { upstream: string; kind: ErrorKind }[] = [
    { upstream: 'Folder not found in the active account scope', kind: 'folder_not_found' },
    { upstream: 'Folder not found', kind: 'folder_not_found' },
    { upstream: 'A folder with that name already exists', kind: 'folder_name_conflict' },
    { upstream: 'Folder name is required', kind: 'invalid_argument' },
    { upstream: 'Failed to write note', kind: 'write_failed' },
    { upstream: 'datatype mismatch', kind: 'internal_bug' },
    { upstream: 'SQLITE_CONSTRAINT: FOREIGN KEY constraint failed', kind: 'internal_bug' },
  ];

  for (const { upstream, kind } of cases) {
    it(`maps "${upstream}" to ${kind}`, async () => {
      // folder kinds trigger enrichment, so give them a session that can answer.
      const deps = makeToolDeps({
        withSession: async (_options, fn) => fn(fakeRoutes({ listFolders: async () => [] }), fakeSession()),
      });
      const payload = await mapToolError(domain500(upstream), ctxFor(deps));
      expect(payload.kind).toBe(kind);
      expect(payload.message.length).toBeGreaterThan(0);
    });
  }

  it('does not leak the raw upstream text into the message', async () => {
    const deps = makeToolDeps();
    const payload = await mapToolError(domain500('Failed to write note'), ctxFor(deps));
    expect(payload.kind).toBe('write_failed');
    expect(payload.message).toMatch(/reject/i);
    // A write can fail for any reason; never turn it into "add a missing field".
    expect(`${payload.message} ${payload.hint ?? ''}`).not.toMatch(/add (a|the) .*field/i);
  });

  it('gives the sqlite fault a hint about an argument leaking into SQL', async () => {
    const deps = makeToolDeps();
    const payload = await mapToolError(domain500('datatype mismatch'), ctxFor(deps));
    expect(payload.kind).toBe('internal_bug');
    expect(String(payload.hint)).toMatch(/argument/i);
  });

  it('matches through an "Error:" wrapper and a trailing period', async () => {
    const deps = makeToolDeps({
      withSession: async (_options, fn) => fn(fakeRoutes({ listFolders: async () => [] }), fakeSession()),
    });
    const payload = await mapToolError(domain500('Error: Folder not found.'), ctxFor(deps));
    expect(payload.kind).toBe('folder_not_found');
  });

  it('is anchored: a domain phrase inside a longer sentence does not match', async () => {
    const deps = makeToolDeps();
    const payload = await mapToolError(domain500('note: Folder not found there'), ctxFor(deps));
    expect(payload.kind).toBe('upstream_error');
    expect(payload.details).toMatchObject({ http_status: 500 });
  });

  it('maps an unrecognised 500 to upstream_error carrying the status', async () => {
    const deps = makeToolDeps();
    const payload = await mapToolError(domain500('something entirely new'), ctxFor(deps));
    expect(payload.kind).toBe('upstream_error');
    expect(payload.details).toMatchObject({ http_status: 500 });
  });
});

describe('mapToolError — lazy available_folders enrichment', () => {
  it('fetches the folder list exactly once and annotates where it came from', async () => {
    const withSession = vi.fn(async (_options: unknown, fn: (r: BridgeRoutes, s: BridgeSession) => Promise<unknown>) =>
      fn(fakeRoutes({ listFolders: async () => [makeFolder({ id: 1, name: 'Personal' }), makeFolder({ id: 4, name: 'Work' })] }), fakeSession()),
    );
    const deps = makeToolDeps({ withSession: withSession as unknown as ToolDeps['withSession'] });

    const payload = await mapToolError(domain500('Folder not found'), ctxFor(deps));

    expect(payload.kind).toBe('folder_not_found');
    expect(withSession).toHaveBeenCalledTimes(1);
    expect(payload.details?.available_folders).toEqual([
      { id: 1, name: 'Personal' },
      { id: 4, name: 'Work' },
    ]);
    expect(String(payload.details?.available_folders_note)).toMatch(/after/i);
  });

  it('enriches a folder name conflict too', async () => {
    const deps = makeToolDeps({
      withSession: async (_options, fn) => fn(fakeRoutes({ listFolders: async () => [makeFolder({ id: 2, name: 'Meetings' })] }), fakeSession()),
    });

    const payload = await mapToolError(domain500('A folder with that name already exists'), ctxFor(deps));

    expect(payload.kind).toBe('folder_name_conflict');
    expect(payload.details?.available_folders).toEqual([{ id: 2, name: 'Meetings' }]);
  });

  it('keeps the original error when the enrichment call itself fails', async () => {
    const deps = makeToolDeps({
      withSession: async () => {
        throw new BridgeConfigError('bridge_not_running', 'the app stopped in the meantime');
      },
    });

    const payload = await mapToolError(domain500('Folder not found'), ctxFor(deps));

    expect(payload.kind).toBe('folder_not_found');
    expect(payload.details?.available_folders).toBeUndefined();
    expect(payload.details?.available_folders_note).toBeUndefined();
  });

  it('does not enrich unrelated kinds', async () => {
    const withSession = vi.fn(async () => {
      throw new Error('must not run');
    });
    const deps = makeToolDeps({ withSession: withSession as unknown as ToolDeps['withSession'] });

    const payload = await mapToolError(
      new BridgeHttpError({ status: 404, upstreamMessage: 'Note not found' }),
      ctxFor(deps),
    );

    expect(payload.kind).toBe('not_found');
    expect(withSession).not.toHaveBeenCalled();
  });

  it('skips enrichment once the call has been cancelled', async () => {
    const withSession = vi.fn(async () => {
      throw new Error('must not run');
    });
    const deps = makeToolDeps({ withSession: withSession as unknown as ToolDeps['withSession'] });
    const controller = new AbortController();
    controller.abort();

    const payload = await mapToolError(domain500('Folder not found'), ctxFor(deps, controller.signal));

    expect(payload.kind).toBe('folder_not_found');
    expect(withSession).not.toHaveBeenCalled();
  });
});

describe('mapToolError — raw upstream text', () => {
  it('hides the upstream message by default', async () => {
    const deps = makeToolDeps();
    const payload = await mapToolError(domain500('near "SELECT": syntax error at /Users/me/db'), ctxFor(deps));
    expect(payload.details?.upstream_message).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('/Users/me/db');
  });

  it('echoes the upstream message under debug', async () => {
    const deps = makeToolDeps({ config: baseConfig({ debug: true }) });
    const payload = await mapToolError(domain500('near "SELECT": syntax error'), ctxFor(deps));
    expect(payload.details?.upstream_message).toBe('near "SELECT": syntax error');
  });

  it('always writes the raw text to stderr', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await mapToolError(domain500('Failed to write note'), ctxFor(makeToolDeps()));
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toContain('Failed to write note');
  });
});

describe('mapToolError — non-HTTP failures', () => {
  it('maps a bare AbortError to cancelled', async () => {
    const payload = await mapToolError(
      new DOMException('The operation was aborted.', 'AbortError'),
      ctxFor(makeToolDeps()),
    );
    expect(payload.kind).toBe('cancelled');
  });

  it('maps an Error named AbortError to cancelled', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const payload = await mapToolError(err, ctxFor(makeToolDeps()));
    expect(payload.kind).toBe('cancelled');
  });

  it('passes our own errors through untouched', async () => {
    const payload = await mapToolError(
      new ToolError('snapshot_expired', 'cursor expired', { hint: 'Re-run list_notes.', details: { cursor: 'c1' } }),
      ctxFor(makeToolDeps()),
    );
    expect(payload).toEqual({
      kind: 'snapshot_expired',
      message: 'cursor expired',
      hint: 'Re-run list_notes.',
      details: { cursor: 'c1' },
    });
  });

  it('keeps a transport error as-is rather than calling it a bug', async () => {
    const payload = await mapToolError(
      new BridgeTransportError('bridge_unreachable', 'connection refused'),
      ctxFor(makeToolDeps()),
    );
    expect(payload.kind).toBe('bridge_unreachable');
  });

  it('maps an unexpected throw to internal_bug', async () => {
    const payload = await mapToolError(new TypeError('x.map is not a function'), ctxFor(makeToolDeps()));
    expect(payload.kind).toBe('internal_bug');
    expect(payload.message).toContain('x.map is not a function');
  });

  it('survives a thrown value that cannot be stringified', async () => {
    const payload = await mapToolError(Object.create(null), ctxFor(makeToolDeps()));
    expect(payload.kind).toBe('internal_bug');
    expect(typeof payload.message).toBe('string');
  });
});
