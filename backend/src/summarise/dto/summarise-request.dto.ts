import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class SummariseRequestDto {
  /** ~20,000 characters ≈ 5,000 tokens: fits comfortably in the model's context window. */
  @IsString()
  @IsNotEmpty()
  @MinLength(50, {
    message: 'Give at least 50 characters of text to summarise',
  })
  @MaxLength(20000)
  text!: string;
}
