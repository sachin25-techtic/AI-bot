import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService, toPgVector } from '../database/database.service';
import { OllamaService } from '../ollama/ollama.service';
import { chunkText } from './chunking';
import { extractDocxText } from './docx-text';
import { extractPdfPages, PageText } from './pdf-text';
import { extractWebPage } from './web-text';

export type SourceType = 'pdf' | 'docx' | 'web';

export interface DocumentInfo {
  id: number;
  filename: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  pageCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an upload did:
 *  created   = a new document
 *  updated   = same name/URL as an existing document but different text: old chunks replaced
 *  unchanged = same name/URL and same text: nothing to do
 */
export type IngestStatus = 'created' | 'updated' | 'unchanged';
export type IngestResult = DocumentInfo & { status: IngestStatus };

/** A retrieved chunk, numbered so the model can cite it as [n]. */
export interface Source {
  n: number;
  documentId: number;
  filename: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  page: number | null; // null for DOCX and web pages
  content: string;
  score: number; // cosine similarity, 1 = identical meaning
}

interface IngestInput {
  /** Shown in the document list and in citations. */
  name: string;
  /**
   * What identifies "the same document" when it is uploaded again: the file
   * name for uploads, the URL for web pages.
   */
  key: string;
  sourceType: SourceType;
  sourceUrl: string | null;
  pages: PageText[];
}

interface DocumentRow {
  id: number;
  filename: string;
  source_type: SourceType;
  source_url: string | null;
  page_count: number;
  chunk_count: number;
  content_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

/** How many chunks to embed per Ollama request. */
const EMBED_BATCH_SIZE = 16;

const DOCUMENT_COLUMNS =
  'id, filename, source_type, source_url, page_count, chunk_count, content_hash, created_at, updated_at';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ollama: OllamaService,
  ) {}

  /** An uploaded file. The type is decided by the file's bytes, not just its name. */
  async ingestFile(filename: string, data: Buffer): Promise<IngestResult> {
    let sourceType: SourceType;
    let pages: PageText[];

    if (data.subarray(0, 4).toString() === '%PDF') {
      sourceType = 'pdf';
      pages = await extractPdfPages(data);
    } else if (
      // A .docx is a ZIP archive, and every ZIP starts with "PK\x03\x04".
      data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
      filename.toLowerCase().endsWith('.docx')
    ) {
      sourceType = 'docx';
      pages = await extractDocxText(data);
    } else {
      throw new BadRequestException(
        'Only PDF and Word (.docx) files are supported. (Old .doc files: save as .docx first.)',
      );
    }

    return this.ingest({
      name: filename,
      key: filename,
      sourceType,
      sourceUrl: null,
      pages,
    });
  }

  /** A web page (or a link to a PDF / text file). */
  async ingestUrl(rawUrl: string): Promise<IngestResult> {
    const url = new URL(rawUrl);
    url.hash = ''; // page.html#section-2 is the same page as page.html
    const page = await extractWebPage(url.toString());
    return this.ingest({
      name: page.title,
      key: url.toString(),
      sourceType: page.type,
      sourceUrl: url.toString(),
      pages: page.pages,
    });
  }

  /**
   * The ingestion pipeline:
   *   text per page → chunks → embeddings → rows in pgvector
   *
   * Re-uploading a document with the same name (or URL) REPLACES its chunks
   * instead of adding a second copy. Duplicate chunks would fill the top-k
   * results with the same text twice, and old versions would give stale answers.
   */
  private async ingest(input: IngestInput): Promise<IngestResult> {
    const { name, key, sourceType, sourceUrl, pages } = input;

    // 1. Chunk each page (so every chunk keeps its page number)
    const chunks = pages.flatMap(({ page, text }) =>
      chunkText(text).map((content) => ({ page, content })),
    );
    if (chunks.length === 0) {
      throw new UnprocessableEntityException(
        sourceType === 'pdf'
          ? 'No text found in this PDF. Is it a scanned image? (It would need OCR.)'
          : 'No text found in this document.',
      );
    }

    // 2. Same name and same text as last time? Then there is nothing to do,
    //    and we skip the (slow) embedding step entirely.
    const contentHash = hashPages(pages);
    const [existing] = await this.db.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE source_key = $1 ORDER BY id LIMIT 1`,
      [key],
    );
    if (existing?.content_hash === contentHash) {
      this.logger.log(`"${name}" is unchanged, nothing to re-index`);
      return { ...toInfo(existing), status: 'unchanged' };
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

    // 4. Store everything in ONE transaction: if anything fails, the old
    //    version stays exactly as it was. Nobody ever sees a half-indexed document.
    const client = await this.db.pool.connect();
    let docId: number;
    let status: IngestStatus;
    try {
      await client.query('BEGIN');
      // Two uploads of the same file at the same moment: make the second wait.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

      const { rows: old } = await client.query<{ id: number }>(
        'SELECT id FROM documents WHERE source_key = $1 ORDER BY id',
        [key],
      );

      if (old.length > 0) {
        status = 'updated';
        docId = old[0].id;
        await client.query('DELETE FROM chunks WHERE document_id = $1', [
          docId,
        ]);
        // Remove extra copies uploaded by the earlier version of this app.
        await client.query(
          'DELETE FROM documents WHERE source_key = $1 AND id <> $2',
          [key, docId],
        );
        await client.query(
          `UPDATE documents
              SET filename = $2, source_type = $3, source_url = $4, page_count = $5,
                  chunk_count = $6, content_hash = $7, updated_at = now()
            WHERE id = $1`,
          [
            docId,
            name,
            sourceType,
            sourceUrl,
            pages.length,
            chunks.length,
            contentHash,
          ],
        );
      } else {
        status = 'created';
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO documents
             (filename, source_type, source_url, source_key, page_count, chunk_count, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            name,
            sourceType,
            sourceUrl,
            key,
            pages.length,
            chunks.length,
            contentHash,
          ],
        );
        docId = rows[0].id;
      }

      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO chunks (document_id, page, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [
            docId,
            chunks[i].page,
            i,
            chunks[i].content,
            toPgVector(embeddings[i]),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    this.logger.log(
      `${status === 'updated' ? 'Re-indexed' : 'Ingested'} "${name}": ` +
        `${pages.length} pages, ${chunks.length} chunks`,
    );
    const [row] = await this.db.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`,
      [docId],
    );
    return { ...toInfo(row), status };
  }

  async list(): Promise<DocumentInfo[]> {
    const rows = await this.db.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM documents ORDER BY updated_at DESC`,
    );
    return rows.map(toInfo);
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
      source_type: SourceType;
      source_url: string | null;
      page: number | null;
      content: string;
      score: number;
    }>(
      `SELECT c.document_id, d.filename, d.source_type, d.source_url, c.page, c.content,
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
      sourceType: r.source_type,
      sourceUrl: r.source_url,
      page: r.page,
      content: r.content,
      score: Number(r.score),
    }));
  }

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
}

/** Fingerprint of the extracted text. Same text → same hash. */
function hashPages(pages: PageText[]): string {
  const hash = createHash('sha256');
  for (const { page, text } of pages) hash.update(`${page}\n${text}\n\f\n`);
  return hash.digest('hex');
}

function toInfo(r: DocumentRow): DocumentInfo {
  return {
    id: r.id,
    filename: r.filename,
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    pageCount: r.page_count,
    chunkCount: r.chunk_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
