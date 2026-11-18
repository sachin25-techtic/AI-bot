import { z } from 'zod';

/**
 * The ONE definition of what a valid summary looks like.
 *
 * It is used twice:
 *  1. Converted to JSON Schema (z.toJSONSchema) and sent to the model, so
 *     Ollama constrains its output to this shape.
 *  2. To validate what the model actually returned (SummarySchema.safeParse),
 *     because constrained output can still be cut off or break rules that
 *     JSON Schema can't express (like "the keywords must be different").
 */
export const SummarySchema = z.object({
  title: z.string().trim().min(3).max(120).describe('A short, specific title'),
  summary: z
    .string()
    .trim()
    .min(20)
    .max(1500)
    .describe('A 2–4 sentence summary of the text'),
  keywords: z
    .array(z.string().trim().min(1).max(40))
    .length(3)
    .describe('Exactly three different keywords')
    // A rule JSON Schema can't enforce during generation, only validation can.
    .refine((words) => new Set(words.map((w) => w.toLowerCase())).size === 3, {
      message: 'The three keywords must all be different',
    }),
});

export type Summary = z.infer<typeof SummarySchema>;

export const SUMMARY_JSON_SCHEMA = z.toJSONSchema(SummarySchema, {
  // .refine() has no JSON Schema equivalent; leave it out of the schema we send.
  unrepresentable: 'any',
}) as Record<string, unknown>;
