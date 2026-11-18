import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DatabaseService, toPgVector } from '../database/database.service';
import { OllamaService } from '../ollama/ollama.service';
import { chunkText } from './chunking';
import { extractPdfPages } from './pdf-text';

export interface DocumentInfo {
  id: number;
  filename: string;
  pageCount: number;
  chunkCount: number;
  createdAt: string;
}

/** A retrieved chunk, numbered so the model can cite it as [n]. */
export interface Source {
  n: number;
  documentId: number;
  filename: string;
  page: number;
  content: string;
  score: number; // cosine similarity, 1 = identical meaning
}

/** How many chunks to embed per Ollama request. */
const EMBED_BATCH_SIZE = 16;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ollama: OllamaService,
  ) {}

  /**
   * nomic-embed-text was trained with task prefixes: documents and queries are
   * embedded slightly differently, which improves retrieval.
   * Other embedding models don't need this.
   */
  private prefix(kind: 'document' | 'query', text: string): string {
    if (!this.ollama.embedModel.startsWith('nomic-embed-text')) return text;
    return kind === 'document'
      ? `search_document: ${text}`
      : `search_query: ${text}`;
  }

  /**
   * The whole ingestion pipeline:
   *   PDF → text per page → chunks → embeddings → rows in pgvector
   */
  async ingest(filename: string, data: Buffer): Promise<DocumentInfo> {
    // 1. Extract text
    const pages = await extractPdfPages(data);

    // 2. Chunk each page (so every chunk keeps its page number)
    const chunks = pages.flatMap(({ page, text }) =>
      chunkText(text).map((content) => ({ page, content })),
    );
    if (chunks.length === 0) {
      throw new UnprocessableEntityException(
        'No text found in this PDF. Is it a scanned image? (It would need OCR.)',
      );
    }

    // 3. Embed the chunks, a batch at a time
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      embeddings.push(
        ...(await this.ollama.embed(
          batch.map((c) => this.prefix('document', c.content)),
        )),
      );
    }

    // 4. Store the document and its chunks in one transaction
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const {
        rows: [doc],
      } = await client.query<{ id: number; created_at: Date }>(
        `INSERT INTO documents (filename, page_count, chunk_count)
         VALUES ($1, $2, $3) RETURNING id, created_at`,
        [filename, pages.length, chunks.length],
      );
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO chunks (document_id, page, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [
            doc.id,
            chunks[i].page,
            i,
            chunks[i].content,
            toPgVector(embeddings[i]),
          ],
        );
      }
      await client.query('COMMIT');

      this.logger.log(
        `Ingested "${filename}": ${pages.length} pages, ${chunks.length} chunks`,
      );
      return {
        id: doc.id,
        filename,
        pageCount: pages.length,
        chunkCount: chunks.length,
        createdAt: doc.created_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async list(): Promise<DocumentInfo[]> {
    const rows = await this.db.query<{
      id: number;
      filename: string;
      page_count: number;
      chunk_count: number;
      created_at: Date;
    }>(
      'SELECT id, filename, page_count, chunk_count, created_at FROM documents ORDER BY created_at DESC',
    );
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      pageCount: r.page_count,
      chunkCount: r.chunk_count,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async remove(id: number): Promise<void> {
    const rows = await this.db.query(
      'DELETE FROM documents WHERE id = $1 RETURNING id',
      [id],
    );
    if (rows.length === 0) throw new NotFoundException('Document not found');
  }

  /**
   * Retrieval: embed the question, then ask Postgres for the chunks whose
   * vectors are closest to it. `<=>` is pgvector's cosine-distance operator
   * (0 = same direction), so similarity = 1 - distance.
   */
  async search(question: string, limit = 5): Promise<Source[]> {
    const [queryVector] = await this.ollama.embed([
      this.prefix('query', question),
    ]);

    const rows = await this.db.query<{
      document_id: number;
      filename: string;
      page: number;
      content: string;
      score: number;
    }>(
      `SELECT c.document_id, d.filename, c.page, c.content,
              1 - (c.embedding <=> $1::vector) AS score
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        ORDER BY c.embedding <=> $1::vector
        LIMIT $2`,
      [toPgVector(queryVector), limit],
    );

    return rows.map((r, i) => ({
      n: i + 1,
      documentId: r.document_id,
      filename: r.filename,
      page: r.page,
      content: r.content,
      score: Number(r.score),
    }));
  }
}
