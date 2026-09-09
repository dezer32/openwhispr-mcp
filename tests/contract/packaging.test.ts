import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface PackageJson {
  engines?: { node?: string };
  scripts?: Record<string, string>;
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
