import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { MeriFeatureFlagsModule } from '../common/meri-feature-flags.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MeriMobileController } from './meri-mobile.controller.js';
import { MeriMobileService } from './meri-mobile.service.js';

@Module({
  imports: [PrismaModule, EngagementModule, MeriFeatureFlagsModule],
  controllers: [MeriMobileController],
  providers: [MeriMobileService],
})
export class MeriMobileModule {}
