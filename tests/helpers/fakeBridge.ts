import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * In-process stand-in for the OpenWhispr CLI bridge.
 *
 * Listens on an ephemeral port — deliberately outside 8200-8219, which proves the
 * client never scans the documented range — and reproduces the real envelopes,
 * including the hardcoded `has_more:false` / `next_cursor:null` and the empty 204
 * on DELETE.
 *
 * FROZEN CONTRACT: extend behaviour through `on()` / `fault()` / `state`, never by
 * editing this file.
 */

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  authorization: string | undefined;
  body: string;
  port: number;
}

export interface FakeResponse {
  status: number;
  /** Serialised as JSON verbatim — no envelope is added. */
  json?: unknown;
  /** Raw body, wins over `json`. */
  raw?: string;
  headers?: Record<string, string>;
}

export type FakeHandler = (req: FakeRequest, bridge: FakeBridge) => FakeResponse | Promise<FakeResponse>;

export type Fault =
  | null
  | 'hang'
  | 'nonJson'
  | 'closeSocket'
  | { status: number; body?: unknown; raw?: string };

export interface FakeBridgeState {
  notes: Record<string, unknown>[];
  folders: Record<string, unknown>[];
  transcriptions: Record<string, unknown>[];
  dictionary: unknown;
  health: Record<string, unknown>;
  /** Rows returned by `/v1/notes/search`; defaults to `notes` when unset. */
  searchResults?: Record<string, unknown>[];
}

export interface FakeBridge {
  readonly port: number;
  readonly host: string;
  readonly token: string;
  readonly configPath: string;
  readonly requests: FakeRequest[];
  readonly state: FakeBridgeState;
  /** Registers or replaces a handler. `path` may be a string or a RegExp. */
  on(method: string, path: string | RegExp, handler: FakeHandler): void;
  /** Removes every handler registered through `on()`, restoring the defaults. */
  resetHandlers(): void;
  fault(fault: Fault): void;
  /** New token, same port; the handshake file is rewritten. */
  rotateToken(): Promise<void>;
  /** New port AND new token, as a real app restart does. */
  restart(): Promise<void>;
  removeConfig(): Promise<void>;
  writeConfig(patch?: Record<string, unknown>): Promise<void>;
  /** Replaces the handshake file with arbitrary bytes. */
  writeRawConfig(contents: string): Promise<void>;
  close(): Promise<void>;
}

interface Registration {
  method: string;
  path: string | RegExp;
  handler: FakeHandler;
}

const LIST_ENVELOPE = (rows: unknown[]): unknown => ({
  data: rows,
  has_more: false,
  next_cursor: null,
});

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

export interface StartFakeBridgeOptions {
  state?: Partial<FakeBridgeState>;
  /** Omit to write the handshake file on startup. */
  writeConfig?: boolean;
}

