import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsUrl } from 'class-validator';
import { DocumentsService } from './documents.service';

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

class AddUrlDto {
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Enter a full web address starting with http:// or https://' },
  )
  url!: string;
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * Step 1 of RAG: upload. multipart/form-data with a `file` field (PDF or DOCX).
   * Uploading a file with the same name again replaces the old version.
   * Response includes `status`: "created" | "updated" | "unchanged".
   */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Send a PDF or DOCX in the "file" field');
    }
    // Multer decodes the filename as latin1; convert it so non-ASCII names survive.
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.documents.ingestFile(filename, file.buffer);
  }

  /** Index a web page: { "url": "https://..." }. Adding the same URL again re-indexes it. */
  @Post('url')
  addUrl(@Body() body: AddUrlDto) {
    return this.documents.ingestUrl(body.url);
  }

  @Get()
  list() {
    return this.documents.list();
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.documents.remove(id);
  }
}
