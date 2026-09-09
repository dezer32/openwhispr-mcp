import { afterEach, describe, expect, it } from 'vitest';
import { createRoutes } from '../../../src/bridge/routes.js';
import { bridgeRequest } from '../../../src/bridge/httpClient.js';
import { BridgeTransportError } from '../../../src/bridge/errors.js';
import { DEFAULT_MAX_RESPONSE_BYTES, MAX_REQUEST_BYTES } from '../../../src/config.js';
import type { BridgeRoutes, BridgeSession, RequestSpec } from '../../../src/deps.js';
import { startFakeBridge, type FakeBridge, type FakeRequest } from '../../helpers/fakeBridge.js';
import { makeNote } from '../../fixtures/notes.js';
import { DEFAULT_FOLDERS } from '../../fixtures/folders.js';
import { makeTranscription } from '../../fixtures/transcriptions.js';

let bridge: FakeBridge | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

/** A session that really talks to the fake bridge but skips the replay logic. */
function connect(b: FakeBridge): { routes: BridgeRoutes; specs: RequestSpec[] } {
  const specs: RequestSpec[] = [];
  const session: BridgeSession = {
    host: b.host,
    port: b.port,
    attempt: 1,
    signal: new AbortController().signal,
    mutationCommitted: false,
    request<T>(spec: RequestSpec): Promise<T> {
      specs.push(spec);
      return bridgeRequest<T>(spec, {
        host: b.host,
        port: b.port,
        token: b.token,
        timeoutMs: 5_000,
        maxRequestBytes: MAX_REQUEST_BYTES,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      });
    },
  };
  return { routes: createRoutes(session), specs };
}

function lastRequest(b: FakeBridge): FakeRequest {
  const seen = b.requests.at(-1);
  if (!seen) throw new Error('the fake bridge saw no request');
  return seen;
}

async function withRoutes(
  b: FakeBridge,
  fn: (routes: BridgeRoutes) => Promise<unknown>,
): Promise<FakeRequest> {
  await fn(connect(b).routes);
  return lastRequest(b);
}

