import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatMessage, OllamaService } from '../ollama/ollama.service';
import {
  MAX_ATTEMPTS,
  SummariseService,
  validateSummary,
} from './summarise.service';

const VALID = JSON.stringify({
  title: 'Photosynthesis',
  summary: 'Plants turn light into chemical energy and release oxygen.',
  keywords: ['plants', 'light', 'oxygen'],
});

/** A fake OllamaService that returns the given replies in order. */
function serviceReturning(...replies: string[]) {
  const chatJson = jest.fn<Promise<string>, [ChatMessage[], unknown]>();
  replies.forEach((r) => chatJson.mockResolvedValueOnce(r));
  const ollama = { chatJson } as unknown as OllamaService;
  const service = new SummariseService(ollama, new ConfigService({}));
  return { service, chatJson };
}

describe('validateSummary', () => {
  it('accepts a valid summary', () => {
    expect(validateSummary(VALID).ok).toBe(true);
  });

  it('rejects text that is not JSON', () => {
    expect(validateSummary('{"title": "Cut off')).toEqual({
      ok: false,
      error: 'the reply is not valid JSON',
    });
  });

  it('rejects JSON that breaks the schema', () => {
    const twoKeywords = JSON.stringify({
      title: 'Title',
      summary: 'A long enough summary of the text.',
      keywords: ['a', 'b'],
    });
    expect(validateSummary(twoKeywords).ok).toBe(false);
  });

  it('rejects duplicate keywords (a rule JSON Schema cannot enforce)', () => {
    const dupes = JSON.stringify({
      title: 'Title',
      summary: 'A long enough summary of the text.',
      keywords: ['AI', 'ai', 'models'],
    });
    expect(validateSummary(dupes).ok).toBe(false);
  });
});

describe('SummariseService', () => {
  it('returns the first valid reply', async () => {
    const { service, chatJson } = serviceReturning(VALID);
    const result = await service.summarise('some text');
    expect(result.attempts).toBe(1);
    expect(result.summary.keywords).toHaveLength(3);
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it('retries when the model returns invalid JSON, and tells it what was wrong', async () => {
    const { service, chatJson } = serviceReturning('{"title": "Pho', VALID);
    const result = await service.summarise('some text');
    expect(result.attempts).toBe(2);

    // The retry includes the bad reply and the validation error.
    const retryMessages = chatJson.mock.calls[1][0];
    expect(retryMessages.at(-1)!.content).toContain('not valid JSON');
  });

  it('gives up with a clean error after MAX_ATTEMPTS invalid replies', async () => {
    const { service, chatJson } = serviceReturning(
      ...Array<string>(MAX_ATTEMPTS).fill('not json'),
    );
    await expect(service.summarise('some text')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(chatJson).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });
});
