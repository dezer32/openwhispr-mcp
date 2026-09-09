import { z } from 'zod';
import { tokenize } from '../domain/ftsQuery.js';

/**
 * Input schemas for the read-only note tools.
 *
 * Each one is registered as-is: the SDK validates with it and derives the JSON
 * Schema from it, so a second pass inside the handler would be blind to unknown
 * keys. `.strict()` is what turns a typo like `limit` on `list_notes` into a
 * rejection instead of a silently ignored argument.
 */

export const NOTE_TYPES = ['personal', 'meeting', 'upload'] as const;

/** Largest page a single tool result will carry; the upstream cap is separate. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export const listNotesSchema = z
  .object({
    note_type: z.enum(NOTE_TYPES).optional(),
    folder_id: z.number().int().min(1).optional(),
    page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    // Filters may be repeated alongside a cursor; they are checked against the
    // snapshot rather than forbidden, so a mismatch can name the field.
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type ListNotesInput = z.infer<typeof listNotesSchema>;

export const getNoteSchema = z
  .object({
    note_id: z.number().int().min(1),
    include_enhanced: z.boolean().default(false),
  })
  .strict();

export type GetNoteInput = z.infer<typeof getNoteSchema>;

export const searchNotesSchema = z
  .object({
    q: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The bridge keeps only `[\p{L}\p{N}_]` runs. A query of punctuation alone
    // builds an empty FTS query, which matches nothing — and the bridge reports
    // that as an ordinary empty result, indistinguishable from "no matches".
    if (tokenize(value.q).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['q'],
        message:
          'query has no searchable tokens: the bridge keeps only letters, digits and underscores, so this query would match nothing',
      });
    }
  });

export type SearchNotesInput = z.infer<typeof searchNotesSchema>;
