import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { Source } from '../documents/documents.service';
import { ChatMessage } from '../ollama/ollama.service';

/** A message as we store it: what the model saw, plus (for RAG answers) its sources. */
export type StoredMessage = ChatMessage & { sources?: Source[] };

/** One row in the sidebar. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

/** The provisional title: the start of the first question, until the LLM names the chat. */
const PROVISIONAL_TITLE_LENGTH = 60;

/**
 * Stores conversations and their messages in Postgres, so chat history
 * survives backend restarts (in-memory storage would lose it every time).
 *
 *   conversations (id, title, title_final, created_at, updated_at)
 *   messages      (id, conversation_id, role, content, sources, created_at)
 */
@Injectable()
export class ConversationStore {
  constructor(private readonly db: DatabaseService) {}

  /** Starts a conversation, titled with the start of its first question for now. */
  async create(firstMessage: string): Promise<string> {
    // Tidy up: conversations whose first reply failed are never shown, and
    // after a day nobody will come back to them.
    await this.db.query(
      `DELETE FROM conversations c
        WHERE c.created_at < now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
    );
    const [row] = await this.db.query<{ id: string }>(
      'INSERT INTO conversations (title) VALUES ($1) RETURNING id',
      [provisionalTitle(firstMessage)],
    );
    return row.id;
  }

  async exists(id: string): Promise<boolean> {
    const rows = await this.db.query(
      'SELECT 1 FROM conversations WHERE id = $1',
      [id],
    );
    return rows.length > 0;
  }

  /** Newest first. Conversations with no saved message yet are left out. */
  async list(): Promise<ConversationSummary[]> {
    const rows = await this.db.query<ConversationRow>(
      `SELECT c.id, c.title, c.created_at, c.updated_at
         FROM conversations c
        WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
        ORDER BY c.updated_at DESC
        LIMIT 500`,
    );
    return rows.map(toSummary);
  }

  async get(id: string): Promise<ConversationSummary | null> {
    const [row] = await this.db.query<ConversationRow>(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1',
      [id],
    );
    return row ? toSummary(row) : null;
  }

  /** The whole conversation, oldest first (what the UI shows). */
  async messages(id: string): Promise<StoredMessage[]> {
    return this.queryMessages(
      `SELECT role, content, sources FROM messages
        WHERE conversation_id = $1 ORDER BY id`,
      [id],
    );
  }

  /** Only the last `limit` messages, oldest first (what the model sees). */
  async recentMessages(id: string, limit: number): Promise<StoredMessage[]> {
    return this.queryMessages(
      `SELECT role, content, sources FROM (
         SELECT id, role, content, sources FROM messages
          WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
       ) recent ORDER BY id`,
      [id, limit],
    );
  }

  /** Saves a question and its answer together, and moves the chat to the top of the list. */
  async appendTurn(
    id: string,
    question: string,
    answer: string,
    sources?: Source[],
  ): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
        [id, question],
      );
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, sources)
         VALUES ($1, 'assistant', $2, $3::jsonb)`,
        // pg would turn a JS array into a Postgres array, so pass JSON text.
        [id, answer, sources ? JSON.stringify(sources) : null],
      );
      await client.query(
        'UPDATE conversations SET updated_at = now() WHERE id = $1',
        [id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** True while the chat still has its provisional title. */
  async needsTitle(id: string): Promise<boolean> {
    const rows = await this.db.query(
      'SELECT 1 FROM conversations WHERE id = $1 AND NOT title_final',
      [id],
    );
    return rows.length > 0;
  }

  /**
   * Sets the LLM-generated title. Does nothing if the user renamed the chat
   * in the meantime: a title the user chose always wins.
   */
  async setGeneratedTitle(id: string, title: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE conversations SET title = $2, title_final = true
        WHERE id = $1 AND NOT title_final RETURNING id`,
      [id, title],
    );
    return rows.length > 0;
  }

  async rename(id: string, title: string): Promise<ConversationSummary | null> {
    const [row] = await this.db.query<ConversationRow>(
      `UPDATE conversations SET title = $2, title_final = true WHERE id = $1
       RETURNING id, title, created_at, updated_at`,
      [id, title],
    );
    return row ? toSummary(row) : null;
  }

  /** Deletes the conversation and (ON DELETE CASCADE) all its messages. */
  async delete(id: string): Promise<boolean> {
    const rows = await this.db.query(
      'DELETE FROM conversations WHERE id = $1 RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  private async queryMessages(
    sql: string,
    params: unknown[],
  ): Promise<StoredMessage[]> {
    const rows = await this.db.query<{
      role: 'user' | 'assistant';
      content: string;
      sources: Source[] | null;
    }>(sql, params);
    return rows.map(({ role, content, sources }) =>
      sources ? { role, content, sources } : { role, content },
    );
  }
}

function provisionalTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length <= PROVISIONAL_TITLE_LENGTH
    ? oneLine
    : `${oneLine.slice(0, PROVISIONAL_TITLE_LENGTH - 1).trimEnd()}…`;
}

function toSummary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
