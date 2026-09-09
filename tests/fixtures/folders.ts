import type { RawFolder } from '../../src/bridge/types.js';

/** FROZEN: build variants with `makeFolder({...})`. */
export function makeFolder(overrides: Partial<RawFolder> = {}): RawFolder {
  const id = overrides.id ?? 1;
  return {
    id,
    name: `Folder ${id}`,
    is_default: 0,
    sort_order: id,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    client_folder_id: `cf-${id}`,
    cloud_id: `cloud-folder-${id}`,
    sync_status: 'synced',
    deleted_at: null,
    space_id: null,
    account_id: 42,
    left_team: 0,
    ...overrides,
  };
}

/** The three folders a stock install ships with. */
export const DEFAULT_FOLDERS: RawFolder[] = [
  makeFolder({ id: 1, name: 'Personal', is_default: 1, sort_order: 0 }),
  makeFolder({ id: 2, name: 'Meetings', is_default: 1, sort_order: 1 }),
  makeFolder({ id: 3, name: 'Videos', is_default: 0, sort_order: 2 }),
];
