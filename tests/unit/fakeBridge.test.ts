import { afterEach, describe, expect, it } from 'vitest';
import { startFakeBridge, type FakeBridge } from '../helpers/fakeBridge.js';
import { readFile } from 'node:fs/promises';
import { makeNote } from '../fixtures/notes.js';
import { DEFAULT_FOLDERS } from '../fixtures/folders.js';

/** The fake bridge is shared infrastructure, so it gets its own tests. */
let bridge: FakeBridge | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

async function get(b: FakeBridge, path: string, token = b.token): Promise<Response> {
  return fetch(`http://127.0.0.1:${b.port}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('fakeBridge', () => {
  it('listens outside the documented 8200-8219 window', async () => {
    bridge = await startFakeBridge();
    expect(bridge.port < 8200 || bridge.port > 8219).toBe(true);
  });

  it('writes a 0600 handshake file with port and token', async () => {
    bridge = await startFakeBridge();
    const raw = JSON.parse(await readFile(bridge.configPath, 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ host: '127.0.0.1', port: bridge.port, token: bridge.token });
    expect(bridge.token).toHaveLength(64);
  });

  it('401s a wrong token and 200s the right one', async () => {
    bridge = await startFakeBridge();
    expect((await get(bridge, '/v1/health', 'nope')).status).toBe(401);
    const ok = await get(bridge, '/v1/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { status: 'ok', version: '1.9.2' } });
  });

  it('wraps lists with the hardcoded has_more/next_cursor', async () => {
    bridge = await startFakeBridge({ state: { folders: DEFAULT_FOLDERS } });
    const body = (await (await get(bridge, '/v1/folders/list')).json()) as Record<string, unknown>;
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect((body.data as unknown[]).length).toBe(3);
  });

  it('answers DELETE with an empty 204', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 5 })] } });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/notes/5`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(bridge.state.notes).toHaveLength(0);
  });

  it('honours note_type, folder_id and limit on notes/list', async () => {
    bridge = await startFakeBridge({
      state: {
        notes: [
          makeNote({ id: 1, note_type: 'meeting', folder_id: 2 }),
          makeNote({ id: 2, note_type: 'personal', folder_id: 1 }),
          makeNote({ id: 3, note_type: 'meeting', folder_id: 2 }),
        ],
      },
    });
    const filtered = (await (
      await get(bridge, '/v1/notes/list?note_type=meeting&folder_id=2&limit=1')
    ).json()) as { data: unknown[] };
    expect(filtered.data).toHaveLength(1);
  });

  it('lets a test override a route through on()', async () => {
    bridge = await startFakeBridge();
    bridge.on('GET', '/v1/health', () => ({ status: 500, json: { error: { code: 'internal_error', message: 'boom' } } }));
    const res = await get(bridge, '/v1/health');
    expect(res.status).toBe(500);
  });

  it('serves faults', async () => {
    bridge = await startFakeBridge();
    bridge.fault('nonJson');
    expect(await (await get(bridge, '/v1/health')).text()).toContain('not json');
    bridge.fault({ status: 503, body: { error: { code: 'internal_error', message: 'down' } } });
    expect((await get(bridge, '/v1/health')).status).toBe(503);
    bridge.fault(null);
    expect((await get(bridge, '/v1/health')).status).toBe(200);
  });

  it('rotateToken keeps the port, restart changes both', async () => {
    bridge = await startFakeBridge();
    const port0 = bridge.port;
    const token0 = bridge.token;
    await bridge.rotateToken();
    expect(bridge.port).toBe(port0);
    expect(bridge.token).not.toBe(token0);
    expect((await get(bridge, '/v1/health', token0)).status).toBe(401);

    await bridge.restart();
    expect(bridge.port).not.toBe(port0);
    const written = JSON.parse(await readFile(bridge.configPath, 'utf8')) as Record<string, unknown>;
    expect(written.port).toBe(bridge.port);
    expect((await get(bridge, '/v1/health')).status).toBe(200);
  });

  it('records every request it saw', async () => {
    bridge = await startFakeBridge();
    await get(bridge, '/v1/health');
    expect(bridge.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/health' });
  });
});
