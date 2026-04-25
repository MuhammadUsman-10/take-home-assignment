import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ReviewTimeOffRequestDto {
  @ApiProperty({ required: false, example: 'Approved — enjoy your time off!' })
  @IsOptional()
  @IsString()
  notes?: string;
}
