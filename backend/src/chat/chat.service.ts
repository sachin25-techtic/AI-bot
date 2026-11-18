import { Injectable } from '@nestjs/common';
import { DocumentsService, Source } from '../documents/documents.service';
import { ChatMessage, OllamaService } from '../ollama/ollama.service';
import { ConversationStore, StoredMessage } from './conversation.store';

const SYSTEM_PROMPT =
  'You are a helpful, friendly assistant. Answer clearly and concisely.';

/** (Phase 2) Used instead of SYSTEM_PROMPT when answering from documents. */
const RAG_SYSTEM_PROMPT = `You are a helpful assistant that answers questions using the numbered sources provided with each question.

Rules:
- Use only information from the sources. Do not use outside knowledge.
- After each sentence that uses a source, cite it with its number in square brackets, e.g. [1] or [2][3].
- If the sources do not contain the answer, say "I couldn't find that in the uploaded documents." and nothing else.
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

export type ChatStreamEvent =
  { type: 'sources'; sources: Source[] } | { type: 'token'; content: string };

@Injectable()
export class ChatService {
  constructor(
    private readonly ollama: OllamaService,
    private readonly store: ConversationStore,
    private readonly documents: DocumentsService,
  ) {}

  /** Returns an existing conversation id, or creates a new conversation. */
  resolveConversation(conversationId?: string): string {
    if (conversationId && this.store.has(conversationId)) return conversationId;
    return this.store.create();
  }

  getHistory(conversationId: string): StoredMessage[] {
    return this.store.get(conversationId);
  }

  reset(conversationId: string): void {
    this.store.delete(conversationId);
  }

  /**
   * The core loop of a chatbot:
   *   1. (RAG only) retrieve relevant chunks and put them in the prompt
   *   2. send [system prompt + recent history + new message] to the model
   *   3. stream the reply back to the caller
   *   4. save the turn to the history so the next turn can see it
   */
  async *reply(
    conversationId: string,
    userMessage: string,
    useDocuments: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const history = this.store.get(conversationId);

    let systemPrompt = SYSTEM_PROMPT;
    let promptForModel = userMessage;
    let sources: Source[] | undefined;

    if (useDocuments) {
      const results = await this.documents.search(userMessage, RETRIEVAL_TOP_K);
      // Results are sorted best-first, so this keeps a prefix and n stays 1, 2, 3…
      const best = results[0]?.score ?? 0;
      sources = results.filter(
        (s) => s.score >= best - MAX_SCORE_GAP_FROM_BEST,
      );
      yield { type: 'sources', sources };
      systemPrompt = RAG_SYSTEM_PROMPT;
      promptForModel = buildRagPrompt(userMessage, sources);
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      // Strip `sources` so only role + content are sent to the model.
      ...history
        .slice(-MAX_HISTORY_MESSAGES)
        .map(({ role, content }) => ({ role, content })),
      { role: 'user', content: promptForModel },
    ];

    let fullReply = '';
    for await (const token of this.ollama.chatStream(messages, signal)) {
      fullReply += token;
      yield { type: 'token', content: token };
    }

    // Only save the turn once the model finished, so a failed or cancelled
    // request doesn't leave a question without an answer in the history.
    // We store the plain question, not the big prompt with the sources in it,
    // so the history stays small. Each new question retrieves fresh sources.
    this.store.append(conversationId, { role: 'user', content: userMessage });
    this.store.append(conversationId, {
      role: 'assistant',
      content: fullReply,
      sources,
    });
  }
}

/**
 * "Augmented generation": the retrieved chunks are pasted into the prompt,
 * each with a number the model can cite. This is all RAG really is: the
 * model only "knows" your PDF because we put the relevant parts in front of it.
 */
function buildRagPrompt(question: string, sources: Source[]): string {
  if (sources.length === 0) {
    return `Sources: (none, no documents have been uploaded)\n\nQuestion: ${question}`;
  }
  const context = sources
    .map((s) => `[${s.n}] (${s.filename}, page ${s.page})\n${s.content}`)
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
