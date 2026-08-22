import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Defense-in-depth: global canonical transcript routes are public-record only. */
@Injectable()
export class LiveHearingsPhase7PublicGuard {
  constructor(private readonly prisma: PrismaService) {}

  async assertPublic(hearingId: string): Promise<void> {
    const hearing = await this.prisma.committeeHearing.findUnique({
      where: { id: hearingId },
      select: { id: true, visibility: true },
    });
    if (!hearing) throw new NotFoundException(`hearing ${hearingId} not found`);
    if (hearing.visibility !== 'public') {
      throw new ForbiddenException('Canonical public transcript is unavailable for a non-public proceeding.');
    }
  }
}
