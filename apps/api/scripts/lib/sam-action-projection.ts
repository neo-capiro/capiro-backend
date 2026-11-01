import { compareInstants, exactInstant, requireExactInstant } from './sam-exact-instant.js';
import { buildAcquisitionIdentity } from '../../src/program-element/acquisition-continuity/acquisition-identity.js';
import { awardKey, canonicalJson, mapSamAction, parseAwardId, payloadHash, sourceRevisionOrder, sourceText, usd, validProducerRun,
  type AwardCandidate, type ProducerRun, type SamRecord } from './sam-contract-action.js';

/** Offline executable specification for DB's forward v2 consumers. No DB/network effects. */
export interface ObservedAction {
  id: string; transactionIdentityKey: string; awardIdentityKey: string; sourceSystem: string;
  sourceTransactionId: string; piid: string | null; modificationNumber: string | null;
  actionDate: string | null; signedObligationDelta: string | null; signedOutlayDelta: string | null;
  recordedAt: string; sourceObservedAt: string | null; supersedesId: string | null;
  correctsIdentityKey: string | null; parentAwardIdentityKey: string | null; sourceUrl: string | null; raw: unknown;
}
/** Independently approved by the DB/release owners, not read from producer claims. */
export interface QualifiedRun extends ProducerRun {
  approvedAt: string; revokedAt: string | null;
  awardIdentityKeys: readonly string[];
  completedAt: string; memberCount: number; manifestSha256: string; evidenceSha256: string;
  members: readonly QualifiedMember[];
}
export interface QualifiedMember { revisionId: string; sourcePayloadHash: string; rowContentHash: string }
/** Independently computed from persisted rows, never supplied/approved by the producer. */
export function qualifiedMember(row: ObservedAction): QualifiedMember {
  const raw = row.raw as Envelope;
  return { revisionId: row.id, sourcePayloadHash: raw?.acquisitionProvenance?.sourcePayloadHash ?? '',
    rowContentHash: payloadHash({ id: row.id, transactionIdentityKey: row.transactionIdentityKey,
      awardIdentityKey: row.awardIdentityKey, parentAwardIdentityKey: row.parentAwardIdentityKey,
      sourceSystem: row.sourceSystem, sourceTransactionId: row.sourceTransactionId,
      piid: row.piid, modificationNumber: row.modificationNumber, actionDate: row.actionDate,
      signedObligationDelta: row.signedObligationDelta, signedOutlayDelta: row.signedOutlayDelta,
      recordedAt: requireExactInstant(row.recordedAt), sourceObservedAt: row.sourceObservedAt === null ? null : requireExactInstant(row.sourceObservedAt),
      supersedesId: row.supersedesId, correctsIdentityKey: row.correctsIdentityKey,
      sourceUrl: row.sourceUrl, raw: row.raw }) };
}
export function populationManifestHash(members: readonly QualifiedMember[]): string {
  return payloadHash([...members].sort((a, b) => a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0)
    .map((m) => [m.revisionId, m.sourcePayloadHash, m.rowContentHash]));
}
function validPopulation(run: QualifiedRun): boolean {
  if (!Array.isArray(run.members) || !Number.isSafeInteger(run.memberCount) || run.memberCount < 1
    || run.memberCount !== run.members.length || new Set(run.members.map((m) => m.revisionId)).size !== run.memberCount
    || !/^[a-f0-9]{64}$/.test(run.evidenceSha256) || !/^[a-f0-9]{64}$/.test(run.manifestSha256)
    || run.members.some((m) => !m.revisionId || !/^[a-f0-9]{64}$/.test(m.sourcePayloadHash) || !/^[a-f0-9]{64}$/.test(m.rowContentHash))
    || !Array.isArray(run.awardIdentityKeys) || !run.awardIdentityKeys.length
    || new Set(run.awardIdentityKeys).size !== run.awardIdentityKeys.length) return false;
  const completed = exactInstant(run.completedAt), approved = exactInstant(run.approvedAt);
  return completed !== null && approved !== null && completed <= approved
    && run.manifestSha256 === populationManifestHash(run.members);
}
export type ActionCategory = 'selected' | 'prior_source_revision' | 'repeated_observation'
  | 'source_revision_fork' | 'legacy' | 'unqualified_run' | 'invalid_provenance'
  | 'no_award_match' | 'multiple_award_matches' | 'invalid_chain' | 'source_after_cutoff';
