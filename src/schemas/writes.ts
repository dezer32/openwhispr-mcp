import { z } from 'zod';

/**
 * Input schemas for every tool that changes data, plus their read-only
 * companions.
 *
 * Each one is registered as-is, so the SDK validates with exactly this object:
 * a second `.strict()` pass inside a handler would be blind, because unknown
 * keys are already gone by then. Everything the bridge would silently ignore is
 * kept out of the schema rather than dropped later — an agent that asks to write
 * `note_type` must be told it cannot, not told it worked.
 */

export const NOTE_TYPES = ['personal', 'meeting', 'upload'] as const;

const noteId = z.number().int().min(1);
const folderId = z.number().int().min(1);

export const createNoteSchema = z
  .object({
    title: z.string().min(1),
    content: z.string().default(''),
    note_type: z.enum(NOTE_TYPES).default('personal'),
    folder_id: folderId.describe('From list_folders. Omit to let the app choose its default folder.').optional(),
    source_file: z.string().min(1).optional(),
    audio_duration_seconds: z.number().min(0).describe('Seconds, not milliseconds.').optional(),
  })
  .strict();

/**
 * Deliberately narrow. `db.updateNote` whitelists 21 columns, but writing
 * `transcript` flattens a JSON transcript into text and loses diarization for
 * good, and `note_type` is not in the whitelist at all.
 */
export const updateNoteSchema = z
  .object({
    note_id: noteId,
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    folder_id: folderId.describe('From list_folders. Moves the note.').optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.title === undefined && value.content === undefined && value.folder_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'update_note needs at least one of title, content or folder_id',
      });
    }
  });

export const deleteNoteSchema = z.object({ note_id: noteId }).strict();

export const listFoldersSchema = z.object({}).strict();

export const createFolderSchema = z.object({ name: z.string().trim().min(1) }).strict();

export const listDictionarySchema = z.object({}).strict();

export const updateDictionarySchema = z
  .object({
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (normalizeWordList(value.add).length + normalizeWordList(value.remove).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'update_dictionary needs at least one non-blank word in add or remove',
      });
    }
  });

/**
 * Trims, drops blanks and de-duplicates, preserving order. Case matters:
 * `MetaTrader` and `metatrader` are two different dictionary entries.
 */
export function normalizeWordList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const words: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    words.push(trimmed);
  }
  return words;
}
