import type { AcquisitionRecordInput, AppendResult } from '../../src/program-element/acquisition-continuity/acquisition-continuity.store.js';
import { awardKey, parseAwardId, payloadHash } from './sam-contract-action.js';
import { exactInstant } from './sam-exact-instant.js';

export const MAX_ENRICHMENT_AWARDS = 25;
export const MAX_ENRICHMENT_FILE_BYTES = 16_384;
export interface AwardEnrichmentSnapshot {
  awardUniqueId: string;
  piid: string | null;
  sourceRecord: unknown;
  sourceObservedAt: string | null;
}
export interface AwardEnrichmentHead {
  identityKey: string;
  sourceRecord: unknown;
  sourceObservedAt: string | null;
  recordedAt: string;
}
export interface AwardEnrichmentPorts {
  readAwards(ids: readonly string[]): Promise<AwardEnrichmentSnapshot[]>;
  readHeads(keys: readonly string[]): Promise<AwardEnrichmentHead[]>;
  appendRecord(input: AcquisitionRecordInput): Promise<AppendResult>;
}
type Refusal = 'missing_source_award' | 'missing_source_snapshot' | 'source_identity_mismatch'
  | 'invalid_recipient_uei' | 'invalid_attribute' | 'invalid_source_clock'
  | 'unsupported_source_clock_precision' | 'existing_source_clock_unknown'
  | 'stale_source_snapshot' | 'conflicting_source_snapshot' | 'existing_catalog_fork';
export interface AwardEnrichmentOutcome {
  awardIdentityKey: string;
  state: 'validated' | 'refused' | 'inserted' | 'existing' | 'write_outcome_unresolved';
  reason?: Refusal;
  recipientIdentity?: 'source_reported_uei' | 'unresolved';
  sourceObservedAt?: string;
  sourcePayloadSha256?: string;
  revisionId?: string;
}
export interface AwardEnrichmentReceipt {
  contract: 'procurement-catalog-enrichment/1';
  mode: 'DRY_RUN' | 'COMMIT';
  status: 'VALIDATED' | 'REFUSED' | 'COMPLETED' | 'WRITE_OUTCOME_UNRESOLVED' | 'TRANSACTION_OUTCOME_UNRESOLVED';
  coverage: 'finite_catalog_observations_only';
  requested: number;
  inserted: number | null;
  existing: number | null;
  outcomes: AwardEnrichmentOutcome[];
}

export function continuityWritesEnabled(commit: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return commit && env.PROGRAM_ACQUISITION_CONTINUITY_ENABLED === 'true';
}

export function validateAwardEnrichmentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ENRICHMENT_AWARDS
    || value.some((id) => {
      if (typeof id !== 'string' || id.length > 512) return true;
      const parts = parseAwardId(id);
      return !parts || !awardKey(id) || id !== `CONT_AWD_${parts.piid}_${parts.agency}_${parts.parentPiid ?? '-NONE-'}_${parts.parentAgency ?? '-NONE-'}`;
    })
    || new Set(value).size !== value.length) {
    throw new Error('Award enrichment requires 1–25 distinct exact canonical full award IDs');
  }
  return [...value] as string[];
}

export function awardEnrichmentFileArgument(args: readonly string[]): string | null {
  if (!args.includes('--award-ids-file')) return null;
  let file: string | undefined, commit = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--commit' && !commit) { commit = true; continue; }
    if (value === '--award-ids-file' && file === undefined) {
      file = args[++index];
      if (file && !file.startsWith('--')) continue;
    }
    throw new Error('Finite award mode accepts only --award-ids-file <JSON file> and optional --commit');
  }
  return file!;
}