describe('createRoutes', () => {
  it('health hits GET /v1/health', async () => {
    bridge = await startFakeBridge({ state: { health: { status: 'ok', version: '1.9.2' } } });
    const { routes } = connect(bridge);
    await expect(routes.health()).resolves.toEqual({ status: 'ok', version: '1.9.2' });
    expect(lastRequest(bridge)).toMatchObject({ method: 'GET', path: '/v1/health', query: {} });
  });

  it('listNotes hits GET /v1/notes/list and passes only the filters it was given', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 1, folder_id: 2, note_type: 'meeting' })] } });
    const bare = await withRoutes(bridge, (routes) => routes.listNotes());
    expect(bare).toMatchObject({ method: 'GET', path: '/v1/notes/list', query: {} });

    const filtered = await withRoutes(bridge, (routes) =>
      routes.listNotes({ note_type: 'meeting', limit: 25, folder_id: 2 }),
    );
    expect(filtered.query).toEqual({ note_type: 'meeting', limit: '25', folder_id: '2' });
  });

  it('searchNotes hits GET /v1/notes/search with q and limit', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 1 })] } });
    const seen = await withRoutes(bridge, (routes) => routes.searchNotes({ q: 'road map', limit: 5 }));
    expect(seen).toMatchObject({ method: 'GET', path: '/v1/notes/search' });
    expect(seen.query).toEqual({ q: 'road map', limit: '5' });

    const bare = await withRoutes(bridge, (routes) => routes.searchNotes({ q: 'x' }));
    expect(bare.query).toEqual({ q: 'x' });
  });

  it('getNote hits GET /v1/notes/:id', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 42, title: 'Answer' })] } });
    const { routes } = connect(bridge);
    await expect(routes.getNote(42)).resolves.toMatchObject({ id: 42, title: 'Answer' });
    expect(lastRequest(bridge)).toMatchObject({ method: 'GET', path: '/v1/notes/42' });
  });

  it('createNote posts the payload to /v1/notes/create', async () => {
    bridge = await startFakeBridge();
    const { routes, specs } = connect(bridge);
    await routes.createNote({ title: 'T', content: 'C', note_type: 'personal', folder_id: 3 });
    const seen = lastRequest(bridge);
    expect(seen).toMatchObject({ method: 'POST', path: '/v1/notes/create' });
    expect(JSON.parse(seen.body)).toEqual({ title: 'T', content: 'C', note_type: 'personal', folder_id: 3 });
    expect(specs.at(-1)?.mutating).toBe(true);
  });

  it('createNote omits fields the caller left out', async () => {
    bridge = await startFakeBridge();
    const seen = await withRoutes(bridge, (routes) => routes.createNote({ title: 'only' }));
    expect(JSON.parse(seen.body)).toEqual({ title: 'only' });
  });

  it('updateNote patches /v1/notes/:id', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 8 })] } });
    const { routes, specs } = connect(bridge);
    await expect(routes.updateNote(8, { title: 'new' })).resolves.toEqual({ success: true });
    const seen = lastRequest(bridge);
    expect(seen).toMatchObject({ method: 'PATCH', path: '/v1/notes/8' });
    expect(JSON.parse(seen.body)).toEqual({ title: 'new' });
    expect(specs.at(-1)?.mutating).toBe(true);
  });

  it('deleteNote sends DELETE /v1/notes/:id and resolves to void', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 9 })] } });
    const { routes, specs } = connect(bridge);
    await expect(routes.deleteNote(9)).resolves.toBeUndefined();
    expect(lastRequest(bridge)).toMatchObject({ method: 'DELETE', path: '/v1/notes/9' });
    expect(specs.at(-1)?.mutating).toBe(true);
    expect(bridge.state.notes).toHaveLength(0);
  });

  it('listFolders hits GET /v1/folders/list', async () => {
    bridge = await startFakeBridge({ state: { folders: DEFAULT_FOLDERS } });
    const { routes } = connect(bridge);
    await expect(routes.listFolders()).resolves.toHaveLength(DEFAULT_FOLDERS.length);
    expect(lastRequest(bridge)).toMatchObject({ method: 'GET', path: '/v1/folders/list' });
  });

  it('createFolder posts {name} to /v1/folders/create', async () => {
    bridge = await startFakeBridge();
    const { routes, specs } = connect(bridge);
    await expect(routes.createFolder('Archive')).resolves.toMatchObject({ name: 'Archive' });
    const seen = lastRequest(bridge);
    expect(seen).toMatchObject({ method: 'POST', path: '/v1/folders/create' });
    expect(JSON.parse(seen.body)).toEqual({ name: 'Archive' });
    expect(specs.at(-1)?.mutating).toBe(true);
  });

  it('listDictionary hits GET /v1/dictionary/list and keeps the shape untouched', async () => {
    bridge = await startFakeBridge({ state: { dictionary: { words: ['Kubernetes'] } } });
    const { routes } = connect(bridge);
    await expect(routes.listDictionary()).resolves.toEqual({ words: ['Kubernetes'] });
    expect(lastRequest(bridge)).toMatchObject({ method: 'GET', path: '/v1/dictionary/list' });
  });

  it('updateDictionary posts add/remove to /v1/dictionary/update', async () => {
    bridge = await startFakeBridge();
    const { routes, specs } = connect(bridge);
    await routes.updateDictionary({ add: ['Qdrant'], remove: ['typo'] });
    const seen = lastRequest(bridge);
    expect(seen).toMatchObject({ method: 'POST', path: '/v1/dictionary/update' });
    expect(JSON.parse(seen.body)).toEqual({ add: ['Qdrant'], remove: ['typo'] });
    expect(specs.at(-1)?.mutating).toBe(true);
  });

  it('listTranscriptions hits GET /v1/transcriptions/list with limit', async () => {
    bridge = await startFakeBridge({ state: { transcriptions: [makeTranscription({ id: 1 })] } });
    const bare = await withRoutes(bridge, (routes) => routes.listTranscriptions());
    expect(bare).toMatchObject({ method: 'GET', path: '/v1/transcriptions/list', query: {} });

    const limited = await withRoutes(bridge, (routes) => routes.listTranscriptions({ limit: 10 }));
    expect(limited.query).toEqual({ limit: '10' });
  });

  it('getTranscription hits GET /v1/transcriptions/:id', async () => {
    bridge = await startFakeBridge({ state: { transcriptions: [makeTranscription({ id: 3 })] } });
    const { routes } = connect(bridge);
    await expect(routes.getTranscription(3)).resolves.toMatchObject({ id: 3 });
    expect(lastRequest(bridge)).toMatchObject({ method: 'GET', path: '/v1/transcriptions/3' });
  });

  it('marks only the five mutating routes as mutating', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 1 })], transcriptions: [makeTranscription({ id: 1 })] } });
    const { routes, specs } = connect(bridge);
    await routes.health();
    await routes.listNotes();
    await routes.searchNotes({ q: 'a' });
    await routes.getNote(1);
    await routes.listFolders();
    await routes.listDictionary();
    await routes.listTranscriptions();
    await routes.getTranscription(1);
    expect(specs.every((spec) => spec.mutating !== true)).toBe(true);

    await routes.createNote({ title: 'x' });
    await routes.updateNote(1, { title: 'y' });
    await routes.createFolder('f');
    await routes.updateDictionary({ add: ['z'] });
    await routes.deleteNote(1);
    expect(specs.slice(-5).map((spec) => spec.mutating)).toEqual([true, true, true, true, true]);
  });

  it.each([
    ['listNotes', '/v1/notes/list', (routes: BridgeRoutes) => routes.listNotes()],
    ['searchNotes', '/v1/notes/search', (routes: BridgeRoutes) => routes.searchNotes({ q: 'a' })],
    ['listFolders', '/v1/folders/list', (routes: BridgeRoutes) => routes.listFolders()],
    ['listTranscriptions', '/v1/transcriptions/list', (routes: BridgeRoutes) => routes.listTranscriptions()],
  ])('%s rejects a payload that is not a list', async (_label, path, call) => {
    bridge = await startFakeBridge();
    bridge.on('GET', path, () => ({ status: 200, json: { data: { id: 1 } } }));
    const { routes } = connect(bridge);
    let caught: unknown;
    try {
      await call(routes);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeTransportError);
    expect((caught as BridgeTransportError).kind).toBe('upstream_protocol');
  });
});
