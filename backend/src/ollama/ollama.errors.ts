import { HttpStatus, HttpException } from '@nestjs/common';

/**
 * Every failure talking to Ollama becomes an OllamaError with a message that
 * is safe and useful to show to the user (no stack traces, no "fetch failed").
 *
 * It extends HttpException, so when it escapes a normal (non-streaming)
 * controller, Nest turns it into an HTTP response automatically:
 *   503 { "statusCode": 503, "message": "The AI model isn't reachable..." }
 */
export class OllamaError extends HttpException {
  constructor(
    message: string,
    /** True if trying the same request again might work (e.g. Ollama restarting). */
    readonly retryable: boolean,
    status: HttpStatus = HttpStatus.SERVICE_UNAVAILABLE,
  ) {
    super(message, status);
    this.name = 'OllamaError';
  }

  static unreachable(baseUrl: string): OllamaError {
    return new OllamaError(
      `The AI model isn't reachable at ${baseUrl}. Is Ollama running? ` +
        'Start it with "docker compose up -d" and try again.',
      true,
    );
  }

  static timeout(seconds: number): OllamaError {
    return new OllamaError(
      `The AI model didn't respond within ${seconds} seconds. It may still be ` +
        'loading or be overloaded. Please try again.',
      false,
      HttpStatus.GATEWAY_TIMEOUT,
    );
  }

  static modelMissing(model: string): OllamaError {
    return new OllamaError(
      `The model "${model}" isn't downloaded yet. Run: ` +
        `docker exec aibot-ollama ollama pull ${model}`,
      false,
    );
  }

  static server(status: number, detail: string): OllamaError {
    return new OllamaError(
      `The AI model returned an error (${status}): ${detail}`,
      // 5xx errors are often temporary (model reloading, out of memory spike).
      status >= 500,
      HttpStatus.BAD_GATEWAY,
    );
  }
}
