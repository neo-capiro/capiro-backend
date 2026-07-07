import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { InternalOnboardingController } from './internal-onboarding.controller.js';
import { InternalOnboardingService } from './internal-onboarding.service.js';

/**
 * Self-service onboarding's internal provisioning surface (onboarding v1).
 * One InternalServiceGuard-gated endpoint used by apps/onboard-api; the
 * tenant/org creation mirrors the staff path in CapiroAdminService.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [InternalOnboardingController],
  providers: [InternalOnboardingService],
})
export class InternalOnboardingModule {}
