import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaError } from './ollama.errors';

/**
 * This is the ONLY place in the app that talks to the LLM.
 *
 * We use Ollama's OpenAI-COMPATIBLE API (http://localhost:11434/v1/...), the
 * same request/response format as OpenAI's API. Switching to OpenAI, Groq,
 * vLLM, LM Studio, etc. later is mostly a matter of changing the base URL,
 * the model name and adding an API key header.
 *
 *   POST http://localhost:11434/v1/chat/completions
 *   {
 *     "model": "llama3.2:3b",
 *     "temperature": 0.7,
 *     "stream": true,
 *     "messages": [
 *       { "role": "system",    "content": "You are a helpful assistant." },
 *       { "role": "user",      "content": "Hi, I'm Sam." },
 *       { "role": "assistant", "content": "Hello Sam!" },
 *       { "role": "user",      "content": "What's my name?" }
 *     ]
 *   }
 *
 * The model itself is STATELESS: it remembers nothing between requests.
 * "Memory" is just us re-sending the whole conversation every time.
 *
 * Temperature controls randomness when the model picks the next token:
 *   0   = always pick the most likely token (repeatable, good for facts/JSON)
 *   0.7 = some variety (good for conversation)
 *   1.5 = very random (creative, but drifts and makes things up more)
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** 0–2. Omit to use OLLAMA_TEMPERATURE. */
  temperature?: number;
  /** Abort when the user cancels (e.g. presses Stop). */
  signal?: AbortSignal;
}

export interface JsonChatOptions extends ChatOptions {
  /** A JSON Schema the reply must follow. Ollama constrains generation to it. */
  schema: Record<string, unknown>;
  schemaName: string;
}

/** One `data:` event of a streaming /v1/chat/completions response. */
interface StreamChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  error?: { message?: string };
}

interface Completion {
  choices?: { message?: { content?: string } }[];
}

/** Wait this long before retry 1, retry 2. Only "retryable" errors are retried. */
const RETRY_DELAYS_MS = [500, 1500];

