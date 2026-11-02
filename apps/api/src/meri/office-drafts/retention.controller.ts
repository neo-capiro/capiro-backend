import { Body, Controller, ForbiddenException, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { InternalServiceGuard, hasInternalServiceIdentity } from '../../auth/internal-service.guard.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { expireOfficeDrafts } from './retention.js';
import { readOfficeDraftRetention, retireOfficeDrafts } from './retention-subject.js';
@Controller('internal/office-draft-retention')
@UseGuards(InternalServiceGuard)
export class OfficeDraftRetentionController {
  constructor(private readonly prisma: PrismaService) {}
  @Post('read') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  read(@Body() body: unknown, @Req() req: Request) {
    if (!hasInternalServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
    return readOfficeDraftRetention(this.prisma, body);
  }
  @Post('retire') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  retire(@Body() body: unknown, @Req() req: Request) {
    if (!hasInternalServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
    return retireOfficeDrafts(this.prisma, body);
  }
  @Post('expire') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  expire(@Body() body: unknown, @Req() req: Request) {
    if (!hasInternalServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
    return expireOfficeDrafts(this.prisma, body);
  }
}