export interface ClassifiedAction {
  row: ObservedAction; category: ActionCategory;
  sourceRevisionOrder: string | null; awardUniqueId: string | null;
}
type Envelope = { sourcePayload: SamRecord; acquisitionProvenance: ProducerRun & {
  awardUniqueId: string; sourceRevisionOrder: string; sourcePayloadHash: string;
} };
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function sameRun(a: ProducerRun, b: ProducerRun): boolean {
  return a.contract === b.contract && a.producerCommit === b.producerCommit && a.imageDigest === b.imageDigest
    && a.runId === b.runId && a.targetId === b.targetId;
}
export function projectSamActions(input: {
  rows: readonly ObservedAction[]; awards: readonly AwardCandidate[]; qualifiedRuns: readonly QualifiedRun[];
  targetId: string; knownAt: string; sourceThrough?: string;
}): ClassifiedAction[] {
  const knownAt = requireExactInstant(input.knownAt);
  if (input.sourceThrough && sourceRevisionOrder(input.sourceThrough) !== input.sourceThrough) throw new Error('canonical source cutoff required');
  const ids = new Map(input.rows.map((row) => [row.id, row]));
  if (ids.size !== input.rows.length) throw new Error('duplicate physical revision ID');
  const result: ClassifiedAction[] = [];
  const pending = new Map<string, Array<{ classified: ClassifiedAction; envelope: Envelope }>>();
  for (const row of input.rows) {
    if (requireExactInstant(row.recordedAt) > knownAt) continue;
    const classified: ClassifiedAction = { row, category: 'invalid_provenance', sourceRevisionOrder: null, awardUniqueId: null };
    result.push(classified);
    if (!object(row.raw) || !object(row.raw.acquisitionProvenance)) { classified.category = 'legacy'; continue; }
    const envelope = row.raw as unknown as Envelope;
    const provenance = envelope.acquisitionProvenance;
    if (!validProducerRun(provenance) || !object(envelope.sourcePayload)) continue;
    // Revocations apply even to retrospective queries: knownAt never restores disqualified data.
    const approvals = input.qualifiedRuns.filter((run) => validProducerRun(run) && validPopulation(run) && sameRun(run, provenance)
      && run.targetId === input.targetId && requireExactInstant(run.approvedAt) <= knownAt && run.revokedAt === null);
    if (approvals.length !== 1 || provenance.targetId !== input.targetId) { classified.category = 'unqualified_run'; continue; }
    // Header integrity/digest never substitutes for exact immutable physical membership.
    const approval = approvals[0]!;
    const member = approval.members.find((m) => m.revisionId === row.id);
    if (!member || member.sourcePayloadHash !== provenance.sourcePayloadHash
      || requireExactInstant(row.recordedAt) > requireExactInstant(approval.completedAt)) {
      classified.category = 'unqualified_run'; continue;
    }
    if (member.rowContentHash !== qualifiedMember(row).rowContentHash) continue;
    const mapped = mapSamAction(envelope.sourcePayload, input.awards);
    if (!mapped.ok) {
      if (mapped.reason === 'no_award_match' || mapped.reason === 'multiple_award_matches') classified.category = mapped.reason;
      continue;
    }
    const value = mapped.value;
    if (!approvals[0]!.awardIdentityKeys.includes(value.awardIdentityKey)) { classified.category = 'unqualified_run'; continue; }
    const identity = buildAcquisitionIdentity({ source: 'sam_gov', recordKind: 'modification', transactionId: value.sourceTransactionId });
    if (!identity.ok || row.sourceSystem !== 'sam_gov' || row.transactionIdentityKey !== identity.identity.key
      || row.awardIdentityKey !== value.awardIdentityKey || row.parentAwardIdentityKey !== null || row.sourceTransactionId !== value.sourceTransactionId
      || row.piid !== value.piid || row.modificationNumber !== value.modificationNumber || row.actionDate !== value.actionDate
      || usd(row.signedObligationDelta) !== value.signedObligationDelta || row.signedOutlayDelta !== null
      || provenance.awardUniqueId !== value.awardUniqueId || provenance.sourcePayloadHash !== value.sourcePayloadHash
      || provenance.sourceRevisionOrder !== value.sourceRevisionOrder || row.sourceObservedAt === null) continue;
    requireExactInstant(row.sourceObservedAt);
    classified.sourceRevisionOrder = value.sourceRevisionOrder;
    classified.awardUniqueId = value.awardUniqueId;
    const predecessor = row.supersedesId ? ids.get(row.supersedesId) : null;
    // Append order is observation history, never authority for source revision selection.
    if (row.correctsIdentityKey !== null || (row.supersedesId && (!predecessor
      || predecessor.awardIdentityKey !== row.awardIdentityKey || predecessor.transactionIdentityKey !== row.transactionIdentityKey
      || requireExactInstant(predecessor.recordedAt) >= requireExactInstant(row.recordedAt)))) { classified.category = 'invalid_chain'; continue; }
    if (input.sourceThrough && value.sourceRevisionOrder > input.sourceThrough) { classified.category = 'source_after_cutoff'; continue; }
    const group = pending.get(row.transactionIdentityKey) ?? [];
    group.push({ classified, envelope }); pending.set(row.transactionIdentityKey, group);
  }
  for (const group of pending.values()) {
    const latest = group.map(({ classified }) => classified.sourceRevisionOrder!).sort().at(-1)!;
    const heads = group.filter(({ classified }) => classified.sourceRevisionOrder === latest);
    // Compare canonical payload too: a hash is integrity evidence, not revision authority or a tie-breaker.
    if (new Set(heads.map(({ envelope }) => canonicalJson(envelope.sourcePayload))).size !== 1) {
      for (const { classified } of group) classified.category = 'source_revision_fork';
      continue;
    }
    heads.sort((a, b) => compareInstants(a.classified.row.recordedAt, b.classified.row.recordedAt)
      || a.classified.row.id.localeCompare(b.classified.row.id));
    const selected = heads[0]!.classified;
    for (const { classified } of group) classified.category = classified === selected ? 'selected'
      : classified.sourceRevisionOrder === latest ? 'repeated_observation' : 'prior_source_revision';
  }
  return result;
}

