import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { OllamaError } from '../ollama/ollama.errors';
import { OllamaService } from '../ollama/ollama.service';

export interface HealthReport {
  ok: boolean;
  /** Human-readable problems, ready to show in the UI. Empty when ok. */
  problems: string[];
  ollama: boolean;
  database: boolean;
  models: { chat: string; embed: string; installed: string[] };
}

/**
 * GET /api/health: is everything the app needs available?
 * The frontend calls this to show a warning banner instead of failing later.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly ollama: OllamaService,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  async check(): Promise<HealthReport> {
    const problems: string[] = [];
    const { chatModel, embedModel } = this.ollama;

    let installed: string[] = [];
    let ollamaOk = false;
    try {
      installed = await this.ollama.listModels();
      ollamaOk = true;
      for (const model of [chatModel, embedModel]) {
        if (!hasModel(installed, model)) {
          problems.push(OllamaError.modelMissing(model).message);
        }
      }
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }

    let databaseOk = false;
    try {
      await this.db.query('SELECT 1');
      databaseOk = true;
    } catch {
      problems.push(
        'The database (Postgres) isn\'t reachable. Start it with "docker compose up -d".',
      );
    }

    return {
      ok: problems.length === 0,
      problems,
      ollama: ollamaOk,
      database: databaseOk,
      models: { chat: chatModel, embed: embedModel, installed },
    };
  }
}

/** "nomic-embed-text" and "nomic-embed-text:latest" are the same model. */
function hasModel(installed: string[], model: string): boolean {
  const name = model.includes(':') ? model : `${model}:latest`;
  return installed.includes(name);
}
