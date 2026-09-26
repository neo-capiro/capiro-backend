import {
  createMeriResultEnvelope,
  formatBillId,
  isValidCanonicalId,
  normalizeCanonicalId,
  parseBillDesignation,
  type MeriResultEnvelope,
  type MeriResultSourceObservation,
} from '@capiro/shared';
import { notifyMeriResultObserver } from './meri-result-observer.js';

type RecordValue = Record<string, unknown>;
type Scope = Record<string, string | number | boolean | null>;

const BILL_SOURCE = 'congress_bill';
const ACTION_SOURCE = 'congress_bill_action';
const VOTE_SOURCE = 'roll_call_vote';
const RULE_LINK_SOURCE = 'bill_rule_link';
const LOCAL_STORAGE = 'capiro_local_database';

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : null;
}

/** Mirrors getBillStatus's explicit-Congress resolution solely to verify scope. */
function requestedBillId(request: RecordValue): string | null {
  const raw = optionalString(request.billId) ?? optionalString(request.query);
  if (!raw) return null;
  const hint = request.congress === undefined || request.congress === null
    ? null : Number(request.congress);
  const validHint = hint !== null && Number.isInteger(hint) && hint > 0 && hint <= 999;
  if (hint !== null && !validHint) return null;
  const canonical = normalizeCanonicalId('billId', raw);
  if (isValidCanonicalId('billId', canonical)) {
    return validHint && Number(canonical.split('-')[0]) !== hint ? null : canonical;
  }
  const explicitCongress = /\((\d{2,3})(?:st|nd|rd|th)?\)\s*$/i.test(raw);
  if (!validHint && !explicitCongress) return null;
  const parsed = parseBillDesignation(raw, validHint ? hint! : 1);
  if (validHint && parsed && parsed.congress !== hint) return null;
  return parsed ? formatBillId(parsed.congress, parsed.type, parsed.number) : null;
}

function exactBillSource(billId: string, found: boolean): MeriResultSourceObservation {
  return {
    family: 'legislative', sourceId: BILL_SOURCE, availability: 'available',
    scope: { storage: LOCAL_STORAGE, billId, lookup: 'exact_id' },
    // getBillStatus selects neither lastSyncedAt nor a source-version field.
    observedAt: null,
    coverage: {
      completeness: 'complete', continuation: { hasMore: false },
      returnedCount: found ? 1 : 0, matchedCount: found ? 1 : 0,
    },
    provenance: found ? [{ recordId: billId, sourceId: BILL_SOURCE }] : [],
  };
}

function boundedSource(
  sourceId: string,
  scope: Scope,
  rows: unknown,
  cap: number,
): MeriResultSourceObservation {
  const list = Array.isArray(rows) ? rows : null;
  const valid = list !== null && list.length <= cap && list.every((row) => asRecord(row) !== null);
  const atCap = valid && list!.length === cap;
  return {
    family: 'legislative', sourceId,
    availability: valid ? 'available' : 'unknown', scope,
    observedAt: null,
    coverage: {
      // Reaching take=N cannot establish whether N or more rows match locally.
      completeness: valid ? atCap ? 'partial' : 'complete' : 'unknown',
      ...(valid && !atCap ? { continuation: { hasMore: false } } : {}),
      ...(valid ? { returnedCount: list!.length } : {}),
      matchedCount: valid && !atCap ? list!.length : null,
    },
    // These selects do not include stable action/vote row IDs.
    provenance: [],
  };
}

function ruleLinkSource(billId: string, rules: unknown): MeriResultSourceObservation {
  const list = Array.isArray(rules) ? rules : null;
  const validEntries = list !== null && list.every((raw) => {
    const rule = asRecord(raw);
    return typeof rule?.ruleBillId === 'string' &&
      normalizeCanonicalId('billId', rule.ruleBillId) === rule.ruleBillId &&
      isValidCanonicalId('billId', rule.ruleBillId);
  });
  const valid = validEntries &&
    new Set(list!.map((raw) => (raw as RecordValue).ruleBillId)).size === list!.length;
  return {
    family: 'legislative', sourceId: RULE_LINK_SOURCE,
    availability: valid ? 'available' : 'unknown',
    scope: { storage: LOCAL_STORAGE, targetBillId: billId }, observedAt: null,
    coverage: {
      // The handler's local link query has no take/limit. The source feed is
      // not thereby proven complete.
      completeness: valid ? 'complete' : 'unknown',
      ...(valid ? { continuation: { hasMore: false }, returnedCount: list!.length } : {}),
      matchedCount: valid ? list!.length : null,
    },
    // ruleBillId is a soft reference; no selected link-row ID is available.
    provenance: [],
  };
}

