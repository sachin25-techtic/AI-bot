import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ConversationStore } from './conversation.store';

class RenameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title!: string;
}

/**
 * The chat history behind the sidebar.
 * (New conversations are created by POST /api/chat with no conversationId.)
 *
 *   GET    /api/conversations       → [{ id, title, createdAt, updatedAt }], newest first
 *   GET    /api/conversations/:id   → { id, title, ..., messages: [...] }
 *   PATCH  /api/conversations/:id   { title } → rename
 *   DELETE /api/conversations/:id   → delete it and its messages
 */
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly store: ConversationStore) {}

  @Get()
  list() {
    return this.store.list();
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const conversation = await this.store.get(id);
    if (!conversation) throw new NotFoundException('Conversation not found');
    return { ...conversation, messages: await this.store.messages(id) };
  }

  @Patch(':id')
  async rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RenameDto,
  ) {
    const title = body.title.replace(/\s+/g, ' ').trim();
    if (!title) throw new NotFoundException('Title cannot be empty');
    const conversation = await this.store.rename(id, title);
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.store.delete(id))) {
      throw new NotFoundException('Conversation not found');
    }
  }
}
