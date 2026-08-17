export type DefenseDomainAvailability = 'available' | 'unavailable';

export interface ReadinessSignals {
  readonly configValid: boolean;
  readonly databaseReachable: boolean;
  readonly databaseRoleAuthorized: boolean;
  readonly activeSnapshotId: string | null;
  readonly cutoverMode: 'dark' | 'strict';
}

export interface DefenseReadinessDecision {
  readonly ready: boolean;
  readonly httpStatus: 200 | 503;
  readonly domainAvailability: DefenseDomainAvailability;
  readonly reasons: readonly string[];
}

export function decideDefenseReadiness(
  signals: ReadinessSignals,
): DefenseReadinessDecision {
  const reasons: string[] = [];
  if (!signals.configValid) reasons.push('config_invalid');
  if (!signals.databaseReachable) reasons.push('database_unreachable');
  if (signals.databaseReachable && !signals.databaseRoleAuthorized) {
    reasons.push('database_role_unauthorized');
  }

  const infrastructureReady =
    signals.configValid &&
    signals.databaseReachable &&
    signals.databaseRoleAuthorized;

  const domainAvailability: DefenseDomainAvailability = signals.activeSnapshotId
    ? 'available'
    : 'unavailable';

  if (!signals.activeSnapshotId) reasons.push('active_snapshot_unavailable');

  const ready =
    infrastructureReady &&
    (signals.cutoverMode === 'dark' || domainAvailability === 'available');

  return {
    ready,
    httpStatus: ready ? 200 : 503,
    domainAvailability,
    reasons,
  };
}
