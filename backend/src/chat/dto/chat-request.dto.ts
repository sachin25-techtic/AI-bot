import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
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

  /** (Phase 2) Answer from uploaded documents, with citations. */
  @IsOptional()
  @IsBoolean()
  useDocuments?: boolean;

  /** 0 = predictable, higher = more random. Omit for the default (0.7 chat, 0.1 documents). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;
}
