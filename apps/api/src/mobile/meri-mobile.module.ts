import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { MeriModule } from '../meri/meri.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MeriMobileController } from './meri-mobile.controller.js';
import { MeriMobileService } from './meri-mobile.service.js';

@Module({
  imports: [PrismaModule, EngagementModule, MeriModule],
  controllers: [MeriMobileController],
  providers: [MeriMobileService],
})
export class MeriMobileModule {}
