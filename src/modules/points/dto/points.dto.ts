import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';
import { KNOWN_LESSON_IDS } from '../services/claims.service';

export class RulesQueryDto {
  @ApiPropertyOptional({ enum: ['en', 'ny'], default: 'en' })
  @IsOptional()
  @IsIn(['en', 'ny'])
  lang?: 'en' | 'ny';
}

export class LeaderboardQueryDto {
  @ApiPropertyOptional({ description: 'Season slug; defaults to the open season.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  season?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class HistoryQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Skip this many rows (newest first).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Deliberately carries no timestamp. The server measures how long ago the
 * notification was delivered using its own clock, so there is nothing here
 * for a tampered device clock to influence.
 */
export class NotificationOpenClaimDto {
  @ApiProperty({ description: 'The notification that was just opened.' })
  @IsUUID()
  notificationId!: string;
}

export class LessonClaimDto {
  @ApiProperty({ enum: KNOWN_LESSON_IDS, description: 'Lesson slug from the content pack.' })
  @IsIn(KNOWN_LESSON_IDS as unknown as string[])
  lessonId!: string;
}

export class CompareClaimDto {
  @ApiProperty({ example: 'NBM' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  symbolA!: string;

  @ApiProperty({ example: 'TNM' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  symbolB!: string;
}

export class AdminLeaderboardQueryDto extends LeaderboardQueryDto {
  @ApiPropertyOptional({ description: 'Match on name, phone or email.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class AdjustPointsDto {
  @ApiProperty({ description: 'Points to add; negative removes them.', example: -50 })
  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  @Min(-100000)
  @Max(100000)
  points!: number;

  @ApiProperty({ description: 'Why. Recorded in the audit log.', minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
