import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * This is the ONLY place in the app that talks to the LLM.
 *
 * Ollama exposes a plain HTTP API (docs: https://github.com/ollama/ollama/blob/main/docs/api.md).
 * An LLM call is just a POST request with JSON:
 *
 *   POST http://localhost:11434/api/chat
 *   {
 *     "model": "llama3.2:3b",
 *     "messages": [
 *       { "role": "system",    "content": "You are a helpful assistant." },
 *       { "role": "user",      "content": "Hi, I'm Sam." },
 *       { "role": "assistant", "content": "Hello Sam!" },
 *       { "role": "user",      "content": "What's my name?" }
 *     ],
 *     "stream": true
 *   }
 *
 * The model itself is STATELESS: it remembers nothing between requests.
 * "Memory" is just us re-sending the whole conversation every time.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** One line of Ollama's streaming /api/chat response. */
interface OllamaChatChunk {
  message?: { role: string; content: string };
  done: boolean;
  error?: string;
}

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private readonly baseUrl: string;
  readonly chatModel: string;
  readonly embedModel: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get('OLLAMA_BASE_URL', 'http://localhost:11434');
    this.chatModel = config.get('OLLAMA_CHAT_MODEL', 'llama3.2:3b');
    this.embedModel = config.get('OLLAMA_EMBED_MODEL', 'nomic-embed-text');
  }

  /**
   * Sends the conversation to the model and yields the reply token-by-token.
   *
   * With "stream": true, Ollama answers with NDJSON (newline-delimited JSON):
   *   {"message":{"role":"assistant","content":"Hel"},"done":false}
   *   {"message":{"role":"assistant","content":"lo"},"done":false}
   *   {"message":{"role":"assistant","content":""},"done":true, ...stats}
   */
  async *chatStream(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    this.logger.debug(`→ /api/chat with ${messages.length} messages`);

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.chatModel, messages, stream: true }),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // A network chunk may contain several lines, or half a line. Only parse full lines.
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
        if (chunk.message?.content) yield chunk.message.content;
        if (chunk.done) return;
      }
    }
  }

  /**
   * (Phase 2 / RAG) Turns texts into embedding vectors.
   *
   *   POST /api/embed  { "model": "nomic-embed-text", "input": ["text 1", "text 2"] }
   *   → { "embeddings": [[0.01, -0.2, ...768 numbers], [...]] }
   *
   * Texts with similar meaning get vectors that point in similar directions,
   * which is what lets us search by meaning instead of by keywords.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.embedModel, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}
