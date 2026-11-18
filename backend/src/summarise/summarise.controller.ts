import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SummariseRequestDto } from './dto/summarise-request.dto';
import { SummariseService } from './summarise.service';

/**
 * POST /api/summarise  { "text": "..." }
 * → 200 { "summary": { "title", "summary", "keywords": [3] }, "attempts": 1 }
 * → 502 if the model never produced valid JSON, 503/504 if Ollama is down or slow.
 */
@Controller('summarise')
export class SummariseController {
  constructor(private readonly summariser: SummariseService) {}

  @Post()
  @HttpCode(200)
  summarise(
    @Body() body: SummariseRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Stop the LLM call if the browser goes away.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    return this.summariser.summarise(body.text, abort.signal);
  }
}
