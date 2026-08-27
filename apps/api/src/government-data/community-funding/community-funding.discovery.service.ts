import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { fetchDiscoveryPage } from './community-funding.discovery.js';
import type { Chamber } from './community-funding.types.js';

@Injectable()
export class CommunityFundingDiscoveryService {
  constructor(private readonly prisma: PrismaService) {}
  async discoverAndPersist(chamber: Chamber, fiscalYear: number) {
    const result = await fetchDiscoveryPage(chamber, fiscalYear);
    return this.prisma.$transaction(async tx => {
      const crawl = await tx.communityFundingDiscoveryCrawl.create({ data: { adapterId: result.adapterId, runKey: result.runKey,
        requestUrl: result.requestUrl, statusCode: result.statusCode, status: result.status, contentSha256: result.contentSha256,
        byteSize: result.byteSize, itemsSeen: result.itemsSeen, startedAt: result.startedAt, finishedAt: result.finishedAt,
        failureReason: result.failureReason } });
      for (const candidate of result.candidates) await tx.communityFundingDiscoveryCandidate.upsert({
        where: { adapterId_runKey_candidateUrl: { adapterId: result.adapterId, runKey: result.runKey, candidateUrl: candidate.url } },
        create: { crawlId: crawl.id, adapterId: result.adapterId, runKey: result.runKey, candidateUrl: candidate.url,
          title: candidate.title, resolution: candidate.resolution, reason: candidate.reason, emitted: candidate.resolution === 'accepted', fiscalYear, observedAt: result.finishedAt },
        update: { resolution: candidate.resolution, reason: candidate.reason, emitted: candidate.resolution === 'accepted', observedAt: result.finishedAt },
      });
      return { crawlId: crawl.id, ...result };
    });
  }
}
