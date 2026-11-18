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
    page        INT,
    chunk_index INT  NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(${EMBEDDING_DIMENSIONS}) NOT NULL
  );

  -- Approximate-nearest-neighbour index so similarity search stays fast
  -- with many chunks. vector_cosine_ops = we compare by cosine distance (<=>).
  CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON chunks USING hnsw (embedding vector_cosine_ops);

  -- Added for DOCX / web pages and re-upload handling. "ADD COLUMN IF NOT
  -- EXISTS" upgrades a database created by the earlier version in place.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type  TEXT NOT NULL DEFAULT 'pdf'; -- pdf | docx | web
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_url   TEXT;                        -- web pages only
  -- What makes two uploads "the same document": the file name, or the URL.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_key   TEXT;
  -- SHA-256 of the extracted text, to spot whether a re-upload actually changed.
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT;
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();
  UPDATE documents SET source_key = filename WHERE source_key IS NULL;
  ALTER TABLE documents ALTER COLUMN source_key SET NOT NULL;
  CREATE INDEX IF NOT EXISTS documents_source_key_idx ON documents (source_key);

  -- DOCX files and web pages have no page numbers.
  ALTER TABLE chunks ALTER COLUMN page DROP NOT NULL;

  -- Chat history (the ChatGPT-style sidebar).
  CREATE TABLE IF NOT EXISTS conversations (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT        NOT NULL,
    -- false while the title is just the start of the first question;
    -- true once the LLM has named the chat or the user renamed it.
    title_final BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations (updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id              BIGSERIAL   PRIMARY KEY,
    conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT        NOT NULL,
    sources         JSONB,      -- RAG answers: the chunks behind [1], [2]…
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);
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
