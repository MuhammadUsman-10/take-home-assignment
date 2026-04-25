import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString, IsNumber, IsArray, ValidateNested, IsOptional, Min,
} from 'class-validator';

export class BatchSyncItemDto {
  @ApiProperty({ example: 'emp-001' })
  @IsString()
  employeeId: string;

  @ApiProperty({ example: 'loc-nyc' })
  @IsString()
  locationId: string;

  @ApiProperty({ example: 'VACATION' })
  @IsString()
  leaveTypeId: string;

  @ApiProperty({ example: 15 })
  @IsNumber()
  @Min(0)
  totalDays: number;

  @ApiProperty({ example: 3 })
  @IsNumber()
  @Min(0)
  usedDays: number;
}

export class BatchSyncDto {
  @ApiProperty({ type: [BatchSyncItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchSyncItemDto)
  balances: BatchSyncItemDto[];

  @ApiProperty({ example: 'workday', required: false })
  @IsOptional()
  @IsString()
  source?: string;
}
