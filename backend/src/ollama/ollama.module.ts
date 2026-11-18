import { Global, Module } from '@nestjs/common';
import { OllamaService } from './ollama.service';

// Global so any module can inject OllamaService without importing this module.
@Global()
@Module({
  providers: [OllamaService],
  exports: [OllamaService],
})
export class OllamaModule {}
