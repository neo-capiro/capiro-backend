import {
  createMeriResultEnvelope,
  isValidCanonicalId,
  normalizeCanonicalId,
  type MeriResultEnvelope,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
}

function optionalString(input: RecordValue, key: string, max: number): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function federalCommitteeChamberMatches(id: string, chamber: unknown): boolean {
  const chamberByPrefix: Record<string, string> = { h: 'house', s: 'senate', j: 'joint' };
  return typeof chamber === 'string' &&
    (chamber === 'house' || chamber === 'senate' || chamber === 'joint') &&
    chamberByPrefix[id[0] ?? ''] === chamber;
}

function rolePointersMatchMembers(
  result: RecordValue,
  members: readonly unknown[],
  jurisdiction: string | null,
): boolean {
  const byId = new Map<string, RecordValue>();
  for (const raw of members) {
    const member = record(raw);
    if (member && typeof member.id === 'string') byId.set(member.id, member);
  }

  for (const field of ['chair', 'viceChair', 'rankingMember']) {
    const pointer = result[field];
    if (jurisdiction === 'state' && field === 'rankingMember') {
      if (pointer !== null) return false;
      continue;
    }
    if (pointer === null) continue;
    const pointedMember = record(pointer);
    if (!pointedMember || typeof pointedMember.id !== 'string' ||
        typeof pointedMember.name !== 'string') return false;
    const listedMember = byId.get(pointedMember.id);
    if (!listedMember) return false;
    const pointerKeys = Object.keys(pointedMember).sort();
    const memberKeys = Object.keys(listedMember).sort();
    if (pointerKeys.length !== memberKeys.length ||
        pointerKeys.some((key, index) => key !== memberKeys[index])) return false;
    if (pointerKeys.some((key) => {
      const pointerValue = pointedMember[key];
      const memberValue = listedMember[key];
      const primitive = (value: unknown) => value === null ||
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      return !primitive(pointerValue) || !primitive(memberValue) || pointerValue !== memberValue;
    })) return false;
  }
  return true;
}

/**
 * Dormant observation of the legacy federal/state committee roster read.
 * Coverage describes returned local membership rows only. Federal joins may
 * drop rows without a matching member record; neither rail proves seating or
 * current membership, and generatedAt is not source freshness.
 */
export function envelopeCommitteeRosterResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const result = record(legacyPayload);
  const committeeQuery = optionalString(request, 'committee', 200);
  const jurisdiction = optionalString(request, 'jurisdiction', 10)?.toLowerCase() ?? null;
  const chamber = optionalString(request, 'chamber', 10)?.toLowerCase() ?? null;
  // This mirrors optionalString(state, 2) followed by uppercase. It is an
  // applied filter, not evidence that the value is a recognized state code.
  const state = optionalString(request, 'state', 2)?.toUpperCase() ?? null;
  const validJurisdiction = jurisdiction === 'federal' || jurisdiction === 'state';
  const queried = Boolean(committeeQuery && validJurisdiction &&
    (jurisdiction !== 'state' || state));
  const sourceId = jurisdiction === 'state' ? 'state_committee_membership' : 'congress_committee_membership';
  const scope = {
    storage: 'capiro_local_database',
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(committeeQuery ? { committeeQuery } : {}),
    ...(jurisdiction === 'state' && state ? { state } : {}),
    ...(chamber ? { chamber } : {}),
  };

  if (!queried) {
    return createMeriResultEnvelope({
      outcome: 'needs_input', legacyPayload,
      sources: [{ family: 'legislative', sourceId, availability: 'not_queried', scope,
        observedAt: null, coverage: { completeness: 'unknown', matchedCount: null }, provenance: [] }],
    });
  }

  const committee = record(result?.committee);
  const expectedTool = result?.tool === 'get_committee_roster';
  const resolved = expectedTool && committee !== null &&
    committee.jurisdiction === jurisdiction && typeof committee.id === 'string' &&
    committee.id.trim().length > 0 && typeof committee.name === 'string' &&
    committee.name.trim().length > 0 &&
    (jurisdiction !== 'federal' ||
      normalizeCanonicalId('committee', committee.id) === committee.id &&
      isValidCanonicalId('committee', committee.id) &&
      federalCommitteeChamberMatches(committee.id, committee.chamber)) &&
    (!chamber || committee.chamber === chamber);

  const members = Array.isArray(result?.members) ? result.members : null;
  const validMembers = members !== null && members.every((raw) => {
    const member = record(raw);
    if (!member || typeof member.id !== 'string' || !member.id.trim() ||
        typeof member.name !== 'string' || !member.name.trim()) return false;
    if (jurisdiction === 'federal') {
      const id = normalizeCanonicalId('bioguide', member.id);
      return id === member.id && isValidCanonicalId('bioguide', id);
    }
    return true;
  });
  const memberIds = validMembers ? members!.map((raw) => (raw as RecordValue).id as string) : [];
  const rowsConsistent = validMembers && new Set(memberIds).size === memberIds.length;
  const pointersConsistent = result !== null && members !== null &&
    rolePointersMatchMembers(result, members, jurisdiction);
  const identityKnown = resolved && rowsConsistent && pointersConsistent;
  const provenance = identityKnown && jurisdiction === 'federal'
    ? memberIds.map((recordId) => ({ recordId, sourceId: 'congress_member' }))
    : [];

  return createMeriResultEnvelope({
    outcome: identityKnown ? 'succeeded' : 'partial',
    legacyPayload,
    sources: [{
      family: 'legislative', sourceId, availability: expectedTool ? 'available' : 'unknown', scope,
      observedAt: null,
      coverage: {
        // Federal person joins can remove memberships before they reach this payload.
        completeness: identityKnown && members!.length > 0 ? 'partial' : 'unknown',
        ...(members ? { returnedCount: members.length } : {}),
        matchedCount: null,
      },
      provenance,
    }],
    truncation: { truncated: false },
    errors: identityKnown ? [] : [{ code: 'committee_roster_observation_unverified' }],
  });
}

/** Observe a successful legacy call without changing its result or rejection. */
export async function observeCommitteeRosterResult<T extends RecordValue>(
  call: () => Promise<T>,
  request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeCommitteeRosterResult(legacyPayload, request)));
  return legacyPayload;
}
