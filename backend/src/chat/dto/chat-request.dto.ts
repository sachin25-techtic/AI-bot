import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class ChatRequestDto {
  /** Omit on the first message; the server creates a conversation and returns its id. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  message!: string;

  /** (Phase 2) Answer from uploaded PDFs, with citations. */
  @IsOptional()
  @IsBoolean()
  useDocuments?: boolean;
}
