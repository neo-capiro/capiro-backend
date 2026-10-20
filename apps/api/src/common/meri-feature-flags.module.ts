import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MeriFeatureFlagsService } from '../meri/meri-feature-flags.service.js';

/** One existing tenant-flag cache per Nest application, without agent runtime DI. */
@Module({
  imports: [PrismaModule],
  providers: [MeriFeatureFlagsService],
  exports: [MeriFeatureFlagsService],
})
export class MeriFeatureFlagsModule {}
