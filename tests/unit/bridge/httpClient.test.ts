import { afterEach, describe, expect, it } from 'vitest';
import { bridgeRequest, type HttpClientOptions } from '../../../src/bridge/httpClient.js';
import { BridgeHttpError, BridgeTransportError } from '../../../src/bridge/errors.js';
import { DEFAULT_MAX_RESPONSE_BYTES, MAX_REQUEST_BYTES } from '../../../src/config.js';
import { startFakeBridge, type FakeBridge } from '../../helpers/fakeBridge.js';
import { makeNote } from '../../fixtures/notes.js';

let bridge: FakeBridge | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

function options(b: FakeBridge, overrides: Partial<HttpClientOptions> = {}): HttpClientOptions {
  return {
    host: b.host,
    port: b.port,
    token: b.token,
    timeoutMs: 5_000,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    ...overrides,
  };
}

async function transportError(promise: Promise<unknown>): Promise<BridgeTransportError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeTransportError);
    return err as BridgeTransportError;
  }
  throw new Error('expected the request to reject');
}

describe('bridgeRequest', () => {
  it('sends the bearer token and asks for JSON', async () => {
    bridge = await startFakeBridge();
    await bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge));
    const seen = bridge.requests.at(-1);
    expect(seen?.authorization).toBe(`Bearer ${bridge.token}`);
    expect(seen?.headers.accept).toBe('application/json');
  });

  it('unwraps the {data} envelope', async () => {
    bridge = await startFakeBridge({ state: { health: { status: 'ok', version: '1.9.2' } } });
    const health = await bridgeRequest<{ status: string }>(
      { method: 'GET', path: '/v1/health' },
      options(bridge),
    );
    expect(health).toEqual({ status: 'ok', version: '1.9.2' });
  });

  it('returns the whole body when the bridge sends no {data} envelope', async () => {
    bridge = await startFakeBridge();
    bridge.on('GET', '/v1/health', () => ({ status: 200, json: { status: 'ok' } }));
    await expect(
      bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge)),
    ).resolves.toEqual({ status: 'ok' });
  });

  it('drops undefined query values instead of serialising them', async () => {
    bridge = await startFakeBridge();
    await bridgeRequest(
      {
        method: 'GET',
        path: '/v1/notes/list',
        query: { note_type: undefined, limit: 25, folder_id: undefined, flag: false },
      },
      options(bridge),
    );
    const seen = bridge.requests.at(-1);
    expect(seen?.query).toEqual({ limit: '25', flag: 'false' });
    expect(JSON.stringify(seen?.query)).not.toContain('undefined');
  });

  it('sends a JSON body with a content-type header', async () => {
    bridge = await startFakeBridge();
    await bridgeRequest(
      { method: 'POST', path: '/v1/notes/create', body: { title: 'hi' }, mutating: true },
      options(bridge),
    );
    const seen = bridge.requests.at(-1);
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen?.body ?? '')).toEqual({ title: 'hi' });
  });

  it('resolves a 204 to undefined without parsing a body', async () => {
    bridge = await startFakeBridge({ state: { notes: [makeNote({ id: 7 })] } });
    const result = await bridgeRequest(
      { method: 'DELETE', path: '/v1/notes/7', mutating: true },
      options(bridge),
    );
    expect(result).toBeUndefined();
    expect(bridge.requests.at(-1)?.method).toBe('DELETE');
  });

  it('rejects an oversized request body before touching the network', async () => {
    bridge = await startFakeBridge();
    const err = await transportError(
      bridgeRequest(
        { method: 'POST', path: '/v1/notes/create', body: { content: 'x'.repeat(2_000) } },
        options(bridge, { maxRequestBytes: 512 }),
      ),
    );
    expect(err.kind).toBe('request_too_large');
    expect(bridge.requests).toHaveLength(0);
  });

  it('aborts a response that exceeds the byte budget', async () => {
    bridge = await startFakeBridge();
    bridge.on('GET', '/v1/notes/list', () => ({
      status: 200,
      raw: JSON.stringify({ data: [{ id: 1, content: 'x'.repeat(50_000) }] }),
    }));
    const err = await transportError(
      bridgeRequest({ method: 'GET', path: '/v1/notes/list' }, options(bridge, { maxResponseBytes: 100 })),
    );
    expect(err.kind).toBe('response_too_large');
    expect(err.hint).toBe(
      'Ask for fewer rows (lower `limit`) or raise OPENWHISPR_MCP_MAX_RESPONSE_BYTES.',
    );
    expect(err.hint).not.toMatch(/may well have been applied/i);
  });

  it('does not tell a mutation whose answer was too large to ask for fewer rows', async () => {
    bridge = await startFakeBridge();
    bridge.on('POST', '/v1/notes/create', () => ({
      status: 201,
      raw: JSON.stringify({ data: { id: 1, content: 'x'.repeat(50_000) } }),
    }));
    const err = await transportError(
      bridgeRequest(
        { method: 'POST', path: '/v1/notes/create', body: { title: 'x' }, mutating: true },
        options(bridge, { maxResponseBytes: 100 }),
      ),
    );

    expect(err.kind).toBe('response_too_large');
    // The write went through — only its answer was cut off — so "ask for fewer
    // rows" would be advice to write the note a second time.
    expect(err.hint).toMatch(/the app did answer it/i);
    expect(err.hint).toMatch(/may well have been applied/i);
    expect(err.hint).toMatch(/do not repeat it blindly/i);
    expect(err.hint).toMatch(/list_notes/);
    expect(err.hint).not.toMatch(/fewer rows/i);
    expect(err.hint).toMatch(/OPENWHISPR_MCP_MAX_RESPONSE_BYTES/);
    // The bridge saw the write exactly once; the retry the old hint invited is
    // what would have made it twice.
    expect(bridge.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('maps a stalled bridge to timeout', async () => {
    bridge = await startFakeBridge();
    bridge.fault('hang');
    const err = await transportError(
      bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge, { timeoutMs: 100 })),
    );
    expect(err.kind).toBe('timeout');
  });

  it('tells a timed-out mutation it may already have been applied', async () => {
    bridge = await startFakeBridge();
    bridge.fault('hang');
    const err = await transportError(
      bridgeRequest(
        { method: 'POST', path: '/v1/notes/create', body: { title: 'x' }, mutating: true },
        options(bridge, { timeoutMs: 100 }),
      ),
    );
    expect(err.kind).toBe('timeout');
    // The failure mode this guards: a committed POST whose answer was lost, then
    // retried on advice, leaving the user with two identical notes.
    expect(err.hint).toMatch(/may already have been applied/i);
    expect(err.hint).toMatch(/do not repeat it blindly/i);
    expect(err.hint).toMatch(/list_notes/);
  });

  it('still tells a timed-out read to just retry', async () => {
    bridge = await startFakeBridge();
    bridge.fault('hang');
    const err = await transportError(
      bridgeRequest({ method: 'GET', path: '/v1/notes/list' }, options(bridge, { timeoutMs: 100 })),
    );
    expect(err.kind).toBe('timeout');
    expect(err.hint).toBe('The app may be busy; retry, or raise OPENWHISPR_MCP_TIMEOUT_MS.');
    expect(err.hint).not.toMatch(/already have been applied/i);
  });

  it('tells a mutation that lost its socket it may already have been applied', async () => {
    bridge = await startFakeBridge();
    bridge.fault('closeSocket');
    const err = await transportError(
      bridgeRequest(
        { method: 'POST', path: '/v1/notes/create', body: { title: 'x' }, mutating: true },
        options(bridge),
      ),
    );
    expect(err.kind).toBe('bridge_unreachable');
    expect(err.hint).toMatch(/may already have been applied/i);
    expect(err.hint).toMatch(/do not repeat it blindly/i);
  });

  it('still tells an unreachable read to restart the app and retry', async () => {
    bridge = await startFakeBridge();
    bridge.fault('closeSocket');
    const err = await transportError(
      bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge)),
    );
    expect(err.kind).toBe('bridge_unreachable');
    expect(err.hint).toBe(
      'The handshake file is stale or the app stopped: restart OpenWhispr and retry.',
    );
    expect(err.hint).not.toMatch(/already have been applied/i);
  });

  it('warns a cancelled mutation too, and leaves a cancelled read without a hint', async () => {
    bridge = await startFakeBridge();
    bridge.fault('hang');

    const abortAfter = (ms: number): AbortSignal => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    };

    const write = await transportError(
      bridgeRequest(
        { method: 'DELETE', path: '/v1/notes/7', mutating: true },
        options(bridge, { timeoutMs: 5_000, signal: abortAfter(30) }),
      ),
    );
    expect(write.kind).toBe('cancelled');
    expect(write.hint).toMatch(/may already have been applied/i);

    const read = await transportError(
      bridgeRequest(
        { method: 'GET', path: '/v1/health' },
        options(bridge, { timeoutMs: 5_000, signal: abortAfter(30) }),
      ),
    );
    expect(read.kind).toBe('cancelled');
    expect(read.hint).toBeUndefined();
  });

  it('maps an external abort to cancelled', async () => {
    bridge = await startFakeBridge();
    bridge.fault('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const err = await transportError(
      bridgeRequest(
        { method: 'GET', path: '/v1/health' },
        options(bridge, { timeoutMs: 5_000, signal: controller.signal }),
      ),
    );
    expect(err.kind).toBe('cancelled');
  });

  it('maps a refused connection to bridge_unreachable', async () => {
    bridge = await startFakeBridge();
    const stale = options(bridge);
    await bridge.close();
    bridge = undefined;
    const err = await transportError(bridgeRequest({ method: 'GET', path: '/v1/health' }, stale));
    expect(err.kind).toBe('bridge_unreachable');
    expect(err.hint).toMatch(/restart/i);
  });

  it('maps a dropped socket to bridge_unreachable', async () => {
    bridge = await startFakeBridge();
    bridge.fault('closeSocket');
    const err = await transportError(
      bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge)),
    );
    expect(err.kind).toBe('bridge_unreachable');
  });

  it('maps a non-JSON 200 to upstream_protocol', async () => {
    bridge = await startFakeBridge();
    bridge.fault('nonJson');
    const err = await transportError(
      bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge)),
    );
    expect(err.kind).toBe('upstream_protocol');
  });

  it('turns a 404 envelope into a BridgeHttpError', async () => {
    bridge = await startFakeBridge();
    let caught: unknown;
    try {
      await bridgeRequest({ method: 'GET', path: '/v1/notes/999' }, options(bridge));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgeHttpError);
    const err = caught as BridgeHttpError;
    expect(err.kind).toBe('not_found');
    expect(err.status).toBe(404);
    expect(err.upstreamCode).toBe('not_found');
    expect(err.upstreamMessage).toBe('Not found');
  });

  it('maps 401/403/400/500 onto the shared taxonomy', async () => {
    bridge = await startFakeBridge();
    const cases: Array<[number, string]> = [
      [400, 'invalid_argument'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [500, 'upstream_error'],
    ];
    for (const [status, kind] of cases) {
      bridge.fault({ status, body: { error: { code: 'x', message: 'boom' } } });
      await expect(
        bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge)),
      ).rejects.toMatchObject({ kind, status });
    }
  });

  it('keeps the raw upstream text out of message, which is always shown to the agent', async () => {
    bridge = await startFakeBridge();
    const leak = 'near "SELECT": syntax error at /Users/me/Library/transcriptions.db';
    const cases: Array<[string, unknown, string | undefined]> = [
      ['envelope', { error: { code: 'internal_error', message: leak } }, 'internal_error'],
      ['bare text', undefined, undefined],
    ];
    for (const [, body, expectedCode] of cases) {
      bridge.fault(body === undefined ? { status: 500, raw: leak } : { status: 500, body });
      let caught: unknown;
      try {
        await bridgeRequest({ method: 'GET', path: '/v1/notes/list' }, options(bridge));
      } catch (err) {
        caught = err;
      }
      const err = caught as BridgeHttpError;
      expect(err).toBeInstanceOf(BridgeHttpError);
      expect(err.message).toBe('bridge returned HTTP 500');
      expect(err.message).not.toContain('SELECT');
      expect(err.message).not.toContain('/Users/');
      expect(err.upstreamMessage).toBe(leak);
      expect(err.upstreamCode).toBe(expectedCode);
      expect(JSON.stringify(err.toPayload())).not.toContain('SELECT');
    }
  });

  it('keeps a non-JSON error body as a truncated upstream message', async () => {
    bridge = await startFakeBridge();
    bridge.fault({ status: 500, raw: 'Error: datatype mismatch\n'.repeat(100) });
    let caught: unknown;
    try {
      await bridgeRequest({ method: 'GET', path: '/v1/health' }, options(bridge));
    } catch (err) {
      caught = err;
    }
    const err = caught as BridgeHttpError;
    expect(err).toBeInstanceOf(BridgeHttpError);
    expect(err.upstreamCode).toBeUndefined();
    expect(err.upstreamMessage).toContain('datatype mismatch');
    expect((err.upstreamMessage ?? '').length).toBeLessThanOrEqual(220);
  });
});
