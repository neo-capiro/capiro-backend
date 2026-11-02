import { exactInstant } from './sam-exact-instant.js';
import { createHash } from 'node:crypto';
import { buildAcquisitionIdentity } from '../../src/program-element/acquisition-continuity/acquisition-identity.js';

/** See docs/lane6/sam-action-contract-v2.md for source authority and supported subset. */
export const SAM_ACTION_CONTRACT = 'sam-contract-action/v2' as const;
export interface SamRecord extends Record<string, unknown> {
  contractId?: {
    piid?: unknown; subtier?: { code?: unknown }; modificationNumber?: unknown;
    transactionNumber?: unknown; referencedIDVPiid?: unknown;
    referencedIDVSubtier?: { code?: unknown }; referencedIDVModificationNumber?: unknown;
  };
  oldContractId?: unknown;
  coreData?: { awardOrIDV?: unknown; awardOrIDVType?: { code?: unknown } };
  awardDetails?: {
    dollars?: { actionObligation?: unknown };
    dates?: { dateSigned?: unknown };
    transactionData?: { lastModifiedDate?: unknown; version?: unknown; status?: unknown };
  };
}
export interface AwardCandidate {
  piid: string; awardUniqueId: string; identityKey: string;
}
export interface ProducerRun {
  contract: typeof SAM_ACTION_CONTRACT;
  producerCommit: string; imageDigest: string; runId: string; targetId: string;
}
export type Rejection = 'unsupported_record_kind' | 'invalid_award_identity' | 'incomplete_parent'
  | 'missing_action_identity' | 'source_identity_change' | 'no_award_match' | 'multiple_award_matches'
  | 'invalid_catalog_identity' | 'invalid_obligation' | 'invalid_action_date' | 'invalid_source_revision';
export interface MappedSamAction {
  sourceTransactionId: string; awardIdentityKey: string; awardUniqueId: string;
  piid: string; modificationNumber: string; transactionNumber: string;
  actionDate: string | null; signedObligationDelta: string;
  sourceRevisionOrder: string; sourcePayloadHash: string;
}
export type MappingResult = { ok: true; value: MappedSamAction } | { ok: false; reason: Rejection };

