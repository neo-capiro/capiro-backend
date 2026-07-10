import { Module } from '@nestjs/common';
import { RepresentationResolverService } from './representation-resolver.service.js';
import { RepresentationController } from './representation.controller.js';

/**
 * District Impact Engine (Phase 1 M1.3) — `RepresentationResolverService`
 * lives in its OWN module (not folded into `ClientsModule`) so both
 * `ClientsModule` and `DirectoryModule` can depend on it without a
 * circular import (`ClientsModule` already imports `DirectoryModule` for
 * the Facilities tab's directory cross-links). M2's `ChokepointService` and
 * M5's targeting-brief worker import this module too (PD2/PD7 — one
 * deterministic resolver, shared everywhere a representation claim is made).
 */
@Module({
  controllers: [RepresentationController],
  providers: [RepresentationResolverService],
  exports: [RepresentationResolverService],
})
export class RepresentationModule {}
