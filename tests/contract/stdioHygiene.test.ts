import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * stdout is the MCP transport. A single stray `console.log` anywhere in `src/`
 * injects a non-JSON-RPC line and kills the session — so this is checked twice:
 * statically over the sources, and dynamically over a real child process.
 */
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('stdio hygiene', () => {
  it('has no console.* call anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        // Skip comment lines: log.ts documents the hazard in prose.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\bconsole\.\w+\s*\(/.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('writes nothing but JSON-RPC frames to stdout', async () => {
    const entry = join(ROOT, 'dist', 'index.js');
    if (!existsSync(entry)) throw new Error('run `npm run build` before this test');

    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Point at a handshake file that cannot exist, so the server must still
      // boot cleanly and report the failure per-call rather than on stdout.
      env: { ...process.env, OPENWHISPR_BRIDGE_CONFIG: '/nonexistent/cli-bridge.json' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    const send = (payload: unknown): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hygiene', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    // A call that is guaranteed to fail: the failure must not reach stdout as prose.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } });

    await new Promise<void>((done) => {
      const deadline = setTimeout(finish, 6000);
      const check = (): void => {
        if (stdout.split('\n').filter(Boolean).length >= 3) finish();
      };
      function finish(): void {
        clearTimeout(deadline);
        child.stdout.off('data', check);
        child.kill('SIGTERM');
        done();
      }
      child.stdout.on('data', check);
    });

    const lines = stdout.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc, line).toBe('2.0');
    }

    // The diagnostics the server does emit belong on stderr, tagged and token-free.
    expect(stderr).toContain('[openwhispr-mcp]');
    expect(stderr).not.toMatch(/Bearer/i);
  }, 20_000);
});
