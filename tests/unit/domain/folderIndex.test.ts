import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BridgeRoutes } from '../../../src/deps.js';
import type { RawFolder } from '../../../src/bridge/types.js';
import { createFolderIndex } from '../../../src/domain/folderIndex.js';
import { DEFAULT_FOLDERS, makeFolder } from '../../fixtures/folders.js';

/** A hand-rolled `BridgeRoutes`: the index only ever touches `listFolders`. */
function fakeRoutes(listFolders: () => Promise<RawFolder[]>): {
  routes: BridgeRoutes;
  calls: () => number;
} {
  const spy = vi.fn(listFolders);
  return { routes: { listFolders: spy } as unknown as BridgeRoutes, calls: () => spy.mock.calls.length };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFolderIndex', () => {
  it('resolves a folder name', async () => {
    const { routes } = fakeRoutes(async () => DEFAULT_FOLDERS);
    const index = createFolderIndex(routes);
    await expect(index.nameOf(2)).resolves.toBe('Meetings');
  });

  it('fetches the folder list only once, however many names are asked for', async () => {
    const { routes, calls } = fakeRoutes(async () => DEFAULT_FOLDERS);
    const index = createFolderIndex(routes);

    expect(await index.nameOf(1)).toBe('Personal');
    expect(await index.nameOf(2)).toBe('Meetings');
    expect(await index.nameOf(3)).toBe('Videos');
    await index.all();

    expect(calls()).toBe(1);
  });

  it('shares one in-flight request between racing callers', async () => {
    const gate = deferred<RawFolder[]>();
    const { routes, calls } = fakeRoutes(() => gate.promise);
    const index = createFolderIndex(routes);

    const racers = Promise.all([index.nameOf(1), index.nameOf(2), index.nameOf(3), index.all()]);
    expect(calls()).toBe(1);

    gate.resolve(DEFAULT_FOLDERS);
    const [first, second, third] = await racers;

    expect([first, second, third]).toEqual(['Personal', 'Meetings', 'Videos']);
    expect(calls()).toBe(1);
  });

  it('returns null for a null or undefined folder id without asking the bridge', async () => {
    const { routes, calls } = fakeRoutes(async () => DEFAULT_FOLDERS);
    const index = createFolderIndex(routes);

    expect(await index.nameOf(null)).toBeNull();
    expect(await index.nameOf(undefined)).toBeNull();
    expect(calls()).toBe(0);
  });

  it('returns null for an id the bridge does not know', async () => {
    const { routes } = fakeRoutes(async () => DEFAULT_FOLDERS);
    const index = createFolderIndex(routes);
    expect(await index.nameOf(999)).toBeNull();
  });

  it('survives a folder list that fails, warning once and never retrying', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { routes, calls } = fakeRoutes(async () => {
      throw new Error('bridge is gone');
    });
    const index = createFolderIndex(routes);

    expect(await index.nameOf(1)).toBeNull();
    expect(await index.nameOf(2)).toBeNull();
    expect(calls()).toBe(1);

    const warnings = stderr.mock.calls.map(([line]) => String(line));
    expect(warnings.some((line) => line.includes('warn') && line.includes('folder'))).toBe(true);
  });

  it('flags a swallowed failure so a null name is not read as "no folder"', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { routes } = fakeRoutes(async () => {
      throw new Error('bridge is gone');
    });
    const index = createFolderIndex(routes);

    expect(index.namesUnavailable).toBe(false);
    expect(await index.nameOf(1)).toBeNull();
    expect(index.namesUnavailable).toBe(true);
  });

  it('does not flag names as unavailable when the list simply has no such id', async () => {
    const { routes } = fakeRoutes(async () => DEFAULT_FOLDERS);
    const index = createFolderIndex(routes);

    expect(await index.nameOf(999)).toBeNull();
    expect(await index.nameOf(null)).toBeNull();
    expect(index.namesUnavailable).toBe(false);
  });

  it('lets `all` surface the failure the name lookup swallowed', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { routes, calls } = fakeRoutes(async () => {
      throw new Error('bridge is gone');
    });
    const index = createFolderIndex(routes);

    expect(await index.nameOf(1)).toBeNull();
    await expect(index.all()).rejects.toThrow('bridge is gone');
    expect(calls()).toBe(1);
  });

  it('projects the folder list through toFolder', async () => {
    const { routes } = fakeRoutes(async () => DEFAULT_FOLDERS);
    const index = createFolderIndex(routes);

    const folders = await index.all();
    expect(folders).toHaveLength(3);
    expect(Object.keys(folders[0] ?? {}).sort()).toEqual(
      ['created_at', 'id', 'is_default', 'name', 'sort_order', 'updated_at'].sort(),
    );
    expect(folders[0]?.is_default).toBe(true);
    expect(folders[0]?.name).toBe('Personal');
  });

  it('ignores rows with no usable name', async () => {
    const { routes } = fakeRoutes(async () => [
      makeFolder({ id: 1, name: null }),
      makeFolder({ id: 2, name: 'Real' }),
    ]);
    const index = createFolderIndex(routes);

    expect(await index.nameOf(1)).toBeNull();
    expect(await index.nameOf(2)).toBe('Real');
  });

  it('handles an empty folder list', async () => {
    const { routes } = fakeRoutes(async () => []);
    const index = createFolderIndex(routes);

    expect(await index.nameOf(1)).toBeNull();
    expect(await index.all()).toEqual([]);
  });

  it('tolerates a non-array answer without throwing', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { routes } = fakeRoutes(async () => null as unknown as RawFolder[]);
    const index = createFolderIndex(routes);

    expect(await index.nameOf(1)).toBeNull();
  });
});
