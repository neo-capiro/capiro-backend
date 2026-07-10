import { useQuery } from '@tanstack/react-query';
import type { AxiosInstance } from 'axios';
import { useApi } from '../../lib/use-api.js';

/**
 * Committee Chokepoint (Phase 1 M2.4/M2.5, PD3) — web client for
 * GET /api/intelligence/chokepoint/:billKey. Mirrors
 * apps/api/src/intelligence/chokepoint/chokepoint.types.ts.
 */
export interface ChokepointMember {
  id: string;
  name: string;
  chamber: string | null;
  party: string | null;
  role?: string | null;
}
export interface ChokepointCommittee {
  id: string;
  name: string;
  isSubcommittee?: boolean;
}
export interface CompanionStatus {
  relatedBillKey: string;
  relatedDisplay: string | null;
  status: string | null;
  linkType: string;
}
export interface StateDeadlineRisk {
  daysUntil: number;
  cutoffDate: string;
  cutoffType: 'committeeCutoff' | 'crossover' | 'secondCommitteeCutoff' | 'sineDie';
  isPastCutoff: boolean;
}
export interface FootprintOverlapEntry {
  memberId: string;
  memberName: string;
  memberRole: string;
  facilityId: string;
  facilityName: string;
}
export interface ChokepointResult {
  billKey: string;
  jurisdiction: 'federal' | 'state';
  referredCommittee: ChokepointCommittee | null;
  chair: ChokepointMember | null;
  viceChair: ChokepointMember | null;
  rankingMember: ChokepointMember | null;
  rulesGate: 'pending' | 'adopted' | 'failed' | null;
  chamberLeadership: ChokepointMember | null;
  sponsor: ChokepointMember | null;
  companionStatus: CompanionStatus | null;
  deadlineRisk: StateDeadlineRisk | null;
  survivalScore: number | null;
  survivalBand: 'stalled' | 'at-risk' | 'likely-advances' | null;
  survivalConfidence: 'normal' | 'low' | null;
  footprintOverlap: FootprintOverlapEntry[];
}

export async function getChokepoint(
  api: AxiosInstance,
  billKey: string,
  clientId?: string,
): Promise<ChokepointResult> {
  return (
    await api.get<ChokepointResult>(
      `/api/intelligence/chokepoint/${encodeURIComponent(billKey)}`,
      clientId ? { params: { clientId } } : undefined,
    )
  ).data;
}

export function useChokepoint(billKey: string | null, clientId?: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['chokepoint', billKey, clientId],
    queryFn: () => getChokepoint(api, billKey!, clientId),
    enabled: enabled && !!billKey,
  });
}
