import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ChatService } from './chat.service';
import { ChatRequestDto } from './dto/chat-request.dto';

/**
 * POST /api/chat streams the answer back as NDJSON (one JSON object per line):
 *
 *   {"type":"meta","conversationId":"..."}
 *   {"type":"sources","sources":[...]}      (only when useDocuments is true)
 *   {"type":"token","content":"Hel"}
 *   {"type":"token","content":"lo!"}
 *   {"type":"done"}
 *
 * or {"type":"error","message":"..."} if something goes wrong mid-stream.
 */
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  async send(@Body() body: ChatRequestDto, @Res() res: Response) {
    const conversationId = this.chat.resolveConversation(body.conversationId);

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const send = (event: object) => res.write(JSON.stringify(event) + '\n');

    // If the browser disconnects (user pressed Stop), cancel the Ollama request too.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    send({ type: 'meta', conversationId });
    try {
      // Events are {type:'sources'} (RAG only, sent first) and {type:'token'}.
      for await (const event of this.chat.reply(
        conversationId,
        body.message,
        body.useDocuments ?? false,
        abort.signal,
      )) {
        send(event);
      }
      send({ type: 'done' });
    } catch (err) {
      if (!abort.signal.aborted) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      res.end();
    }
  }

  @Get(':conversationId')
  history(@Param('conversationId') conversationId: string) {
    return { conversationId, messages: this.chat.getHistory(conversationId) };
  }

  @Delete(':conversationId')
  @HttpCode(204)
  reset(@Param('conversationId') conversationId: string) {
    this.chat.reset(conversationId);
  }
}
