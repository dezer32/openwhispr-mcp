import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolError } from '../../bridge/errors.js';
import type { ToolDeps } from '../../deps.js';
import { createFolderIndex, FOLDER_NAMES_UNAVAILABLE_NOTE } from '../../domain/folderIndex.js';
import { toNoteSummary, type NoteSummary } from '../../domain/projections.js';
import {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  fingerprintDrift,
  fingerprintFilters,
  newSnapshotId,
  sliceSnapshot,
  type NoteSnapshot,
  type SnapshotFilters,
} from '../../domain/snapshot.js';
import { listNotesSchema } from '../../schemas/notes.js';
import { defineTool } from '../defineTool.js';

const DESCRIPTION =
  'List notes newest first (by updated_at), filtered by note_type and/or folder_id. ' +
  'Returns summaries only — no note body, no transcript. Pages come from one snapshot: ' +
  'pass next_cursor back verbatim, keeping the same filters. A cursor that outlived its ' +
  'snapshot fails with snapshot_expired; list again without a cursor.';

const SNAPSHOT_NOTE =
  'Pages are cut from a single snapshot taken at snapshot.taken_at, so has_more and next_cursor ' +
  'are exact within it: no note is repeated or skipped while paging. The snapshot is held for a ' +
  'couple of minutes and does not see later edits — re-list without a cursor to refresh it.';

const EXPIRED_HINT =
  'Call list_notes again without a cursor. Only a few snapshots are kept at a time, and each one ' +
  'lives for a couple of minutes, so a cursor cannot be stored and reused later.';

function saturatedNote(cap: number): string {
  return `The upstream API caps a single read at ${cap} rows, so this snapshot holds only the newest ${cap} notes and complete is false; narrow by note_type/folder_id to reach the rest.`;
}

/**
 * A saturated snapshot is exactly when paging is used in anger, so the page
 * semantics must be stated there too — the two notices answer different
 * questions and a ternary between them drops the one that is needed most.
 */
function noticeFor(saturated: boolean, cap: number): string {
  return saturated ? `${SNAPSHOT_NOTE} ${saturatedNote(cap)}` : SNAPSHOT_NOTE;
}

function isNoteSnapshot(value: unknown): value is NoteSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as NoteSnapshot).rows) &&
    typeof (value as NoteSnapshot).fingerprint === 'string'
  );
}

function describeFilterValue(value: string | null): string {
  return value === null ? 'unset' : `"${value}"`;
}

function buildPage(
  snapshot: NoteSnapshot,
  offset: number,
  pageSize: number,
  cap: number,
): Record<string, unknown> {
  const { rows, nextIndex } = sliceSnapshot(snapshot, offset, pageSize);
  return {
    notes: rows,
    page_size: pageSize,
    has_more: nextIndex !== null,
    next_cursor:
      nextIndex === null ? null : encodeCursor({ v: CURSOR_VERSION, s: snapshot.id, i: nextIndex }),
    complete: !snapshot.saturated,
    snapshot: {
      id: snapshot.id,
      taken_at: new Date(snapshot.createdAt).toISOString(),
      total_in_snapshot: snapshot.rows.length,
    },
    notice: noticeFor(snapshot.saturated, cap),
    ...(snapshot.folderNamesUnavailable
      ? { folder_names_unavailable: true, folder_names_note: FOLDER_NAMES_UNAVAILABLE_NOTE }
      : {}),
  };
}

export function registerListNotes(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: 'list_notes',
    title: 'List notes',
    description: DESCRIPTION,
    schema: listNotesSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args, ctx) => {
      const filters: SnapshotFilters = {};
      if (args.note_type !== undefined) filters.note_type = args.note_type;
      if (args.folder_id !== undefined) filters.folder_id = args.folder_id;
      const fingerprint = fingerprintFilters(filters);
      const cap = ctx.deps.config.maxUpstreamLimit;

      if (args.cursor !== undefined) {
        const cursor = decodeCursor(args.cursor);
        const stored = ctx.deps.snapshots.get(cursor.s);
        if (!isNoteSnapshot(stored)) {
          throw new ToolError('snapshot_expired', 'snapshot expired, re-list without a cursor', {
            hint: EXPIRED_HINT,
          });
        }

        const drift = fingerprintDrift(stored.fingerprint, fingerprint);
        if (drift.length > 0) {
          const changed = drift
            .map(
              (entry) =>
                `${entry.field} was ${describeFilterValue(entry.snapshot)}, now ${describeFilterValue(entry.current)}`,
            )
            .join('; ');
          throw new ToolError(
            'invalid_argument',
            `the cursor belongs to a listing made with different filters: ${changed}`,
            {
              hint: 'Repeat the filters the cursor was issued with, or drop the cursor to start a new listing with the new filters.',
              details: { changed_filters: drift.map((entry) => entry.field) },
            },
          );
        }

        // Serving a page costs no request at all: the rows and their folder
        // names were projected when the snapshot was taken.
        return buildPage(stored, cursor.i, args.page_size, cap);
      }

      const snapshot = await ctx.deps.withSession({ signal: ctx.signal }, async (routes) => {
        const folders = createFolderIndex(routes);
        const raw = await routes.listNotes({ ...filters, limit: cap });

        const rows: NoteSummary[] = [];
        for (const note of raw) {
          // Awaiting in sequence is deliberate: the index memoises one shared
          // promise, so this is a single `/v1/folders/list` for the whole page.
          rows.push(toNoteSummary(note, await folders.nameOf(note.folder_id)));
        }

        return {
          id: newSnapshotId(),
          fingerprint,
          createdAt: ctx.deps.now(),
          rows,
          saturated: raw.length >= cap,
          folderNamesUnavailable: folders.namesUnavailable,
        } satisfies NoteSnapshot;
      });

      ctx.deps.snapshots.put(snapshot.id, snapshot);
      return buildPage(snapshot, 0, args.page_size, cap);
    },
  });
}
