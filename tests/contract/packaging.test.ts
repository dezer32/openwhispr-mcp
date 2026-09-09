import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION } from '../../src/server.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface PackageJson {
  version?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  scripts?: Record<string, string>;
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
}

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

const pkg = JSON.parse(read('package.json')) as PackageJson;

describe('packaging', () => {
  it('builds before testing, so `npm install && npm test` works on a fresh clone', () => {
    // `dist/` is gitignored and the stdout-hygiene test spawns `dist/index.js`.
    expect(pkg.scripts?.pretest).toBe('npm run build');
  });

  it('asks for the Node version AbortSignal.any actually needs', () => {
    // Every bridge call combines the session signal with a per-request timeout;
    // on 20.0-20.2 that throws on the first call, so `>=20` was a false promise.
    expect(read('src/bridge/httpClient.ts')).toContain('AbortSignal.any');
    expect(read('src/bridge/session.ts')).toContain('AbortSignal.any');
    expect(pkg.engines?.node).toBe('>=20.3.0');
  });

  it('states the same floor in the README', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/Node\.js 20\.3\+/);
    expect(readme).not.toMatch(/Node\.js 20\+/);
  });
});

describe('npx installability', () => {
  it('exposes one bin under the package name', () => {
    // `npx openwhispr-mcp` resolves the bin whose name matches the package.
    expect(pkg.bin).toEqual({ 'openwhispr-mcp': 'dist/index.js' });
  });

  it('ships the built server in the tarball', () => {
    // `files` is an allowlist and outranks `.gitignore`, which hides `dist/`.
    expect(pkg.files).toContain('dist');
  });

  it('builds on install and on publish, because dist/ is not in git', () => {
    // `prepare` covers both paths npx can take: a published tarball (it runs
    // before packing) and `npx github:owner/repo` (it runs after the clone).
    expect(pkg.scripts?.prepare).toBe('npm run build');
  });

  it('refuses to publish without a typecheck and a green suite', () => {
    const gate = pkg.scripts?.prepublishOnly ?? '';
    expect(gate).toContain('npm run typecheck');
    expect(gate).toContain('npm test');
  });

  it('points at its repository, so the npm page is not a dead end', () => {
    expect(pkg.repository?.url).toContain('github.com/dezer32/openwhispr-mcp');
    expect(pkg.homepage).toContain('github.com/dezer32/openwhispr-mcp');
    expect(pkg.bugs?.url).toContain('github.com/dezer32/openwhispr-mcp/issues');
  });

  it('carries the licence text it claims', () => {
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true);
    expect(read('LICENSE')).toContain('MIT');
  });

  it('reports one version, not two', () => {
    // A published package bumps `package.json`; clients read `SERVER_VERSION`.
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('tells the reader to run it with npx', () => {
    expect(read('README.md')).toContain('npx -y openwhispr-mcp');
  });
});

describe('cli entrypoint', () => {
  const entry = join(ROOT, 'dist', 'index.js');

  it('is executable and self-launching', () => {
    if (!existsSync(entry)) throw new Error('run `npm run build` before this test');
    expect(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
    expect(statSync(entry).mode & 0o111).not.toBe(0);
  });

  it('answers --version and exits instead of waiting on stdin', () => {
    // Without this, `npx openwhispr-mcp` looks like a hang: the server boots
    // silently and blocks on a stdio transport nobody is speaking to.
    const out = execFileSync(process.execPath, [entry, '--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out.trim()).toBe(`openwhispr-mcp ${pkg.version ?? ''}`);
  });

  it('answers --help with the environment it reads', () => {
    const out = execFileSync(process.execPath, [entry, '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('OPENWHISPR_BRIDGE_CONFIG');
    expect(out).toContain('stdio');
  });
});