export interface MeasureTotals {
  rows: number; obligationUsd: string | null; outlayUsd: string | null;
  obligationKnown: number; outlayKnown: number;
}
function sum(values: readonly (string | null)[]): { value: string | null; known: number } {
  const present = values.filter((value): value is string => value !== null);
  let cents = 0n;
  for (const value of present) {
    const normalized = usd(value);
    if (normalized === null) throw new Error('invalid monetary measure');
    cents += BigInt(normalized.replace('.', ''));
  }
  const abs = cents < 0n ? -cents : cents;
  return { value: present.length ? `${cents < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}` : null, known: present.length };
}
/** Disjoint signed categories conserve physical amounts; NULL is never a measured zero. */
export function reconcileSamActions(rows: readonly ClassifiedAction[]): Map<ActionCategory | 'raw', MeasureTotals> {
  const result = new Map<ActionCategory | 'raw', MeasureTotals>();
  for (const category of ['raw', ...new Set(rows.map((row) => row.category))] as const) {
    const group = category === 'raw' ? rows : rows.filter((row) => row.category === category);
    const obligation = sum(group.map(({ row }) => row.signedObligationDelta));
    const outlay = sum(group.map(({ row }) => row.signedOutlayDelta));
    result.set(category, { rows: group.length, obligationUsd: obligation.value, outlayUsd: outlay.value,
      obligationKnown: obligation.known, outlayKnown: outlay.known });
  }
  return result;
}

export interface AwardObservation {
  id: string; sourceRecordId: string; identityKey: string; recordedAt: string;
  sourceSystem: string; recordKind: string; raw: Record<string, unknown>;
}
/** Award attributes are latest-known catalog observations, not reconstructed legal effective history. */
export function selectAwardObservations(rows: readonly AwardObservation[], knownAt: string) {
  const groups = new Map<string, AwardObservation[]>();
  const excluded: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    if (requireExactInstant(row.recordedAt) > requireExactInstant(knownAt)) continue;
    const parsed = parseAwardId(row.sourceRecordId);
    if (row.sourceSystem !== 'usaspending' || row.recordKind !== 'award' || !parsed
      || row.identityKey !== awardKey(row.sourceRecordId)
      || row.raw.generated_internal_id !== row.sourceRecordId || row.raw['Award ID'] !== parsed.piid) {
      excluded.push({ id: row.id, reason: 'invalid_award_provenance' }); continue;
    }
    const group = groups.get(row.identityKey) ?? []; group.push(row); groups.set(row.identityKey, group);
  }
  const selected: Array<AwardCandidate & { revisionId: string; recordedAt: string; awardingAgency: string | null;
    awardingSubTier: string | null; contractorName: string | null; recipientUei: string | null }> = [];
  for (const group of groups.values()) {
    group.sort((a, b) => compareInstants(b.recordedAt, a.recordedAt) || a.id.localeCompare(b.id));
    const head = group[0]!;
    const ties = group.filter((row) => requireExactInstant(row.recordedAt) === requireExactInstant(head.recordedAt));
    if (new Set(ties.map((row) => canonicalJson(row.raw))).size > 1) {
      excluded.push(...group.map((row) => ({ id: row.id, reason: 'award_observation_fork' }))); continue;
    }
    selected.push({ revisionId: head.id, identityKey: head.identityKey, awardUniqueId: head.sourceRecordId,
      piid: parseAwardId(head.sourceRecordId)!.piid, recordedAt: head.recordedAt,
      awardingAgency: sourceText(head.raw['Awarding Agency']), awardingSubTier: sourceText(head.raw['Awarding Sub Agency']),
      contractorName: sourceText(head.raw['Recipient Name']), recipientUei: sourceText(head.raw['Recipient UEI']) });
    excluded.push(...group.filter((row) => row !== head).map((row) => ({ id: row.id, reason: 'prior_award_observation' })));
  }
  selected.sort((a, b) => a.identityKey.localeCompare(b.identityKey));
  return { selected, excluded };
}