export function parseAwardEnrichmentFile(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_ENRICHMENT_FILE_BYTES) throw new Error('Award enrichment file exceeds 16384 bytes');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Award enrichment file must be a JSON array of full award IDs'); }
  return validateAwardEnrichmentIds(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function validateSnapshot(row: AwardEnrichmentSnapshot, heads: readonly AwardEnrichmentHead[]):
  { input: AcquisitionRecordInput; outcome: AwardEnrichmentOutcome } | { reason: Refusal } {
  const parsed = parseAwardId(row.awardUniqueId), key = awardKey(row.awardUniqueId);
  if (!parsed || !key || row.piid !== parsed.piid) return { reason: 'source_identity_mismatch' };
  const raw = row.sourceRecord;
  if (!object(raw)) return { reason: 'missing_source_snapshot' };
  if (raw.generated_internal_id !== row.awardUniqueId || raw['Award ID'] !== parsed.piid) return { reason: 'source_identity_mismatch' };
  const uei = raw['Recipient UEI'];
  if (uei != null && uei !== '' && (typeof uei !== 'string' || !/^[A-Z0-9]{12}$/.test(uei))) return { reason: 'invalid_recipient_uei' };
  if (['Recipient Name', 'Awarding Agency', 'Awarding Sub Agency', 'Description'].some((field) =>
    raw[field] != null && (typeof raw[field] !== 'string' || /[\u0000-\u001f\u007f]/.test(raw[field] as string)))) {
    return { reason: 'invalid_attribute' };
  }
  const observedAt = exactInstant(row.sourceObservedAt);
  if (!observedAt) return { reason: 'invalid_source_clock' };
  // Existing appendRecord uses Prisma Date input. Never silently discard sub-millisecond source evidence.
  if (!observedAt.endsWith('000Z')) return { reason: 'unsupported_source_clock_precision' };
  const sourcePayloadSha256 = payloadHash(raw);
  if (new Set(heads.map((head) => payloadHash(head.sourceRecord))).size > 1) return { reason: 'existing_catalog_fork' };
  for (const head of heads) {
    const headClock = exactInstant(head.sourceObservedAt);
    if (!headClock) return { reason: 'existing_source_clock_unknown' };
    if (observedAt < headClock) return { reason: 'stale_source_snapshot' };
    if (observedAt === headClock && sourcePayloadSha256 !== payloadHash(head.sourceRecord)) return { reason: 'conflicting_source_snapshot' };
  }
  return {
    input: {
      source: 'usaspending', sourceRecordId: row.awardUniqueId, generatedAwardId: row.awardUniqueId,
      recordKind: 'award', title: optionalText(raw.Description) ?? optionalText(raw['Recipient Name']),
      status: 'current_summary', buyerOffice: optionalText(raw['Awarding Sub Agency']) ?? optionalText(raw['Awarding Agency']),
      sourceUrl: `https://www.usaspending.gov/award/${encodeURIComponent(row.awardUniqueId)}`,
      sourceObservedAt: observedAt, raw,
    },
    outcome: { awardIdentityKey: key, state: 'validated', recipientIdentity: uei ? 'source_reported_uei' : 'unresolved',
      sourceObservedAt: observedAt, sourcePayloadSha256 },
  };
}

/** Existing append-only catalog producer; no action, qualification, relationship or legacy PIID writes. */
export async function enrichAwardCohort(
  ports: AwardEnrichmentPorts,
  options: { awardIds: readonly string[]; commit: boolean; env?: NodeJS.ProcessEnv },
): Promise<AwardEnrichmentReceipt> {
  const ids = validateAwardEnrichmentIds(options.awardIds), keys = ids.map((id) => awardKey(id)!);
  const enabled = continuityWritesEnabled(options.commit, options.env);
  const rows = await ports.readAwards(ids);
  if (rows.length > ids.length || new Set(rows.map((row) => row.awardUniqueId)).size !== rows.length
    || rows.some((row) => !ids.includes(row.awardUniqueId))) throw new Error('Award enrichment source scope mismatch');
  const heads = await ports.readHeads(keys);
  if (heads.length > MAX_ENRICHMENT_AWARDS || heads.some((row) => !keys.includes(row.identityKey))) {
    throw new Error('Award enrichment head scope exceeds finite allocation');
  }
  const receipt: AwardEnrichmentReceipt = { contract: 'procurement-catalog-enrichment/1',
    mode: enabled ? 'COMMIT' : 'DRY_RUN', status: 'VALIDATED', coverage: 'finite_catalog_observations_only',
    requested: ids.length, inserted: 0, existing: 0, outcomes: [] };
  const writes: AcquisitionRecordInput[] = [];
  for (const id of ids) {
    const key = awardKey(id)!, row = rows.find((candidate) => candidate.awardUniqueId === id);
    const result = row ? validateSnapshot(row, heads.filter((head) => head.identityKey === key)) : { reason: 'missing_source_award' as const };
    if ('reason' in result) receipt.outcomes.push({ awardIdentityKey: key, state: 'refused', reason: result.reason });
    else { receipt.outcomes.push(result.outcome); writes.push(result.input); }
  }
  // The entire requested cohort is admitted before its first append, so validation cannot partially write it.
  if (receipt.outcomes.some((outcome) => outcome.state === 'refused')) { receipt.status = 'REFUSED'; return receipt; }
  if (!enabled) return receipt;
  for (let index = 0; index < writes.length; index += 1) {
    const outcome = receipt.outcomes[index]!;
    try {
      const result = await ports.appendRecord(writes[index]!);
      if (result.identityKey !== outcome.awardIdentityKey) throw new Error('Unexpected append identity');
      outcome.state = result.inserted ? 'inserted' : 'existing'; outcome.revisionId = result.id;
      if (result.inserted) receipt.inserted = (receipt.inserted ?? 0) + 1;
      else receipt.existing = (receipt.existing ?? 0) + 1;
    } catch {
      outcome.state = 'write_outcome_unresolved'; receipt.status = 'WRITE_OUTCOME_UNRESOLVED';
      return receipt; // No automatic retry or inference that a failed acknowledgement wrote nothing.
    }
  }
  receipt.status = 'COMPLETED';
  return receipt;
}
