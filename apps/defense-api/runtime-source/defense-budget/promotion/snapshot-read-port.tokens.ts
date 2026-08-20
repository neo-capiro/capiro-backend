/**
 * Phase 7 Workstream M — the Nest injection token for the snapshot read port.
 *
 * Kept in its own module, same reasoning as `manual-override.tokens.ts`:
 * `snapshot-read-repository-v1.ts` stays free of Nest/Prisma so the Phase 8
 * handoff can move it into `apps/program-elements-service` without a rewrite.
 */
export const SNAPSHOT_READ_PORT_V1 = Symbol('SNAPSHOT_READ_PORT_V1');
