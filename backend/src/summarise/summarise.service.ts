import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ChatMessage, OllamaService } from '../ollama/ollama.service';
import { Summary, SUMMARY_JSON_SCHEMA, SummarySchema } from './summary.schema';

/** First try + 2 retries. */
export const MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You summarise text. Reply with ONLY a JSON object, no other text:
{"title": "...", "summary": "...", "keywords": ["...", "...", "..."]}
- title: short and specific (max 10 words)
- summary: 2 to 4 sentences, using only facts from the text
- keywords: exactly 3 different keywords or short phrases`;

export interface SummariseResult {
  summary: Summary;
  /** How many tries it took to get valid JSON (1 = first time). */
  attempts: number;
}

type Validation = { ok: true; data: Summary } | { ok: false; error: string };

/**
 * Turns free text into validated JSON: { title, summary, keywords[3] }.
 *
 * The loop:
 *   ask the model → parse JSON → validate against the schema
 *     ✓ valid   → return it
 *     ✗ invalid → tell the model exactly what was wrong and ask again
 *   after MAX_ATTEMPTS failures → a clean error. The user never sees broken JSON.
 */
@Injectable()
export class SummariseService {
  private readonly logger = new Logger(SummariseService.name);
  /** Demo switch: corrupt the first reply so you can watch the retry happen. */
  private readonly breakFirstAttempt: boolean;

  constructor(
    private readonly ollama: OllamaService,
    config: ConfigService,
  ) {
    this.breakFirstAttempt =
      config.get('SUMMARISE_DEBUG_BREAK_FIRST_ATTEMPT') === 'true';
  }

  async summarise(
    text: string,
    signal?: AbortSignal,
  ): Promise<SummariseResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Text to summarise:\n\n${text}` },
    ];

    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let raw = await this.ollama.chatJson(messages, {
        schema: SUMMARY_JSON_SCHEMA,
        schemaName: 'summary',
        // Low temperature = more predictable output, which is what we want for JSON.
        temperature: 0.2,
        signal,
      });
      if (attempt === 1 && this.breakFirstAttempt) {
        raw = raw.slice(0, Math.floor(raw.length / 2)); // simulate a cut-off reply
      }

      const result = validateSummary(raw);
      if (result.ok) {
        if (attempt > 1) {
          this.logger.log(`Valid summary on attempt ${attempt}`);
        }
        return { summary: result.data, attempts: attempt };
      }

      lastError = result.error;
      this.logger.warn(
        `Attempt ${attempt}/${MAX_ATTEMPTS} returned invalid JSON: ${result.error}\n  raw: ${raw.slice(0, 300)}`,
      );
      // Show the model its own reply and what was wrong with it, then ask again.
      messages.push(
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content:
            `That reply was not valid: ${result.error}. ` +
            'Reply again with ONLY the corrected JSON object.',
        },
      );
    }

    throw new BadGatewayException(
      `The AI model didn't return a valid summary after ${MAX_ATTEMPTS} attempts. ` +
        `Please try again. (Last problem: ${lastError})`,
    );
  }
}

/** Step 1: is it JSON at all? Step 2: does it match the schema? */
export function validateSummary(raw: string): Validation {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'the reply is not valid JSON' };
  }
  const parsed = SummarySchema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  // e.g. "keywords: Too small: expected array to have >=3 items"
  return {
    ok: false,
    error: z.prettifyError(parsed.error).replace(/\n/g, ' '),
  };
}
