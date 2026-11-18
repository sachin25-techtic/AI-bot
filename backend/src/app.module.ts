import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatModule } from './chat/chat.module';
import { DatabaseModule } from './database/database.module';
import { DocumentsModule } from './documents/documents.module';
import { OllamaModule } from './ollama/ollama.module';

@Module({
  imports: [
    // Loads backend/.env into process.env and exposes ConfigService everywhere.
    ConfigModule.forRoot({ isGlobal: true }),
    OllamaModule,
    ChatModule,
    // Phase 2 (RAG)
    DatabaseModule,
    DocumentsModule,
  ],
})
export class AppModule {}
