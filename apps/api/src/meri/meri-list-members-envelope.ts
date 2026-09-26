import {
  createMeriResultEnvelope,
  isValidCanonicalId,
  normalizeCanonicalId,
  type MeriResultEnvelope,
} from '@capiro/shared';
import { resolveStateName } from '../common/us-states.js';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;

const SOURCE_ID = 'congress_member';
const STORAGE = 'capiro_local_database';

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function optionalString(input: RecordValue, key: string, max: number): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function unqueried<T>(legacyPayload: T, resolution: 'missing_filter' | 'invalid_state') {
  return createMeriResultEnvelope({
    outcome: 'needs_input',
    legacyPayload,
    sources: [{
      family: 'legislative', sourceId: SOURCE_ID, availability: 'not_queried',
      scope: { storage: STORAGE, resolution }, observedAt: null,
      coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
    }],
    errors: [],
  });
}

/**
 * Dormant observation of list_members' bounded query against Capiro's local
 * current-member roster. Coverage is about this filtered local query only; it
 * says nothing about upstream roster completeness or synchronization recency.
 */
export function envelopeListMembersResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const rawState = optionalString(request, 'state', 40);
  const stateName = rawState ? resolveStateName(rawState) ?? null : null;
  const rawChamber = optionalString(request, 'chamber', 10)?.toLowerCase() ?? null;
  const chamber = rawChamber === 'house' || rawChamber === 'senate' ? rawChamber : null;
  const limit = clampLimit(request.limit);
  const result = record(legacyPayload);

  if (result?.tool !== 'list_members') {
    return createMeriResultEnvelope({
      outcome: 'partial', legacyPayload,
      sources: [{
        family: 'legislative', sourceId: SOURCE_ID, availability: 'unknown',
        scope: { storage: STORAGE, resolution: 'unverified' }, observedAt: null,
        coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
      }],
      errors: [{ code: 'list_members_observation_unverified' }],
    });
  }

  if (rawState && !stateName) {
    const shortCircuited = typeof result.note === 'string' &&
      result.note.startsWith(`"${rawState}" is not a recognized US state or territory`) &&
      result.matchesFound === 0 && Array.isArray(result.members) && result.members.length === 0 &&
      !Object.prototype.hasOwnProperty.call(result, 'filter');
    return shortCircuited
      ? unqueried(legacyPayload, 'invalid_state')
      : unknownObservation(legacyPayload);
  }

  if (!stateName && !chamber) {
    const shortCircuited = typeof result.note === 'string' &&
      result.note.startsWith('Provide a state (full name or 2-letter code) and/or a chamber') &&
      result.matchesFound === 0 && Array.isArray(result.members) && result.members.length === 0 &&
      !Object.prototype.hasOwnProperty.call(result, 'filter');
    return shortCircuited
      ? unqueried(legacyPayload, 'missing_filter')
      : unknownObservation(legacyPayload);
  }

  const scope = {
    storage: STORAGE,
    ...(stateName ? { state: stateName } : {}),
    ...(chamber ? { chamber } : {}),
    limit,
  };
  const rows = Array.isArray(result.members) ? result.members : null;
  const filter = record(result.filter);
  const filterMatches = filter !== null &&
    filter.state === (stateName ?? null) && filter.chamber === (chamber ?? null);
  const validRows = rows !== null && rows.every((raw) => {
    const member = record(raw);
    const state = typeof member?.state === 'string' ? resolveStateName(member.state) : undefined;
    const canonicalBioguide = typeof member?.id === 'string'
      ? normalizeCanonicalId('bioguide', member.id)
      : null;
    const rowChamber = member?.chamber;
    return typeof member?.id === 'string' && canonicalBioguide === member.id &&
      isValidCanonicalId('bioguide', member.id) &&
      typeof member.name === 'string' && member.name.trim().length > 0 &&
      state !== undefined && member.state === state &&
      (!stateName || state === stateName) &&
      (rowChamber === 'house' || rowChamber === 'senate') &&
      (chamber === null || rowChamber === chamber);
  });
  const ids = validRows ? rows!.map((raw) => (raw as RecordValue).id as string) : [];
  const countMatches = result.matchesFound === rows?.length;
  const identityKnown = filterMatches && validRows && countMatches && rows!.length <= limit &&
    new Set(ids).size === ids.length;

  if (!identityKnown) {
    return createMeriResultEnvelope({
      outcome: 'partial', legacyPayload,
      sources: [{
        family: 'legislative', sourceId: SOURCE_ID, availability: 'unknown',
        scope, observedAt: null,
        coverage: {
          completeness: 'unknown',
          ...(rows ? { returnedCount: rows.length } : {}),
          matchedCount: null,
        },
        provenance: [],
      }],
      errors: [{ code: 'list_members_observation_unverified' }],
    });
  }

  const atCap = rows!.length === limit;
  return createMeriResultEnvelope({
    outcome: atCap ? 'partial' : rows!.length === 0 ? 'not_found_within_scope' : 'succeeded',
    legacyPayload,
    sources: [{
      family: 'legislative', sourceId: SOURCE_ID, availability: 'available',
      scope, observedAt: null,
      coverage: {
        // Below the handler's take limit, the local filtered query ended.
        // Reaching the limit leaves additional local matches possible.
        completeness: atCap ? 'partial' : 'complete',
        ...(!atCap ? { continuation: { hasMore: false } } : {}),
        returnedCount: rows!.length,
        matchedCount: atCap ? null : rows!.length,
      },
      provenance: rows!.map((raw) => ({ recordId: (raw as RecordValue).id as string, sourceId: SOURCE_ID })),
    }],
    // A cap hit makes more rows possible, but does not prove rows were omitted.
    truncation: { truncated: false },
    errors: [],
  });
}

function unknownObservation<T extends RecordValue>(legacyPayload: T): MeriResultEnvelope<T> {
  return createMeriResultEnvelope({
    outcome: 'partial', legacyPayload,
    sources: [{
      family: 'legislative', sourceId: SOURCE_ID, availability: 'unknown',
      scope: { storage: STORAGE, resolution: 'unverified' }, observedAt: null,
      coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
    }],
    errors: [{ code: 'list_members_observation_unverified' }],
  });
}

/** Observe a successful legacy call without changing its result or rejection. */
export async function observeListMembersCall<T extends RecordValue>(
  call: () => Promise<T>,
  request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeListMembersResult(legacyPayload, request)));
  return legacyPayload;
}
