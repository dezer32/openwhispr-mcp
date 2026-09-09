import { z } from 'zod';

/**
 * The limits are low on purpose. `/v1/notes/list` returns whole rows, including
 * the `transcript` column, which reaches 240 KB on a single meeting note, and
 * `include_transcript_stats` only switches off the local parsing — never the
 * download. The heavy mode is therefore something the caller opts into, with the
 * client-side byte cap (`response_too_large`) as the backstop.
 */
export const getUsageSchema = z
  .object({
    notes_limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .describe('Newest notes to read. Counts above it are reported as not exact.')
      .default(100),
    transcriptions_limit: z.number().int().min(1).max(1000).default(200),
    include_transcript_stats: z
      .boolean()
      .describe('Parse transcripts for segment and word counts. Slow on big meetings.')
      .default(false),
  })
  .strict();
