import { billStatusLabel } from '@capiro/shared';

/** Combined bill references are hearing events in the user-facing source facet. */
export function feedSourceTypes(types?: string[]) {
  return types?.includes('hearing') ? [...new Set([...types, 'combined'])] : types;
}

export function currentFeedBillStatus(row: {
  status: string | null; statusAt: Date | null; originChamber: string | null;
}) {
  if (!row.status) return null;
  const chamber = row.originChamber?.toLowerCase();
  return {
    label: row.status === 'passed_chamber' && (chamber === 'house' || chamber === 'senate')
      ? `Passed ${chamber === 'house' ? 'House' : 'Senate'}` : billStatusLabel(row.status),
    asOf: row.statusAt?.toISOString() ?? null,
  };
}
