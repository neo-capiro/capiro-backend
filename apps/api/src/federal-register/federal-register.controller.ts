import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FederalRegisterService } from './federal-register.service.js';

class DocumentsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['RULE', 'PROPOSED_RULE', 'NOTICE', 'PRESIDENTIAL_DOCUMENT'])
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  agency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  dateFrom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

class AgencyQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class EffectiveCalendarQueryDto {
  @IsString()
  @MaxLength(10)
  dateFrom!: string;

  @IsString()
  @MaxLength(10)
  dateTo!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * Federal Register documents API. Read-only, global data.
 */
@Controller('federal-register')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class FederalRegisterController {
  constructor(private readonly service: FederalRegisterService) {}

  @Get('documents')
  listDocuments(@Query() q: DocumentsQueryDto) {
    return this.service.listDocuments({
      type: q.type,
      agency: q.agency,
      topic: q.topic,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      page: q.page,
      limit: q.limit,
    });
  }

  @Get('upcoming-deadlines')
  upcomingDeadlines() {
    return this.service.getUpcomingDeadlines(30);
  }

  @Get('effective-date-calendar')
  effectiveDateCalendar(@Query() query: EffectiveCalendarQueryDto) {
    return this.service.getEffectiveDateCalendar(query);
  }

  @Get('comment-deadline-calendar')
  commentDeadlineCalendar(@Query() query: EffectiveCalendarQueryDto) {
    return this.service.getCommentDeadlineCalendar(query);
  }

  @Get('by-agency/:agencyName')
  byAgency(@Param('agencyName') agencyName: string, @Query() q: AgencyQueryDto) {
    return this.service.getByAgency(decodeURIComponent(agencyName), q.page, q.limit);
  }

  @Get('documents/:documentNumber')
  getDocument(@Param('documentNumber') documentNumber: string) {
    return this.service.getDocument(documentNumber);
  }
}
