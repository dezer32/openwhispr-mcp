import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../src/config.js';

/**
 * A declaration nothing references is worse than no declaration: it looks like a
 * contract, so a reader trusts it, while nothing keeps it in step with the app.
 */
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SRC = join(ROOT, 'src');
const TYPES = join(SRC, 'bridge', 'types.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('module surface', () => {
  it('no longer exports a port range nothing scans', () => {
    // The app scans 8200-8219 but does not promise to stay there, and this
    // server never looked: `configFile.ts` documents that where it matters.
    expect(Object.keys(config)).not.toContain('BRIDGE_PORT_RANGE');
  });

  it('declares no wire type that nothing in src/ reads', () => {
    const source = readFileSync(TYPES, 'utf8');
    const declared = [...source.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(4);

    const rest = walk(SRC)
      .filter((file) => file !== TYPES)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    const orphans = declared.filter((name) => !new RegExp(`\\b${name}\\b`).test(rest));
    expect(orphans).toEqual([]);
  });

  it('keeps the epoch thresholds in exactly one module', () => {
    const offenders = walk(SRC)
      .filter((file) => file !== join(SRC, 'domain', 'dates.ts'))
      .filter((file) => /EPOCH_(?:MS|S)_FLOOR\s*=/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
