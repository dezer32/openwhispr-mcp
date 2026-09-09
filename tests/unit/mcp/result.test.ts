import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult, jsonResult } from '../../../src/mcp/result.js';

function text(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') throw new Error('no text block');
  return block.text;
}

function errorPayload(result: CallToolResult): Record<string, unknown> {
  return (JSON.parse(text(result)) as { error: Record<string, unknown> }).error;
}

describe('jsonResult', () => {
  it('returns a single pretty-printed JSON text block', () => {
    const result = jsonResult({ ok: true, items: [1, 2] });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(text(result))).toEqual({ ok: true, items: [1, 2] });
    expect(text(result)).toContain('\n');
  });

  it('never caps when no maxChars is given', () => {
    const result = jsonResult({ blob: 'x'.repeat(10_000) });
    expect(result.isError).toBeFalsy();
  });

  it('accepts a payload exactly at the cap and rejects one character more', () => {
    const value = { blob: 'x'.repeat(100) };
    const size = JSON.stringify(value, null, 2).length;

    expect(jsonResult(value, { maxChars: size }).isError).toBeFalsy();

    const over = jsonResult(value, { maxChars: size - 1 });
    expect(over.isError).toBe(true);
    const payload = errorPayload(over);
    expect(payload.kind).toBe('response_too_large');
    expect(String(payload.hint)).toMatch(/limit|page_size/i);
    expect(payload.details).toMatchObject({ result_chars: size, max_result_chars: size - 1 });
  });

  it('reports a circular value as internal_bug instead of throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    const result = jsonResult(circular);
    expect(result.isError).toBe(true);
    expect(errorPayload(result).kind).toBe('internal_bug');
  });
});

describe('errorResult', () => {
  it('marks the result as an error and wraps the payload in {error}', () => {
    const result = errorResult({
      kind: 'not_found',
      message: 'note 7 does not exist',
      hint: 'Call list_notes first.',
      details: { note_id: 7 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual({
      error: {
        kind: 'not_found',
        message: 'note 7 does not exist',
        hint: 'Call list_notes first.',
        details: { note_id: 7 },
      },
    });
  });

  it('omits absent hint and details', () => {
    const result = errorResult({ kind: 'timeout', message: 'took too long' });
    expect(JSON.parse(text(result))).toEqual({ error: { kind: 'timeout', message: 'took too long' } });
  });

  it('falls back to kind and message when details are not serialisable', () => {
    const details: Record<string, unknown> = {};
    details.self = details;

    const result = errorResult({ kind: 'upstream_error', message: 'boom', details });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual({ error: { kind: 'upstream_error', message: 'boom' } });
  });
});
