import {
  createMeriResultEnvelope,
  isValidCanonicalId,
  normalizeCanonicalId,
  type MeriResultEnvelope,
  type MeriResultProvenance,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Dormant adapter for the local roll-call search. Completeness refers only to
 * the bounded database query, never to the upstream vote feeds or sync recency.
 */
export function envelopeFloorVotesResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const rawBillId = typeof request.billId === 'string' ? request.billId.trim() : '';
  const billId = rawBillId ? normalizeCanonicalId('billId', rawBillId) : null;
  const billScopeKnown = !rawBillId || billId !== null && isValidCanonicalId('billId', billId);
  const rawMember = typeof request.member === 'string' ? request.member.trim() : '';
  const member = record(legacyPayload.member);
  const canonicalMember = rawMember ? normalizeCanonicalId('bioguide', rawMember) : null;
  const memberScopeKnown = !rawMember
    ? member === null && !Object.prototype.hasOwnProperty.call(legacyPayload, 'member')
    : typeof member?.bioguideId === 'string' &&
      typeof member.fullName === 'string' && member.fullName.length > 0 &&
      (!canonicalMember || !isValidCanonicalId('bioguide', canonicalMember) ||
        member.bioguideId === canonicalMember);
  const chamber = typeof request.chamber === 'string' ? request.chamber.trim().toLowerCase() : '';
  const chamberKnown = !chamber || chamber === 'house' || chamber === 'senate';
  const congress = request.congress == null ? null : positiveInteger(request.congress);
  const congressKnown = request.congress == null || congress !== null;
  const limitInput = request.limit == null ? 10 : positiveInteger(request.limit);
  const limit = limitInput === null ? null : Math.min(25, limitInput);
  const scope = {
    storage: 'capiro_local_database',
    ...(billScopeKnown && billId ? { billId } : {}),
    ...(congress !== null ? { congress } : {}),
    ...(chamberKnown && chamber ? { chamber } : {}),
    ...(typeof request.query === 'string' && request.query.trim()
      ? { query: request.query.trim().slice(0, 200) } : {}),
    ...(memberScopeKnown && member ? { memberBioguideId: member.bioguideId as string } : {}),
    ...(limit !== null ? { limit } : {}),
  };

  const unresolved = legacyPayload.tool === 'search_floor_votes' &&
    (legacyPayload.resolution === 'needs_context' || rawMember && !member);
  if (unresolved) {
    return createMeriResultEnvelope({
      outcome: 'needs_input', legacyPayload,
      sources: [{
        family: 'legislative', sourceId: 'roll_call_vote', availability: 'not_queried',
        scope, observedAt: null, coverage: { completeness: 'unknown', matchedCount: null },
        provenance: [],
      }],
    });
  }

  const votes = Array.isArray(legacyPayload.votes) ? legacyPayload.votes : null;
  const rowsValid = votes !== null && votes.every((value) => {
    const vote = record(value);
    const memberVotes = member
      ? Array.isArray(vote?.memberVotes) && vote.memberVotes.length > 0
      : true;
    return typeof vote?.id === 'string' && vote.id.length > 0 &&
      (!billId || vote.billId === billId) &&
      (!chamberKnown || !chamber || vote.chamber === chamber) &&
      (congress === null || vote.congress === congress) && memberVotes;
  });
  const identityKnown = legacyPayload.tool === 'search_floor_votes' && billScopeKnown &&
    memberScopeKnown && chamberKnown && congressKnown && limit !== null && rowsValid &&
    legacyPayload.votesFound === votes!.length && votes!.length <= limit;
  const atCap = identityKnown && votes!.length === limit;
  const provenance: MeriResultProvenance[] = identityKnown
    ? votes!.map((value) => {
      const vote = value as RecordValue;
      return {
        recordId: vote.id as string, sourceId: 'roll_call_vote',
        ...(typeof vote.sourceUrl === 'string' && /^https?:\/\//i.test(vote.sourceUrl)
          ? { url: vote.sourceUrl } : {}),
      };
    }) : [];
  return createMeriResultEnvelope({
    outcome: identityKnown
      ? atCap ? 'partial' : votes!.length === 0 ? 'not_found_within_scope' : 'succeeded'
      : 'partial',
    legacyPayload,
    sources: [{
      family: 'legislative', sourceId: 'roll_call_vote',
      availability: identityKnown ? 'available' : 'unknown', scope, observedAt: null,
      coverage: {
        completeness: identityKnown ? atCap ? 'partial' : 'complete' : 'unknown',
        ...(identityKnown && !atCap ? { continuation: { hasMore: false } } : {}),
        ...(rowsValid ? { returnedCount: votes!.length } : {}),
        matchedCount: identityKnown && !atCap ? votes!.length : null,
      },
      provenance,
    }],
    // The exact limit leaves possible additional rows unknown; it does not
    // prove that any rows were truncated.
    truncation: { truncated: false },
    errors: identityKnown ? [] : [{ code: 'floor_votes_observation_unverified' }],
  });
}

/** Observe a successful legacy call without changing its result or thrown error. */
export async function observeFloorVotesCall<T extends RecordValue>(
  call: () => Promise<T>, request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeFloorVotesResult(legacyPayload, request)));
  return legacyPayload;
}
