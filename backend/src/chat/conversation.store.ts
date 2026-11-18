import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Source } from '../documents/documents.service';
import { ChatMessage } from '../ollama/ollama.service';

/** A message as we store it: what the model saw, plus (for RAG answers) its sources. */
export type StoredMessage = ChatMessage & { sources?: Source[] };

/**
 * Keeps each conversation's message history in memory, keyed by conversation id.
 *
 * Kept deliberately simple: history is lost when the backend restarts.
 * Swapping this for a database table later would not change anything else.
 */
@Injectable()
export class ConversationStore {
  private readonly conversations = new Map<string, StoredMessage[]>();

  create(): string {
    const id = randomUUID();
    this.conversations.set(id, []);
    return id;
  }

  has(id: string): boolean {
    return this.conversations.has(id);
  }

  get(id: string): StoredMessage[] {
    return this.conversations.get(id) ?? [];
  }

  append(id: string, message: StoredMessage): void {
    const history = this.conversations.get(id) ?? [];
    history.push(message);
    this.conversations.set(id, history);
  }

  delete(id: string): void {
    this.conversations.delete(id);
  }
}
