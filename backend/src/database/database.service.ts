import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, QueryResultRow } from 'pg';

/**
 * Must match the embedding model's output size.
 * nomic-embed-text produces 768 numbers per text. If you switch embedding
 * models, change this and recreate the `chunks` table.
 */
export const EMBEDDING_DIMENSIONS = 768;

const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS documents (
    id          SERIAL PRIMARY KEY,
    filename    TEXT        NOT NULL,
    page_count  INT         NOT NULL,
    chunk_count INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- One row per chunk of text, with its embedding vector.
  CREATE TABLE IF NOT EXISTS chunks (
    id          SERIAL PRIMARY KEY,
    document_id INT  NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page        INT  NOT NULL,
    chunk_index INT  NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(${EMBEDDING_DIMENSIONS}) NOT NULL
  );

  -- Approximate-nearest-neighbour index so similarity search stays fast
  -- with many chunks. vector_cosine_ops = we compare by cosine distance (<=>).
  CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON chunks USING hnsw (embedding vector_cosine_ops);
`;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
    });
  }

  /** Creates the tables on startup if they don't exist yet. */
  async onModuleInit() {
    await this.pool.query(SCHEMA_SQL);
    this.logger.log('Database schema ready (pgvector enabled)');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }
}

/** pgvector accepts vectors as text like '[0.1,0.2,...]'. */
export function toPgVector(values: number[]): string {
  return `[${values.join(',')}]`;
}
