import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { Phase8EvidenceService } from './evidence.service.js';
import { FloridaCurrentAuthorityService } from './florida-current-authority.service.js';
import { RetainedFloridaReadController } from './retained-florida-read.controller.js';
import { RETAINED_FLORIDA_PORTS, RetainedFloridaReadService, type RetainedFloridaPorts } from './retained-florida-read.service.js';

/** Existing TrackerModule does not export Phase8EvidenceService. The composer
 * must import its genuine provider owner; no duplicate chain or fake producer. */
function source(evidence: Phase8EvidenceService | undefined, ports: RetainedFloridaPorts | null): RetainedFloridaReadService | null {
  if (!ports || !(evidence instanceof Phase8EvidenceService)) return null;
  return new RetainedFloridaReadService(new FloridaCurrentAuthorityService(evidence), evidence, ports);
}

/** Intentionally absent from TrackerModule/AppModule. Bare/default import is503. */
@Module({
  controllers: [RetainedFloridaReadController],
  providers: [
    { provide: RETAINED_FLORIDA_PORTS, useValue: null },
    { provide: RetainedFloridaReadService, useFactory: source,
      inject: [{ token: Phase8EvidenceService, optional: true }, RETAINED_FLORIDA_PORTS] },
  ],
})
export class RetainedFloridaReadModule {
  static register(options: {
    imports?: ModuleMetadata['imports'];
    ports?: RetainedFloridaPorts | null;
  } = {}): DynamicModule {
    return { module: RetainedFloridaReadModule, imports: options.imports ?? [],
      providers: [{ provide: RETAINED_FLORIDA_PORTS, useValue: options.ports ?? null }] };
  }
}
