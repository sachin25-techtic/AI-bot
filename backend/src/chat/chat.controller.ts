import {
  Body,
  Controller,
  HttpException,
  Logger,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ChatService } from './chat.service';
import { ChatRequestDto } from './dto/chat-request.dto';

/**
 * POST /api/chat streams the answer back as SERVER-SENT EVENTS (SSE).
 *
 * SSE is a simple text format over a normal HTTP response
 * (Content-Type: text/event-stream). Each event is an `event:` line naming
 * its type, a `data:` line with JSON, and a blank line to end the event:
 *
 *   event: meta
 *   data: {"conversationId":"..."}
 *
 *   event: sources                      (only when useDocuments is true)
 *   data: {"sources":[...]}
 *
 *   event: token
 *   data: {"content":"Hel"}
 *
 *   event: token
 *   data: {"content":"lo!"}
 *
 *   event: done
 *   data: {}
 *
 *   event: title                        (after the first answer of a new chat)
 *   data: {"title":"Annual leave policy"}
 *
 * or `event: error` / `data: {"message":"..."}` if something goes wrong mid-stream.
 *
 * (The browser's built-in EventSource only supports GET, so the frontend reads
 * this stream with fetch() and a small parser. The format is the same.)
 */
@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly chat: ChatService) {}

  @Post()
  async send(@Body() body: ChatRequestDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // stop proxies like nginx buffering the stream
    res.flushHeaders();

    const send = (event: string, data: object = {}) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // If the browser disconnects (user pressed Stop), cancel the Ollama request too.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      const conversationId = await this.chat.resolveConversation(
        body.conversationId,
        body.message,
      );
      send('meta', { conversationId });

      for await (const event of this.chat.reply(conversationId, body.message, {
        useDocuments: body.useDocuments ?? false,
        temperature: body.temperature,
        signal: abort.signal,
      })) {
        if (event.type === 'sources')
          send('sources', { sources: event.sources });
        else send('token', { content: event.content });
      }
      // "done" first, so the UI can unlock the input right away...
      send('done');

      // ...then, for a new chat, name it (takes a second or two on CPU).
      if (!abort.signal.aborted) {
        const title = await this.chat.generateTitleIfNeeded(conversationId);
        if (title) send('title', { title });
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        send('error', { message: friendlyMessage(err, this.logger) });
      }
    } finally {
      res.end();
    }
  }
}

/**
 * Errors we raise on purpose (OllamaError and other HttpExceptions) already
 * carry a message meant for users. Anything else is a bug or an outage we
 * didn't anticipate: log the details, show a generic message.
 */
function friendlyMessage(err: unknown, logger: Logger): string {
  if (err instanceof HttpException) return err.message;
  logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  if (isConnectionRefused(err)) {
    return 'The database isn\'t reachable. Start it with "docker compose up -d".';
  }
  return 'Something went wrong while answering. Please try again.';
}

function isConnectionRefused(err: unknown): boolean {
  const e = err as { code?: string; errors?: { code?: string }[] };
  return (
    e?.code === 'ECONNREFUSED' ||
    (e?.errors ?? []).some((x) => x.code === 'ECONNREFUSED')
  );
}