function unverifiedSource(): MeriResultSourceObservation {
  return {
    family: 'legislative', sourceId: BILL_SOURCE, availability: 'unknown',
    scope: { storage: LOCAL_STORAGE, resolution: 'unverified' }, observedAt: null,
    coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
  };
}

/**
 * Dormant adapter for the successful getBillStatus result. Every coverage
 * statement concerns the local database query, never Congress.gov inventory
 * or sync freshness. The legacy payload remains the same object.
 */
export function envelopeBillStatusResult<T extends RecordValue>(
  legacyPayload: T,
  request: RecordValue,
): MeriResultEnvelope<T> {
  const expectedBillId = requestedBillId(request);
  const identified = legacyPayload.tool === 'get_bill_status';
  const unresolved = identified && expectedBillId === null && legacyPayload.found === false &&
    !Object.prototype.hasOwnProperty.call(legacyPayload, 'billId');
  if (unresolved) {
    return createMeriResultEnvelope({
      outcome: 'needs_input', legacyPayload,
      sources: [{
        family: 'legislative', sourceId: BILL_SOURCE, availability: 'not_queried',
        scope: { storage: LOCAL_STORAGE, resolution: 'unresolved' }, observedAt: null,
        coverage: { completeness: 'unknown', matchedCount: null }, provenance: [],
      }],
      errors: [],
    });
  }

  const scoped = identified && expectedBillId !== null && legacyPayload.billId === expectedBillId;
  const contradictoryMiss = [
    'title', 'congress', 'status', 'statusLabel', 'statusAt', 'latestAction',
    'sponsor', 'cosponsorsCount', 'recentActions', 'floorVotes', 'governingRules',
  ]
    .some((key) => Object.prototype.hasOwnProperty.call(legacyPayload, key));
  if (scoped && legacyPayload.found === false && !contradictoryMiss) {
    return createMeriResultEnvelope({
      outcome: 'not_found_within_scope', legacyPayload,
      sources: [exactBillSource(expectedBillId!, false)], errors: [],
    });
  }

  if (scoped && legacyPayload.found === true && typeof legacyPayload.title === 'string' &&
    legacyPayload.congress === Number(expectedBillId!.split('-')[0])) {
    const billId = expectedBillId!;
    const rules = legacyPayload.governingRules;
    const links = ruleLinkSource(billId, rules);
    const sources: MeriResultSourceObservation[] = [
      exactBillSource(billId, true),
      boundedSource(ACTION_SOURCE, { storage: LOCAL_STORAGE, billId }, legacyPayload.recentActions, 15),
      boundedSource(VOTE_SOURCE, { storage: LOCAL_STORAGE, billId, voteRole: 'bill' }, legacyPayload.floorVotes, 15),
      links,
    ];
    if (links.availability === 'available') {
      for (const raw of rules as unknown[]) {
        const rule = asRecord(raw)!;
        sources.push(boundedSource(
          VOTE_SOURCE,
          { storage: LOCAL_STORAGE, billId: rule.ruleBillId as string, voteRole: 'governing_rule' },
          rule.ruleVotes,
          3,
        ));
      }
    }
    const capped = sources.some((source) => source.coverage.completeness === 'partial');
    const unknown = sources.some((source) => source.coverage.completeness === 'unknown');
    const statusKnown = typeof legacyPayload.status === 'string' && legacyPayload.status.length > 0;
    const ruleStatusesKnown = Array.isArray(rules) && rules.every((raw) => {
      const rule = asRecord(raw);
      return typeof rule?.ruleStatus === 'string' && rule.ruleStatus.length > 0;
    });
    const complete = statusKnown && ruleStatusesKnown && !capped && !unknown;
    return createMeriResultEnvelope({
      outcome: complete ? 'succeeded' : 'partial', legacyPayload, sources,
      truncation: capped
        ? { truncated: true, reason: 'possible_local_result_cap' }
        : { truncated: false },
      errors: unknown ? [{ code: 'bill_status_coverage_unverified' }] : [],
    });
  }

  return createMeriResultEnvelope({
    outcome: 'partial', legacyPayload, sources: [unverifiedSource()],
    errors: [{ code: 'bill_status_observation_unverified' }],
  });
}

/** Success-only opt-in observer; rejections and successful payloads retain identity. */
export async function observeBillStatusCall<T extends RecordValue>(
  call: () => Promise<T>,
  request: RecordValue,
  observe: (envelope: MeriResultEnvelope<T>) => void,
): Promise<T> {
  const legacyPayload = await call();
  notifyMeriResultObserver(() => observe(envelopeBillStatusResult(legacyPayload, request)));
  return legacyPayload;
}
