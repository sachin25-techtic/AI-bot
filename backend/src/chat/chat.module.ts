import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationStore } from './conversation.store';

@Module({
  imports: [DocumentsModule],
  controllers: [ChatController],
  providers: [ChatService, ConversationStore],
})
export class ChatModule {}