export function sourceText(value: unknown): string | null {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  const text = String(value).trim();
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}
function component(value: unknown): string | null {
  const text = sourceText(value);
  // Deliberate supported subset of the unescaped USAspending composite, not a PIID length heuristic.
  return text && /^[A-Z0-9][A-Z0-9-]*$/.test(text) && text !== '-NONE-' ? text : null;
}
function agency(value: unknown): string | null {
  const text = component(value);
  return text && /^[A-Z0-9]{4}$/.test(text) ? text : null;
}
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)])) : v;
  return JSON.stringify(normalize(value));
}
export const payloadHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Decimal(20,2). Bare JS numbers have no retained source lexeme and are rejected. */
export function usd(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && '$samDecimalLexeme' in value) value = value.$samDecimalLexeme;
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d{1,18})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const whole = BigInt(match[2]!).toString();
  const fraction = (match[3] ?? '').padEnd(2, '0');
  return `${match[1] && (whole !== '0' || fraction !== '00') ? '-' : ''}${whole}.${fraction}`;
}
function validDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}
/** SAM documented Z clocks and explicit offsets normalize to exact UTC microseconds. */
export function sourceRevisionOrder(value: unknown): string | null {
  return exactInstant(value);
}
export function awardKey(awardUniqueId: string): string | null {
  const built = buildAcquisitionIdentity({ source: 'usaspending', recordKind: 'award', generatedAwardId: awardUniqueId });
  return built.ok ? built.identity.key : null;
}
export function parseAwardId(id: string): { piid: string; agency: string; parentPiid: string | null; parentAgency: string | null } | null {
  const parts = id.split('_');
  if (parts.length !== 6 || parts[0] !== 'CONT' || parts[1] !== 'AWD') return null;
  const piid = component(parts[2]), ownAgency = agency(parts[3]);
  const direct = parts[4] === '-NONE-' && parts[5] === '-NONE-';
  const parentPiid = direct ? null : component(parts[4]), parentAgency = direct ? null : agency(parts[5]);
  if (!piid || !ownAgency || (!direct && (!parentPiid || !parentAgency))) return null;
  return { piid, agency: ownAgency, parentPiid, parentAgency };
}
export function validProducerRun(run: ProducerRun): boolean {
  return run.contract === SAM_ACTION_CONTRACT && /^[a-f0-9]{40}$/.test(run.producerCommit)
    && /^sha256:[a-f0-9]{64}$/.test(run.imageDigest)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(run.runId)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(run.targetId);
}
export function mapSamAction(record: SamRecord, candidates: readonly AwardCandidate[]): MappingResult {
  const reject = (reason: Rejection): MappingResult => ({ ok: false, reason });
  const type = sourceText(record.coreData?.awardOrIDVType?.code);
  if (sourceText(record.coreData?.awardOrIDV)?.toUpperCase() !== 'AWARD' || !type || !['A', 'B', 'C', 'D'].includes(type)) {
    return reject('unsupported_record_kind');
  }
  // Renamed identities need an explicit source crosswalk before either history can be qualified.
  if (record.oldContractId != null && (!Array.isArray(record.oldContractId) || record.oldContractId.length > 0)) return reject('source_identity_change');
  const id = record.contractId;
  const piid = component(id?.piid), ownAgency = agency(id?.subtier?.code);
  if (!piid || !ownAgency) return reject('invalid_award_identity');
  const parentText = sourceText(id?.referencedIDVPiid), parentAgencyText = sourceText(id?.referencedIDVSubtier?.code);
  const parentPiid = component(id?.referencedIDVPiid), parentAgency = agency(id?.referencedIDVSubtier?.code);
  if ((parentText !== null || parentAgencyText !== null || type === 'A' || type === 'C') && (!parentPiid || !parentAgency)) {
    return reject('incomplete_parent');
  }
  // Non-string objects/booleans are malformed, not absence.
  if ((id?.referencedIDVPiid != null && !parentText) || (id?.referencedIDVSubtier?.code != null && !parentAgencyText)) return reject('incomplete_parent');
  const modificationNumber = sourceText(id?.modificationNumber), transactionNumber = sourceText(id?.transactionNumber);
  if (!modificationNumber || !transactionNumber) return reject('missing_action_identity');
  const matches = candidates.filter((row) => {
    const parsed = parseAwardId(row.awardUniqueId);
    return parsed && row.piid === piid && parsed.piid === piid && parsed.agency === ownAgency
      && parsed.parentPiid === parentPiid && parsed.parentAgency === parentAgency;
  });
  if (matches.length === 0) return reject('no_award_match');
  const awards = new Map(matches.map((row) => [JSON.stringify([row.awardUniqueId, row.identityKey]), row]));
  if (awards.size !== 1) return reject('multiple_award_matches');
  if (matches.some((row) => row.identityKey !== awardKey(row.awardUniqueId))) return reject('invalid_catalog_identity');
  const award = [...awards.values()][0]!;
  const signedObligationDelta = usd(record.awardDetails?.dollars?.actionObligation);
  if (signedObligationDelta === null) return reject('invalid_obligation');
  const signed = sourceText(record.awardDetails?.dates?.dateSigned);
  const actionDate = signed?.slice(0, 10) ?? null;
  if (record.awardDetails?.dates?.dateSigned != null && !signed) return reject('invalid_action_date');
  if (signed && (!/^(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.0{1,6})?)?$/.test(signed) || !validDay(actionDate!))) return reject('invalid_action_date');
  const revisionOrder = sourceRevisionOrder(record.awardDetails?.transactionData?.lastModifiedDate);
  if (!revisionOrder) return reject('invalid_source_revision');
  return { ok: true, value: {
    // JSON preserves component boundaries; shared store applies its existing outer percent encoding.
    sourceTransactionId: JSON.stringify([SAM_ACTION_CONTRACT, award.identityKey, modificationNumber, transactionNumber]),
    awardIdentityKey: award.identityKey, awardUniqueId: award.awardUniqueId, piid,
    modificationNumber, transactionNumber, actionDate, signedObligationDelta,
    sourceRevisionOrder: revisionOrder, sourcePayloadHash: payloadHash(record),
  } };
}
export function transactionInput(record: SamRecord, value: MappedSamAction, run: ProducerRun, observedAt: string) {
  if (!validProducerRun(run) || exactInstant(observedAt) === null) throw new Error('valid producer provenance and observation time required');
  return {
    source: 'sam_gov', sourceTransactionId: value.sourceTransactionId, awardIdentityKey: value.awardIdentityKey,
    piid: value.piid, modificationNumber: value.modificationNumber, actionDate: value.actionDate,
    signedObligationDelta: value.signedObligationDelta, signedOutlayDelta: null,
    sourceObservedAt: exactInstant(observedAt)!,
    sourceUrl: `https://api.sam.gov/contract-awards/v1/search?piid=${encodeURIComponent(value.piid)}`,
    raw: { sourcePayload: record, acquisitionProvenance: { ...run, awardUniqueId: value.awardUniqueId,
      sourceRevisionOrder: value.sourceRevisionOrder, sourcePayloadHash: value.sourcePayloadHash } },
  };
}

/** Count each mapping outcome before the optional write boundary; a rejected record never reaches it. */
export async function appendSamRecords(
  records: readonly SamRecord[], candidates: readonly AwardCandidate[], run: ProducerRun,
  summary: { mapped: number; rejected: Record<string, number>; transactionsInserted: number; transactionsExisting: number },
  append?: (input: ReturnType<typeof transactionInput>) => Promise<{ inserted: boolean }>,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  for (const record of records) {
    const mapped = mapSamAction(record, candidates);
    if (!mapped.ok) { summary.rejected[mapped.reason] = (summary.rejected[mapped.reason] ?? 0) + 1; continue; }
    summary.mapped += 1;
    if (!append) continue;
    const result = await append(transactionInput(record, mapped.value, run, now()));
    if (result.inserted) summary.transactionsInserted += 1;
    else summary.transactionsExisting += 1;
  }
}