/** While streaming, give up if no new token arrives for this long. */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private readonly baseUrl: string;
  readonly chatModel: string;
  readonly embedModel: string;
  readonly defaultTemperature: number;
  /** Max time for Ollama to START answering (includes loading the model into memory). */
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('OLLAMA_BASE_URL', 'http://localhost:11434')
      .replace(/\/+$/, '');
    this.chatModel = config.get('OLLAMA_CHAT_MODEL', 'llama3.2:3b');
    this.embedModel = config.get('OLLAMA_EMBED_MODEL', 'nomic-embed-text');
    this.defaultTemperature = Number(config.get('OLLAMA_TEMPERATURE', 0.7));
    this.timeoutMs = Number(config.get('OLLAMA_TIMEOUT_MS', 120_000));
  }

  /**
   * Sends the conversation to the model and yields the reply token by token.
   *
   * With "stream": true, the OpenAI-compatible API answers with server-sent
   * events (SSE): one `data: {json}` block per piece of text, then `data: [DONE]`.
   *
   *   data: {"choices":[{"delta":{"content":"Hel"}}]}
   *
   *   data: {"choices":[{"delta":{"content":"lo"}}]}
   *
   *   data: [DONE]
   */
  async *chatStream(
    messages: ChatMessage[],
    { temperature, signal }: ChatOptions = {},
  ): AsyncGenerator<string> {
    this.logger.debug(
      `→ /v1/chat/completions with ${messages.length} messages`,
    );

    const res = await this.post(
      '/chat/completions',
      {
        model: this.chatModel,
        messages,
        stream: true,
        temperature: temperature ?? this.defaultTemperature,
      },
      this.chatModel,
      signal,
    );

    try {
      for await (const data of this.readSse(res.body!)) {
        if (data === '[DONE]') return;
        const chunk = JSON.parse(data) as StreamChunk;
        if (chunk.error) {
          throw OllamaError.server(500, chunk.error.message ?? 'unknown');
        }
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) yield token;
      }
    } catch (err) {
      if (signal?.aborted || err instanceof OllamaError) throw err;
      // e.g. Ollama was stopped halfway through the answer.
      this.logger.warn(`Stream broke: ${String(err)}`);
      throw new OllamaError(
        'The connection to the AI model was lost while it was answering. Please try again.',
        false,
      );
    }
  }

  /**
   * Asks for a reply that follows a JSON Schema (structured output).
   *
   * `response_format: { type: "json_schema" }` makes Ollama constrain token
   * generation so the output matches the schema's shape. That makes valid JSON
   * very likely, but NOT guaranteed (e.g. the reply can be cut off, and rules
   * like "keywords must be different" can't be enforced this way), so callers
   * must still validate the result.
   *
   * Returns the raw text the model produced.
   */
  async chatJson(
    messages: ChatMessage[],
    { temperature, signal, schema, schemaName }: JsonChatOptions,
  ): Promise<string> {
    const res = await this.post(
      '/chat/completions',
      {
        model: this.chatModel,
        messages,
        stream: false,
        temperature: temperature ?? this.defaultTemperature,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, schema, strict: true },
        },
      },
      this.chatModel,
      signal,
    );
    const data = (await res.json()) as Completion;
    return data.choices?.[0]?.message?.content ?? '';
  }

  /**
   * (Phase 2 / RAG) Turns texts into embedding vectors.
   *
   *   POST /v1/embeddings  { "model": "nomic-embed-text", "input": ["text 1", "text 2"] }
   *   → { "data": [{ "index": 0, "embedding": [0.01, -0.2, ...768 numbers] }, ...] }
   *
   * Texts with similar meaning get vectors that point in similar directions,
   * which is what lets us search by meaning instead of by keywords.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.post(
      '/embeddings',
      { model: this.embedModel, input: texts },
      this.embedModel,
    );
    const data = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  /** Names of the models Ollama has downloaded. Used by GET /api/health. */
  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw OllamaError.unreachable(this.baseUrl);
    }
    if (!res.ok) throw OllamaError.server(res.status, await errorDetail(res));
    const data = (await res.json()) as { data: { id: string }[] };
    return data.data.map((m) => m.id);
  }

  // ---------------------------------------------------------------------------
  // HTTP plumbing: retries, timeouts and turning failures into friendly errors
  // ---------------------------------------------------------------------------

  /**
   * POSTs to the OpenAI-compatible API, retrying failures that might be
   * temporary (Ollama not reachable, 5xx). Each retry waits a bit longer.
   *
   * Streams are only retried BEFORE the first token arrives: once the user has
   * seen half an answer, silently starting again would be confusing.
   */
  private async post(
    path: string,
    body: object,
    model: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.postOnce(path, body, model, signal);
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        const retry =
          err instanceof OllamaError &&
          err.retryable &&
          delay !== undefined &&
          !signal?.aborted;
        if (!retry) throw err;
        this.logger.warn(
          `${path} failed: ${err.message} Retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay} ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async postOnce(
    path: string,
    body: object,
    model: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    // One controller for both "the user cancelled" and "Ollama took too long".
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onUserAbort = () => controller.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      signal?.removeEventListener('abort', onUserAbort);
      if (signal?.aborted) throw err; // the user cancelled: not an error to report
      if (timedOut) throw OllamaError.timeout(this.timeoutMs / 1000);
      // fetch throws a TypeError ("fetch failed") when nothing is listening.
      throw OllamaError.unreachable(this.baseUrl);
    } finally {
      // Ollama has started answering. From here on, a stream is guarded by the
      // idle timeout in readSse instead, so long answers aren't cut off.
      clearTimeout(timer);
    }

    if (res.ok && res.body) return res;

    signal?.removeEventListener('abort', onUserAbort);
    const detail = await errorDetail(res);
    if (res.status === 404 && /not found/i.test(detail)) {
      throw OllamaError.modelMissing(model);
    }
    throw OllamaError.server(res.status, detail);
  }

  /**
   * Parses a server-sent events stream and yields each event's `data`.
   * Events are separated by a blank line. A network chunk may hold several
   * events or half of one, so we buffer until we have complete events.
   */
  private async *readSse(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await readWithTimeout(
          reader,
          STREAM_IDLE_TIMEOUT_MS,
        );
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) yield data;
        }
      }
    } finally {
      // If we stop early (user pressed Stop, error), closing the stream
      // tells Ollama to stop generating.
      reader.cancel().catch(() => {});
    }
  }
}

/** reader.read(), but fails with a friendly timeout error if nothing arrives in time. */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(OllamaError.timeout(ms / 1000)), ms);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Extracts the error message from an OpenAI-style error body: {"error":{"message":"..."}}. */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text) as { error?: { message?: string } | string };
    const message =
      typeof data.error === 'string' ? data.error : data.error?.message;
    if (message) return message;
  } catch {
    // not JSON
  }
  return (text || res.statusText).slice(0, 300);
}
