import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsDateString, IsNumber, Min, IsOptional, IsUUID, Length,
} from 'class-validator';

export class CreateTimeOffRequestDto {
  @ApiProperty({ example: 'emp-001', description: 'HCM employee ID' })
  @IsString()
  employeeId: string;

  @ApiProperty({ example: 'loc-nyc', description: 'HCM location ID' })
  @IsString()
  locationId: string;

  @ApiProperty({ example: 'VACATION', description: 'HCM leave type ID' })
  @IsString()
  leaveTypeId: string;

  @ApiProperty({ example: '2026-06-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2026-06-05' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ example: 5, description: 'Number of business days requested' })
  @IsNumber()
  @Min(0.5)
  days: number;

  @ApiProperty({
    example: 'req-2026-vacation-001',
    description: 'Client-supplied idempotency key — same key returns same result',
  })
  @IsString()
  @Length(1, 255)
  idempotencyKey: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
