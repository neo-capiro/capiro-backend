import type { DefenseCoverageRecordedOutcomeDto } from '@capiro/shared';
import { EXPECTED_SOURCE_STATES, OBSERVATION_STATES } from '@capiro/defense-domain';

const SOURCE_STATES: ReadonlySet<string> = new Set(EXPECTED_SOURCE_STATES);
const RESOLUTION_STATES = new Set([
  'expected',
  'not_filed',
  'published',
  'withdrawn',
  'unavailable',
]);
const REVISION_KINDS = new Set([
  'first_discovery',
  'unchanged',
  'changed',
  'replacement_url',
  'superseding_version',
]);
const OBSERVED_STATES: ReadonlySet<string> = new Set(OBSERVATION_STATES);

type Observation = { observationState: string; revisionKind?: string; lastSeenAt?: Date };
type Resolution = { decision: string; resolvedAt: Date };

/** Public state and current-tenant audit outcome are deliberately separate. */
export function coverageRecordedOutcome(
  source: { expectedState?: string; observations: Observation[] },
  resolution: Resolution | undefined,
): DefenseCoverageRecordedOutcomeDto {
  const observed = source.observations
    .filter((row) => row.lastSeenAt instanceof Date && Number.isFinite(row.lastSeenAt.getTime()))
    .sort((a, b) => b.lastSeenAt!.getTime() - a.lastSeenAt!.getTime())[0];
  const validObservation =
    observed &&
    OBSERVED_STATES.has(observed.observationState) &&
    REVISION_KINDS.has(observed.revisionKind ?? '');
  const validResolution =
    resolution &&
    RESOLUTION_STATES.has(resolution.decision) &&
    resolution.resolvedAt instanceof Date &&
    Number.isFinite(resolution.resolvedAt.getTime());
  return {
    sourceState: SOURCE_STATES.has(source.expectedState ?? '') ? source.expectedState! : null,
    lastObservation: validObservation
      ? {
          state: observed.observationState,
          revisionKind: observed.revisionKind!,
          observedAt: observed.lastSeenAt!.toISOString(),
        }
      : null,
    lastGovernedResolution: validResolution
      ? {
          decision: resolution.decision as NonNullable<
            DefenseCoverageRecordedOutcomeDto['lastGovernedResolution']
          >['decision'],
          resolvedAt: resolution.resolvedAt.toISOString(),
        }
      : null,
    reason: !validResolution
      ? 'No recorded governed resolution is available to the current tenant; observed source state is not proof of a recheck.'
      : !validObservation
        ? 'No source observation outcome is recorded for this catalog slot.'
        : null,
  };
}
