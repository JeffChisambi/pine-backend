import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SupportTicketCategory, SupportTicketStatus } from '@prisma/client';

/** Customer opens a new support ticket ("Report a problem"). */
export class CreateSupportTicketDto {
  @ApiProperty({ enum: SupportTicketCategory, example: SupportTicketCategory.DEPOSITS })
  @IsEnum(SupportTicketCategory)
  category: SupportTicketCategory;

  @ApiProperty({ example: 'Deposit not reflected in wallet' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  subject: string;

  @ApiProperty({ example: 'I paid K50,000 with my Visa card but my balance has not changed.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;

  @ApiPropertyOptional({ description: 'Related wallet transaction id, if any.' })
  @IsOptional()
  @IsUUID()
  relatedTransactionId?: string;
}

/** Customer or admin appends a message to an existing thread. */
export class ReplySupportTicketDto {
  @ApiProperty({ example: 'Any update on this?' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message: string;
}

/** Admin changes a ticket's status. */
export class UpdateSupportStatusDto {
  @ApiProperty({ enum: SupportTicketStatus, example: SupportTicketStatus.IN_REVIEW })
  @IsEnum(SupportTicketStatus)
  status: SupportTicketStatus;
}

/** Admin inbox list filters. */
export class ListSupportTicketsQueryDto {
  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ description: 'Only tickets awaiting a staff reply.' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  awaitingAdmin?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
