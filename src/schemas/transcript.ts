import { z } from 'zod';
import { MAX_UPSTREAM_LIMIT } from '../config.js';

/**
 * Input schemas for the transcript and dictation tools.
 *
 * `offset`/`limit`/`speaker`/`source` are left without zod defaults on purpose:
 * the SDK applies defaults before the refinements run, so a default would make
 * "not passed" indistinguishable from "passed the default value" and the
 * mutually-exclusive check below could not fire. The effective defaults live in
 * the tool and are named in the field descriptions.
 */

export const TRANSCRIPT_FORMATS = ['segments', 'text', 'speakers'] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

export const TRANSCRIPT_SOURCES = ['mic', 'system'] as const;

export const DEFAULT_SEGMENT_OFFSET = 0;
export const DEFAULT_SEGMENT_LIMIT = 100;
export const MAX_SEGMENT_LIMIT = 200;

export const TRANSCRIPTION_STATUSES = ['completed', 'failed', 'pending'] as const;
export const DEFAULT_TRANSCRIPTIONS_LIMIT = 50;

const SPEAKERS_EXCLUSIVE =
  'format:"speakers" summarises the whole transcript at once, so offset, limit, speaker and source do not apply. Use format:"segments" to page or filter.';

const TEXT_NOT_PAGED =
  'format:"text" renders the whole transcript up to a character cap, so offset and limit do not apply. Use format:"segments" to page.';

export const getNoteTranscriptSchema = z
  .object({
    note_id: z.int().min(1).describe('Note id from list_notes, search_notes or get_note.'),
    format: z
      .enum(TRANSCRIPT_FORMATS)
      .default('segments')
      .describe(
        'segments: one entry per diarized segment, paged. text: [mm:ss] speaker lines. speakers: per-speaker totals only.',
      ),
    offset: z
      .int()
      .min(0)
      .optional()
      .describe('format:"segments" only. First segment (or text chunk) to return. Default 0.'),
    limit: z
      .int()
      .min(1)
      .max(MAX_SEGMENT_LIMIT)
      .optional()
      .describe(`format:"segments" only. Segments (or text chunks) per page, 1-${MAX_SEGMENT_LIMIT}. Default ${DEFAULT_SEGMENT_LIMIT}.`),
    speaker: z
      .string()
      .min(1)
      .optional()
      .describe('Keep only this speaker; matches the raw key (speaker_0, you) or the resolved label.'),
    source: z.enum(TRANSCRIPT_SOURCES).optional().describe('Keep only microphone or system audio.'),
    expect_updated_at: z
      .string()
      .min(1)
      .optional()
      .describe(
        'note_updated_at from the previous page. Fails with transcript_changed if the note moved, because offset paging would then skip or duplicate segments.',
      ),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.format === 'speakers') {
      for (const key of ['offset', 'limit', 'speaker', 'source'] as const) {
        if (args[key] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: SPEAKERS_EXCLUSIVE });
        }
      }
      return;
    }
    if (args.format === 'text') {
      for (const key of ['offset', 'limit'] as const) {
        if (args[key] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: TEXT_NOT_PAGED });
        }
      }
    }
  });

export const listTranscriptionsSchema = z
  .object({
    limit: z
      .int()
      .min(1)
      .max(MAX_UPSTREAM_LIMIT)
      .default(DEFAULT_TRANSCRIPTIONS_LIMIT)
      .describe(`Newest dictations to read, 1-${MAX_UPSTREAM_LIMIT}. The bridge has no pagination beyond this.`),
    status: z
      .enum(TRANSCRIPTION_STATUSES)
      .optional()
      .describe('Filtered locally over the rows the limit fetched — the bridge has no status parameter.'),
  })
  .strict();

export const getTranscriptionSchema = z
  .object({
    transcription_id: z.int().min(1).describe('Dictation id from list_transcriptions.'),
  })
  .strict();