export async function startFakeBridge(options: StartFakeBridgeOptions = {}): Promise<FakeBridge> {
  const dir = await mkdtemp(join(tmpdir(), 'openwhispr-fake-'));
  const configPath = join(dir, 'cli-bridge.json');

  const state: FakeBridgeState = {
    notes: [],
    folders: [],
    transcriptions: [],
    dictionary: [],
    health: { status: 'ok', version: '1.9.2' },
    ...options.state,
  };

  const registrations: Registration[] = [];
  const requests: FakeRequest[] = [];
  let token = randomBytes(32).toString('hex');
  let fault: Fault = null;
  let server: Server;
  let port = 0;

  const bridge: FakeBridge = {
    get port() {
      return port;
    },
    host: '127.0.0.1',
    get token() {
      return token;
    },
    configPath,
    requests,
    state,
    on(method, path, handler) {
      registrations.unshift({ method: method.toUpperCase(), path, handler });
    },
    resetHandlers() {
      registrations.length = 0;
    },
    fault(next) {
      fault = next;
    },
    async rotateToken() {
      token = randomBytes(32).toString('hex');
      await bridge.writeConfig();
    },
    async restart() {
      const previousPort = port;
      await closeServer();
      token = randomBytes(32).toString('hex');
      do {
        await listen();
      } while (port === previousPort);
      await bridge.writeConfig();
    },
    async removeConfig() {
      await rm(configPath, { force: true });
    },
    async writeConfig(patch = {}) {
      const payload = { host: '127.0.0.1', port, token, pid: process.pid, ...patch };
      await writeFile(configPath, JSON.stringify(payload), 'utf8');
      await chmod(configPath, 0o600);
    },
    async writeRawConfig(contents) {
      await writeFile(configPath, contents, 'utf8');
      await chmod(configPath, 0o600);
    },
    async close() {
      await closeServer();
      await rm(dir, { recursive: true, force: true });
    },
  };

  function closeServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  function listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      server = createServer(handle);
      server.on('connection', (socket) => socket.unref());
      // Without this the promise would hang forever when the port cannot be bound.
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  function send(res: ServerResponse, response: FakeResponse): void {
    const headers: Record<string, string> = { ...(response.headers ?? {}) };
    if (response.status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const body = response.raw ?? JSON.stringify(response.json ?? null);
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
    res.writeHead(response.status, headers);
    res.end(body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const body = await readBody(req);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const record: FakeRequest = {
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query,
      headers: req.headers,
      authorization: req.headers.authorization,
      body,
      port,
    };
    requests.push(record);

    if (fault === 'hang') return;
    if (fault === 'closeSocket') {
      req.socket.destroy();
      return;
    }
    if (fault === 'nonJson') {
      send(res, { status: 200, raw: '<!doctype html>not json', headers: { 'content-type': 'text/html' } });
      return;
    }
    if (fault && typeof fault === 'object') {
      send(res, { status: fault.status, json: fault.body, raw: fault.raw });
      return;
    }

    if (record.authorization !== `Bearer ${token}`) {
      send(res, { status: 401, json: errorBody('unauthorized', 'Invalid or missing token') });
      return;
    }

    for (const reg of registrations) {
      if (reg.method !== record.method) continue;
      const matches =
        typeof reg.path === 'string' ? reg.path === record.path : reg.path.test(record.path);
      if (!matches) continue;
      send(res, await reg.handler(record, bridge));
      return;
    }

    send(res, defaultRoute(record));
  }

  function defaultRoute(req: FakeRequest): FakeResponse {
    const { method, path } = req;
    const idMatch = /^\/v1\/(notes|transcriptions)\/(\d+)(\/audio)?$/.exec(path);

    if (method === 'GET' && path === '/v1/health') return { status: 200, json: { data: state.health } };
    if (method === 'GET' && path === '/v1/notes/list') {
      let rows = state.notes;
      if (req.query.note_type) rows = rows.filter((n) => n.note_type === req.query.note_type);
      if (req.query.folder_id !== undefined) {
        rows = rows.filter((n) => String(n.folder_id) === req.query.folder_id);
      }
      const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
      return { status: 200, json: LIST_ENVELOPE(rows.slice(0, limit)) };
    }
    if (method === 'GET' && path === '/v1/notes/search') {
      const rows = state.searchResults ?? state.notes;
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      return { status: 200, json: LIST_ENVELOPE(rows.slice(0, limit)) };
    }
    if (method === 'POST' && path === '/v1/notes/create') {
      const payload = body(req);
      const note = { id: state.notes.length + 1, ...payload };
      state.notes.unshift(note);
      return { status: 201, json: { data: note } };
    }
    if (method === 'GET' && path === '/v1/folders/list') {
      return { status: 200, json: LIST_ENVELOPE(state.folders) };
    }
    if (method === 'POST' && path === '/v1/folders/create') {
      const payload = body(req) as { name?: string };
      const folder = { id: state.folders.length + 1, name: payload.name };
      state.folders.push(folder);
      return { status: 201, json: { data: folder } };
    }
    if (method === 'GET' && path === '/v1/dictionary/list') {
      return { status: 200, json: { data: state.dictionary } };
    }
    if (method === 'POST' && path === '/v1/dictionary/update') {
      return { status: 200, json: { data: state.dictionary } };
    }
    if (method === 'GET' && path === '/v1/transcriptions/list') {
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      return { status: 200, json: LIST_ENVELOPE(state.transcriptions.slice(0, limit)) };
    }
    if (idMatch) {
      const [, kind, rawId, audio] = idMatch;
      const rows = kind === 'notes' ? state.notes : state.transcriptions;
      const row = rows.find((r) => String(r.id) === rawId);
      if (method === 'GET') {
        return row
          ? { status: 200, json: { data: row } }
          : { status: 404, json: errorBody('not_found', 'Not found') };
      }
      if (method === 'PATCH' && kind === 'notes') {
        if (!row) return { status: 404, json: errorBody('not_found', 'Not found') };
        Object.assign(row, body(req));
        return { status: 200, json: { data: { success: true } } };
      }
      if (method === 'DELETE') {
        if (!audio) {
          const index = rows.findIndex((r) => String(r.id) === rawId);
          if (index >= 0) rows.splice(index, 1);
        }
        return { status: 204 };
      }
    }
    return { status: 404, json: errorBody('not_found', `No route for ${method} ${path}`) };
  }

  function body(req: FakeRequest): Record<string, unknown> {
    if (!req.body) return {};
    try {
      return JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  await listen();
  if (options.writeConfig !== false) await bridge.writeConfig();
  return bridge;
}
