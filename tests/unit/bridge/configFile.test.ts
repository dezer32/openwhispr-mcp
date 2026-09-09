import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBridgeConfig } from '../../../src/bridge/configFile.js';
import { BridgeConfigError } from '../../../src/bridge/errors.js';
import { BRIDGE_HOST } from '../../../src/config.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openwhispr-handshake-'));
  path = join(dir, 'cli-bridge.json');
});

afterEach(async () => {
  await chmod(path, 0o600).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function write(contents: unknown): Promise<void> {
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
  await writeFile(path, text, 'utf8');
  await chmod(path, 0o600);
}

async function rejection(promise: Promise<unknown>): Promise<BridgeConfigError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeConfigError);
    return err as BridgeConfigError;
  }
  throw new Error('expected the handshake read to reject');
}

const isRoot = process.getuid?.() === 0;

describe('readBridgeConfig', () => {
  it('returns host, port, token and the source path for a valid file', async () => {
    const token = randomBytes(32).toString('hex');
    await write({ host: '127.0.0.1', port: 8203, token, pid: 4242 });
    await expect(readBridgeConfig(path)).resolves.toEqual({
      host: '127.0.0.1',
      port: 8203,
      token,
      path,
    });
  });

  it('defaults the host to the loopback address when the field is absent', async () => {
    await write({ port: 8200, token: randomBytes(32).toString('hex') });
    const handshake = await readBridgeConfig(path);
    expect(handshake.host).toBe(BRIDGE_HOST);
  });

  it('accepts an ephemeral port outside the documented 8200-8219 window', async () => {
    await write({ port: 51234, token: randomBytes(32).toString('hex') });
    await expect(readBridgeConfig(path)).resolves.toMatchObject({ port: 51234 });
  });

  it('reports bridge_not_running when the file does not exist', async () => {
    const err = await rejection(readBridgeConfig(join(dir, 'absent.json')));
    expect(err.kind).toBe('bridge_not_running');
    expect(err.hint).toMatch(/OpenWhispr/);
  });

  it.skipIf(isRoot)('reports config_unreadable when the file cannot be opened', async () => {
    await write({ port: 8200, token: randomBytes(32).toString('hex') });
    await chmod(path, 0o000);
    const err = await rejection(readBridgeConfig(path));
    expect(err.kind).toBe('config_unreadable');
  });

  it('reports config_invalid for a file that is not JSON', async () => {
    await write('{not json at all');
    expect((await rejection(readBridgeConfig(path))).kind).toBe('config_invalid');
  });

  it('reports config_invalid when the payload is not an object', async () => {
    await write('[1,2,3]');
    expect((await rejection(readBridgeConfig(path))).kind).toBe('config_invalid');
  });

  it.each([
    ['missing', {}],
    ['a string', { port: '8200' }],
    ['fractional', { port: 8200.5 }],
    ['zero', { port: 0 }],
    ['above 65535', { port: 70000 }],
  ])('reports config_invalid when the port is %s', async (_label, patch) => {
    await write({ token: randomBytes(32).toString('hex'), ...patch });
    expect((await rejection(readBridgeConfig(path))).kind).toBe('config_invalid');
  });

  it.each([
    ['missing', {}],
    ['empty', { token: '' }],
    ['blank', { token: '   ' }],
    ['not a string', { token: 12345 }],
  ])('reports config_invalid when the token is %s', async (_label, patch) => {
    await write({ port: 8200, ...patch });
    expect((await rejection(readBridgeConfig(path))).kind).toBe('config_invalid');
  });

  it('rejects a handshake that points anywhere but loopback', async () => {
    await write({ host: '10.0.0.7', port: 8200, token: randomBytes(32).toString('hex') });
    const err = await rejection(readBridgeConfig(path));
    expect(err.kind).toBe('config_invalid');
    expect(err.message).toMatch(/loopback|host/i);
  });

  it('never leaks the token to stderr or into a thrown error', async () => {
    const token = randomBytes(32).toString('hex');
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const previousDebug = process.env.OPENWHISPR_MCP_DEBUG;
    process.env.OPENWHISPR_MCP_DEBUG = '1';
    let err: BridgeConfigError;
    try {
      await write({ host: '127.0.0.1', port: 8200, token });
      await readBridgeConfig(path);
      await write({ host: '127.0.0.1', port: -1, token });
      err = await rejection(readBridgeConfig(path));
    } finally {
      spy.mockRestore();
      if (previousDebug === undefined) delete process.env.OPENWHISPR_MCP_DEBUG;
      else process.env.OPENWHISPR_MCP_DEBUG = previousDebug;
    }
    const stderr = written.join('');
    expect(stderr).not.toBe('');
    for (const needle of [token, token.slice(0, 16)]) {
      expect(stderr).not.toContain(needle);
      expect(err.message).not.toContain(needle);
      expect(JSON.stringify(err.toPayload())).not.toContain(needle);
    }
  });
});
