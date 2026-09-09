import type { RawFolder } from '../bridge/types.js';
import type { BridgeRoutes } from '../deps.js';
import { logWarn } from '../log.js';
import { toFolder, type FolderView } from './projections.js';

/**
 * Note rows carry `folder_id` but not the folder name, and the bridge has no
 * per-folder route — the only way to name a folder is to list them all. One
 * index per tool call turns "N notes" into exactly one extra request.
 */
export interface FolderIndex {
  nameOf(folderId: number | null | undefined): Promise<string | null>;
  all(): Promise<FolderView[]>;
  /**
   * True once a `nameOf` lookup gave up. Without it a `folder_name: null` from a
   * failed listing is indistinguishable from "this note is in no folder", and
   * the difference only exists on stderr, where no agent looks.
   */
  readonly namesUnavailable: boolean;
}

export const FOLDER_NAMES_UNAVAILABLE_NOTE =
  'The folder list could not be read during this call, so folder_name is null on every row here even where folder_id is set — that is a failed lookup, not an absent folder. Trust folder_id and call list_folders to see whether the list reads again.';

export function createFolderIndex(routes: BridgeRoutes): FolderIndex {
  let pending: Promise<RawFolder[]> | undefined;
  let names: Map<number, string> | undefined;
  let resolutionFailed = false;

  function load(): Promise<RawFolder[]> {
    // Racing callers await the same promise, so they cannot fan out into
    // parallel requests for the same list.
    pending ??= routes.listFolders();
    return pending;
  }

  async function nameMap(): Promise<Map<number, string> | null> {
    if (names) return names;
    if (resolutionFailed) return null;

    try {
      const rows = await load();
      const map = new Map<number, string>();
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = typeof row?.name === 'string' ? row.name.trim() : '';
        if (typeof row?.id === 'number' && name !== '') map.set(row.id, name);
      }
      names = map;
      return map;
    } catch (error) {
      // A folder name is decoration on top of the caller's real answer, so a
      // failure here degrades to `null` instead of failing the whole tool call.
      // One attempt only: the next note in the same batch would fail the same way.
      resolutionFailed = true;
      logWarn('folder name resolution failed, folder_name will be null', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return {
    get namesUnavailable() {
      return resolutionFailed;
    },
    async nameOf(folderId) {
      if (folderId === null || folderId === undefined) return null;
      const map = await nameMap();
      return map?.get(folderId) ?? null;
    },
    /** Unlike `nameOf`, this is the caller's actual goal, so failures propagate. */
    async all() {
      const rows = await load();
      return (Array.isArray(rows) ? rows : []).map((row) => toFolder(row));
    },
  };
}
