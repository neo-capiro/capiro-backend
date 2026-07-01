import { Global, Module } from '@nestjs/common';
import { FeatureFlagService } from './feature-flag.service.js';
import { FeatureFlagController } from './feature-flag.controller.js';
import { HearingWatchFeatureGuard } from './hearing-watch-feature.guard.js';

/**
 * Global so the HearingWatchFeatureGuard + FeatureFlagService can be injected
 * anywhere (the hearing module's controller/gateway gate on it).
 */
@Global()
@Module({
  controllers: [FeatureFlagController],
  providers: [FeatureFlagService, HearingWatchFeatureGuard],
  exports: [FeatureFlagService, HearingWatchFeatureGuard],
})
export class FeatureFlagsModule {}
