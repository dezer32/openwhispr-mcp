import type { SnapshotStore } from '../deps.js';

export interface TtlStoreOptions {
  ttlMs: number;
  maxEntries: number;
  now: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Small TTL + insertion-order LRU. Deliberately generic: `domain/snapshot.ts`
 * owns the meaning of the keys and values.
 */
export function createTtlStore<V>(options: TtlStoreOptions): SnapshotStore<V> {
  const entries = new Map<string, Entry<V>>();

  function purge(): void {
    const now = options.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= options.now()) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency without extending the TTL.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    put(key, value) {
      purge();
      entries.delete(key);
      entries.set(key, { value, expiresAt: options.now() + options.ttlMs });
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      purge();
      return entries.size;
    },
  };
}
