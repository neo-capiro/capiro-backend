export type PacCoverageStatus = 'unmapped' | 'pending' | 'partial' | 'error' | 'complete';

export type PacCoverage = {
  status: PacCoverageStatus;
  cycles: number[];
  lastSyncedAt: string | null;
  message: string;
};

type SyncState = {
  committeeId: string;
  cycle: number;
  status: string;
  completedAt: Date | null;
};

/** Missing sync evidence is never proof that a PAC made no contributions. */
export function pacCoverage(
  committeeIds: string[],
  cycles: number[],
  states: SyncState[],
  hasStoredRows: boolean,
): PacCoverage {
  const required = committeeIds.flatMap((id) => cycles.map((cycle) => `${id}:${cycle}`));
  const requiredSet = new Set(required);
  const relevant = states.filter((s) => requiredSet.has(`${s.committeeId}:${s.cycle}`));
  const byKey = new Map(relevant.map((s) => [`${s.committeeId}:${s.cycle}`, s]));
  const completed = relevant.flatMap((s) => s.completedAt ? [s.completedAt.getTime()] : []);
  const lastSyncedAt = completed.length ? new Date(Math.min(...completed)).toISOString() : null;
  let status: PacCoverageStatus;
  if (!committeeIds.length) status = 'unmapped';
  else if (relevant.some((s) => s.status === 'error')) status = 'error';
  else if (required.length && required.every((key) => {
    const state = byKey.get(key);
    return state?.status === 'complete' && state.completedAt !== null;
  })) status = 'complete';
  else if (hasStoredRows || completed.length) status = 'partial';
  else status = 'pending';

  const messages: Record<PacCoverageStatus, string> = {
    unmapped: 'No FEC committee is mapped to this client.',
    pending: 'PAC contributions have not finished syncing for this reporting period.',
    partial: 'PAC data is incomplete or has not yet been verified for this reporting period.',
    error: 'The latest PAC refresh failed. Previously synced data may still be shown.',
    complete: 'Contributions to federal candidates and committees, net of corrections.',
  };
  return { status, cycles, lastSyncedAt, message: messages[status] };
}
