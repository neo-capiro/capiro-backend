import { Module } from '@nestjs/common';
import { Phase17RuntimeRegistryService } from './phase1-7-runtime.service.js';

/**
 * Dark Session 4 composition boundary. It registers no controller, route,
 * schedule, parser worker, promotion executor or snapshot activator.
 */
@Module({
  providers: [Phase17RuntimeRegistryService],
  exports: [Phase17RuntimeRegistryService],
})
export class Phase17RuntimeModule {}
