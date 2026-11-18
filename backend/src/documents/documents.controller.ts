import {
  BadRequestException,
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
import { DocumentsService } from './documents.service';

const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Step 1 of RAG: upload. multipart/form-data with a `file` field. */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PDF_BYTES } }),
  )
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Send a PDF in the "file" field');
    // Check the file's actual bytes, not just its name: every PDF starts with "%PDF".
    if (file.buffer.subarray(0, 4).toString() !== '%PDF') {
      throw new BadRequestException('Only PDF files are supported');
    }
    // Multer decodes the filename as latin1; convert it so non-ASCII names survive.
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.documents.ingest(filename, file.buffer);
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
