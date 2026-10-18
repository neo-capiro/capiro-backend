import { Module } from '@nestjs/common';
import { ApplicationAuthorityModule } from './application-authority.module.js';
import { ApplicationReadModeObservationController } from './application-read-mode-observation.controller.js';
import { ApplicationReadModeObservationService } from './application-read-mode-observation.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

/** Meri evidence-mode projection over the native membership owner. It is a
 * sibling of ApplicationAuthorityModule, not part of it: resolving the tenant's
 * evidence-accuracy mode uses the @capiro/meriv2-core rollout configuration,
 * which the authority runtime boundary forbids. The route, guard and current
 * membership rechecks are unchanged. */
@Module({
  imports: [ApplicationAuthorityModule],
  controllers: [ApplicationReadModeObservationController],
  providers: [ApplicationReadModeObservationService, ToolServiceSecretGuard],
})
export class ApplicationReadModeObservationModule {}
