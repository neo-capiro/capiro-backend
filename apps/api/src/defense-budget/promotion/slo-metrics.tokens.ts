/**
 * Phase 7 Gap 5 decision C — the Nest injection token for the SLO recorder.
 *
 * Kept in its own module, same reasoning as `snapshot-read-port.tokens.ts` and
 * `manual-override.tokens.ts`: `slo-metrics-v1.ts` stays free of Nest so the
 * Phase 8 handoff can move it into `apps/program-elements-service` without a
 * rewrite. A port that imported `@nestjs/common` would have to be rewritten to
 * go.
 */
export const SLO_METRIC_RECORDER_V1 = Symbol('SLO_METRIC_RECORDER_V1');
