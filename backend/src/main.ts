import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // All routes live under /api (e.g. POST /api/chat)
  app.setGlobalPrefix('api');

  // The Next.js app runs on a different port, so the browser needs CORS.
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000',
  });

  // Validate request bodies against the DTO classes (class-validator).
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`Backend listening on http://localhost:${port}/api`);
}
void bootstrap();
