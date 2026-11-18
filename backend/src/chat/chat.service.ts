import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { DocumentsService, Source } from '../documents/documents.service';
import { ChatMessage, OllamaService } from '../ollama/ollama.service';
import { ConversationStore } from './conversation.store';

const SYSTEM_PROMPT =
  'You are a helpful, friendly assistant. Answer clearly and concisely.';

/** Shown when no document is relevant enough. Sent without asking the LLM at all. */
export const NOT_FOUND_MESSAGE =
  "I couldn't find that in the uploaded documents.";

/** (Phase 2) Used instead of SYSTEM_PROMPT when answering from documents. */
const RAG_SYSTEM_PROMPT = `You are a helpful assistant that answers questions using the numbered sources provided with each question.

Rules:
- Use only information from the sources. Do not use outside knowledge.
- After each sentence that uses a source, cite it with its number in square brackets, e.g. [1] or [2][3].
- If the sources do not contain the answer, say "${NOT_FOUND_MESSAGE}" and nothing else.
- Be concise.`;

/**
 * Small models have small context windows, so we only send the most recent
 * messages. Older ones are still stored, the model just doesn't see them.
 */
const MAX_HISTORY_MESSAGES = 20;

/** How many chunks to retrieve and put in the prompt. */
const RETRIEVAL_TOP_K = 5;

/**
 * Drop chunks that score much lower than the best match. Weakly related
 * chunks add little, and small models tend to cite them by mistake.
 * Raise this if answers that need several different chunks lose some.
 */
const MAX_SCORE_GAP_FROM_BEST = 0.15;

/**
 * For answers from documents we want facts, not creativity, so the default
 * temperature is low. (Plain chat uses OLLAMA_TEMPERATURE, 0.7 by default.)
 */
const RAG_TEMPERATURE = 0.1;

/** What a generated chat title must look like (validated, like the summaries). */
const TitleSchema = z.object({
  title: z.string().trim().min(2).max(80).describe('A 3 to 6 word title'),
});
const TITLE_JSON_SCHEMA = z.toJSONSchema(TitleSchema) as Record<
  string,
  unknown
>;

const TITLE_PROMPT = `Write a short title (3 to 6 words) for the conversation below, like a chat app's sidebar title.
Describe the topic. No quotes, no emoji, no full stop at the end.
Reply with only JSON: {"title": "..."}`;

export type ChatStreamEvent =
  { type: 'sources'; sources: Source[] } | { type: 'token'; content: string };

export interface ReplyOptions {
  useDocuments: boolean;
  temperature?: number;
  signal?: AbortSignal;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  /**
   * Minimum similarity (0–1) for a chunk to count as relevant at all.
   * Measured with nomic-embed-text on the sample documents: questions the
   * documents answer scored 0.70+, unrelated questions ("capital of France?",
   * "chocolate cake recipe") scored at most 0.51. Tune via RAG_MIN_SCORE.
   */
  private readonly minScore: number;

  constructor(
    private readonly ollama: OllamaService,
    private readonly store: ConversationStore,
    private readonly documents: DocumentsService,
    config: ConfigService,
  ) {
    this.minScore = Number(config.get('RAG_MIN_SCORE', 0.6));
  }

  /**
   * Returns the conversation to continue, or starts a new one (no id given,
   * or the id no longer exists because the chat was deleted).
   */
  async resolveConversation(
    conversationId: string | undefined,
    firstMessage: string,
  ): Promise<string> {
    if (conversationId && (await this.store.exists(conversationId))) {
      return conversationId;
    }
    return this.store.create(firstMessage);
  }

