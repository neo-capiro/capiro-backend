import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CommunityFundingDiscoveryService } from './community-funding.discovery.service.js';
import { CommunityFundingUpsertService } from './community-funding.upsert.service.js';

@Module({ providers: [PrismaService, CommunityFundingUpsertService, CommunityFundingDiscoveryService], exports: [CommunityFundingUpsertService, CommunityFundingDiscoveryService] })
export class CommunityFundingModule {}
