import { describe, expect, it } from 'vitest';
import { OpenWhisprError } from '../../../src/bridge/errors.js';
import {
  decodeCursor,
  encodeCursor,
  fingerprintDrift,
  fingerprintFilters,
  newSnapshotId,
  sliceSnapshot,
  type NoteSnapshot,
} from '../../../src/domain/snapshot.js';
import { toNoteSummary, type NoteSummary } from '../../../src/domain/projections.js';
import { makeNote, resetNoteIds } from '../../fixtures/notes.js';

function summaries(count: number): NoteSummary[] {
  resetNoteIds(1);
  return Array.from({ length: count }, () => toNoteSummary(makeNote(), null));
}

function snapshot(rows: NoteSummary[], overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    id: 'snap-1',
    fingerprint: fingerprintFilters({}),
    createdAt: 1_757_000_000_000,
    rows,
    saturated: false,
    folderNamesUnavailable: false,
    ...overrides,
  };
}

/** `decodeCursor` only ever rejects with our own typed error. */
function rejection(raw: string): OpenWhisprError {
  try {
    decodeCursor(raw);
  } catch (err) {
    if (err instanceof OpenWhisprError) return err;
    throw new Error(`decodeCursor threw a non-OpenWhisprError: ${String(err)}`);
  }
  throw new Error(`decodeCursor accepted ${JSON.stringify(raw)}`);
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('fingerprintFilters', () => {
  it('is stable regardless of key order', () => {
    expect(fingerprintFilters({ note_type: 'personal', folder_id: 3 })).toBe(
      fingerprintFilters({ folder_id: 3, note_type: 'personal' }),
    );
  });

  it('treats an explicit undefined the same as an absent filter', () => {
    expect(fingerprintFilters({ note_type: undefined, folder_id: undefined })).toBe(
      fingerprintFilters({}),
    );
  });

  it('separates a present filter from an absent one', () => {
    expect(fingerprintFilters({ note_type: 'personal' })).not.toBe(fingerprintFilters({}));
    expect(fingerprintFilters({ folder_id: 1 })).not.toBe(fingerprintFilters({}));
  });

  it('does not let adjacent values run together', () => {
    // A naive concatenation would make {folder_id:3} and {folder_id:30} collide
    // with a neighbouring field.
    expect(fingerprintFilters({ folder_id: 3 })).not.toBe(fingerprintFilters({ folder_id: 30 }));
    expect(fingerprintFilters({ note_type: 'personal', folder_id: 1 })).not.toBe(
      fingerprintFilters({ note_type: 'personal1' }),
    );
  });
});

describe('fingerprintDrift', () => {
  it('reports nothing when the filters are unchanged', () => {
    const same = fingerprintFilters({ note_type: 'personal', folder_id: 3 });
    expect(fingerprintDrift(same, same)).toEqual([]);
  });

  it('names the field that changed and both values', () => {
    expect(
      fingerprintDrift(fingerprintFilters({ note_type: 'personal' }), fingerprintFilters({ note_type: 'meeting' })),
    ).toEqual([{ field: 'note_type', snapshot: 'personal', current: 'meeting' }]);
  });

  it('reports a filter that was dropped and one that was added', () => {
    expect(
      fingerprintDrift(fingerprintFilters({ note_type: 'personal' }), fingerprintFilters({ folder_id: 2 })),
    ).toEqual([
      { field: 'note_type', snapshot: 'personal', current: null },
      { field: 'folder_id', snapshot: null, current: '2' },
    ]);
  });
});

describe('cursors', () => {
  it('round-trips through base64url', () => {
    const encoded = encodeCursor({ v: 1, s: 'abc-DEF_123', i: 40 });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual({ v: 1, s: 'abc-DEF_123', i: 40 });
  });

  it('generates a fresh snapshot id every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSnapshotId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['an empty string', ''],
    ['random text', 'not-a-cursor'],
    ['valid base64url that is not JSON', Buffer.from('nonsense', 'utf8').toString('base64url')],
    ['a JSON array', b64url([1, 2, 3])],
    ['a JSON string', b64url('hello')],
    ['a future cursor version', b64url({ v: 2, s: 'abc', i: 0 })],
    ['a missing snapshot id', b64url({ v: 1, s: '', i: 0 })],
    ['a negative offset', b64url({ v: 1, s: 'abc', i: -1 })],
    ['a fractional offset', b64url({ v: 1, s: 'abc', i: 1.5 })],
    ['an offset of the wrong type', b64url({ v: 1, s: 'abc', i: '3' })],
  ])('rejects %s as invalid_argument', (_label, raw) => {
    const error = rejection(raw);
    expect(error.kind).toBe('invalid_argument');
    expect(error.message).toMatch(/cursor/i);
    expect(error.hint).toBeTruthy();
  });
});

describe('sliceSnapshot', () => {
  it('cuts consecutive pages that neither duplicate nor skip a row', () => {
    const snap = snapshot(summaries(5));

    const first = sliceSnapshot(snap, 0, 2);
    expect(first.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(first.nextIndex).toBe(2);

    const second = sliceSnapshot(snap, first.nextIndex!, 2);
    expect(second.rows.map((r) => r.id)).toEqual([3, 4]);
    expect(second.nextIndex).toBe(4);

    const third = sliceSnapshot(snap, second.nextIndex!, 2);
    expect(third.rows.map((r) => r.id)).toEqual([5]);
    expect(third.nextIndex).toBeNull();
  });

  it('reports no next index when the page ends exactly on the last row', () => {
    const snap = snapshot(summaries(4));
    expect(sliceSnapshot(snap, 2, 2).nextIndex).toBeNull();
  });

  it('returns the whole snapshot when the page is larger than it', () => {
    const snap = snapshot(summaries(3));
    const page = sliceSnapshot(snap, 0, 100);
    expect(page.rows).toHaveLength(3);
    expect(page.nextIndex).toBeNull();
  });

  it('answers an empty snapshot with an empty page', () => {
    const page = sliceSnapshot(snapshot([]), 0, 20);
    expect(page.rows).toEqual([]);
    expect(page.nextIndex).toBeNull();
  });

  it('clamps an offset past the end instead of producing a negative slice', () => {
    const page = sliceSnapshot(snapshot(summaries(3)), 99, 20);
    expect(page.rows).toEqual([]);
    expect(page.nextIndex).toBeNull();
  });

  it('never issues a next index past the snapshot, even when it is saturated', () => {
    const snap = snapshot(summaries(4), { saturated: true });
    expect(sliceSnapshot(snap, 2, 2).nextIndex).toBeNull();
  });
});
