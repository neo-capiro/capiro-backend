/**
 * Phase 7 Workstream K — the Nest injection token for the override repository.
 *
 * Kept in its own module so `manual-override-service-v1.ts` stays free of Nest.
 * The promotion module's contracts are service-neutral on purpose: the Phase 8
 * handoff moves them into `apps/program-elements-service`, and a port that
 * imports `@nestjs/common` would have to be rewritten to go.
 */
export const MANUAL_OVERRIDE_REPOSITORY_V1 = Symbol('MANUAL_OVERRIDE_REPOSITORY_V1');