  /**
   * Like ChatGPT: after the first answer, ask the LLM for a short title that
   * replaces the provisional one (the start of the first question).
   * Returns the new title, or null if there was nothing to do or it failed.
   * A failed attempt is simply tried again after the next message.
   */
  async generateTitleIfNeeded(conversationId: string): Promise<string | null> {
    if (!(await this.store.needsTitle(conversationId))) return null;
    const [question, answer] = await this.store.messages(conversationId);
    if (!question || !answer) return null;

    try {
      const raw = await this.ollama.chatJson(
        [
          { role: 'system', content: TITLE_PROMPT },
          {
            role: 'user',
            content:
              `User: ${question.content.slice(0, 1000)}\n\n` +
              `Assistant: ${answer.content.slice(0, 1000)}`,
          },
        ],
        {
          schema: TITLE_JSON_SCHEMA,
          schemaName: 'chat_title',
          temperature: 0.3,
        },
      );
      const parsed = TitleSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      const title = parsed.data.title
        .replace(/^["'“”]+|["'“”]+$/g, '') // models love wrapping titles in quotes
        .replace(/[.!]+$/, '')
        .trim();
      if (!title) return null;
      return (await this.store.setGeneratedTitle(conversationId, title))
        ? title
        : null;
    } catch (err) {
      this.logger.warn(`Couldn't generate a chat title: ${String(err)}`);
      return null;
    }
  }

  /**
   * The core loop of a chatbot:
   *   1. (RAG only) retrieve relevant chunks; if none are relevant, say so and stop
   *   2. send [system prompt + recent history + new message] to the model
   *   3. stream the reply back to the caller
   *   4. save the turn to the history so the next turn can see it
   */
  async *reply(
    conversationId: string,
    userMessage: string,
    { useDocuments, temperature, signal }: ReplyOptions,
  ): AsyncGenerator<ChatStreamEvent> {
    const history = await this.store.recentMessages(
      conversationId,
      MAX_HISTORY_MESSAGES,
    );

    let systemPrompt = SYSTEM_PROMPT;
    let promptForModel = userMessage;
    let sources: Source[] | undefined;

    if (useDocuments) {
      sources = await this.retrieve(userMessage);
      yield { type: 'sources', sources };

      // Nothing relevant: answer "not found" ourselves. Asking the model with
      // no useful sources is exactly when it would make something up.
      if (sources.length === 0) {
        yield { type: 'token', content: NOT_FOUND_MESSAGE };
        await this.store.appendTurn(
          conversationId,
          userMessage,
          NOT_FOUND_MESSAGE,
          sources,
        );
        return;
      }

      systemPrompt = RAG_SYSTEM_PROMPT;
      promptForModel = buildRagPrompt(userMessage, sources);
      temperature ??= RAG_TEMPERATURE;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      // Strip `sources` so only role + content are sent to the model.
      ...history.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: promptForModel },
    ];

    let fullReply = '';
    for await (const token of this.ollama.chatStream(messages, {
      temperature,
      signal,
    })) {
      fullReply += token;
      yield { type: 'token', content: token };
    }

    // Only save the turn once the model finished, so a failed or cancelled
    // request doesn't leave a question without an answer in the history.
    // We store the plain question, not the big prompt with the sources in it,
    // so the history stays small. Each new question retrieves fresh sources.
    await this.store.appendTurn(
      conversationId,
      userMessage,
      fullReply,
      sources,
    );
  }

  /** Finds the chunks relevant to the question, renumbered 1, 2, 3… */
  private async retrieve(question: string): Promise<Source[]> {
    const results = await this.documents.search(question, RETRIEVAL_TOP_K);
    const best = results[0]?.score ?? 0;
    return results
      .filter((s) => s.score >= this.minScore)
      .filter((s) => s.score >= best - MAX_SCORE_GAP_FROM_BEST)
      .map((s, i) => ({ ...s, n: i + 1 }));
  }
}

/**
 * "Augmented generation": the retrieved chunks are pasted into the prompt,
 * each with a number the model can cite. This is all RAG really is: the
 * model only "knows" your documents because we put the relevant parts in front of it.
 */
function buildRagPrompt(question: string, sources: Source[]): string {
  const context = sources
    .map((s) => `[${s.n}] (${describeSource(s)})\n${s.content}`)
    .join('\n\n---\n\n');
  const validNumbers = sources.map((s) => `[${s.n}]`).join(', ');
  // Small models follow instructions best when they come right before the
  // answer, so the citation rule is repeated here, after the question.
  return (
    `Sources:\n\n${context}\n\n---\n\n` +
    `Question: ${question}\n\n` +
    `Answer using only the sources above. After each sentence, cite the source ` +
    `it came from in square brackets. Valid citations: ${validNumbers}.`
  );
}

/** "handbook.pdf, page 2", or just the name for DOCX / web pages (no page numbers). */
function describeSource(s: Source): string {
  return s.page === null ? s.filename : `${s.filename}, page ${s.page}`;
}
