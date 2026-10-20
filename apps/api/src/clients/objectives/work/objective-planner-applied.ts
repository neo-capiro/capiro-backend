import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { plannerResourceCalendarDate } from '@capiro/shared';
import { createPlannerApplicationCodec, createPlannerMaterializationCodec, CanonicalApplicationError,
  CANONICAL_APPLICATION_RECEIPT, CANONICAL_APPLICATION_HEAD, CANONICAL_MATERIALIZATION_RECEIPT,
  type CanonicalApplicationRequest, type StoredCanonicalApplication, type StoredCanonicalMaterialization,
  type CanonicalMaterializationPredecessor } from '@capiro/shared/objective-planner-owner-codec';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const application = createPlannerApplicationCodec({ sha256, isProxy: nodeTypes.isProxy });
const invalid = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
// Preserve the ORIGINAL Objective stable-object JSON convention. Parsing the
// strict lexical application JSON back into plain objects gives the original
// Object.fromEntries numeric-key enumeration before JSON.stringify. This differs
// from the manually lexical application/regeneration convention for numeric keys.
const objectiveDigest = (value: unknown) => sha256(JSON.stringify(JSON.parse(application.applicationJson(value))));
const materialization = createPlannerMaterializationCodec({ sha256, digest: objectiveDigest,
  canonicalRegenerationHash: application.applicationHash, plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: invalid });

export type ObjectivePlannerResource = { id: string; tenantId: string; ownerId: string; projectId: string | null;
  kind: string; name: string; data: unknown; version: number; archived: boolean; shareTokenHash: string | null };
export interface ObjectivePlannerAppliedOperation {
  tenantId: string; clerkUserId: string;
  work: Omit<CanonicalApplicationRequest, 'schemaVersion'> & { actorUserId: string; consentId: string; controlVersion: number };
  original: { originalDeadlineAt: string; workSha256: string };
  state: string; terminal: { receiptId: string; recordedAtMs: number } | null;
}
export interface ObjectivePlannerAppliedPair {
  receiptId: string; stored: StoredCanonicalApplication; owner: StoredCanonicalMaterialization;
  ownerRowId: string; ownerClerkUserId: string;
}
export interface ObjectivePlannerAppliedAccounting {
  terminalReceiptId: string; application: StoredCanonicalApplication; owner: StoredCanonicalMaterialization;
  consumedResourceIds: string[]; applications: ObjectivePlannerAppliedPair[];
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
const utc = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sameScope = (a: CanonicalApplicationRequest['canonical'], b: CanonicalApplicationRequest['canonical']) =>
  ['tenantId', 'clientId', 'objectiveId', 'canonicalPlanId', 'epoch', 'canonicalStrategyId', 'canonicalProjectId']
    .every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);

/** Checks an already parsed immutable operation against the EXACT reconstructed
 * application pair. This is retained accounting, never present effect authority. */
export function requireObjectivePlannerAppliedOperation(operation: ObjectivePlannerAppliedOperation,
  pair: ObjectivePlannerAppliedPair): void {
  application.applicationJson(operation);
  const w = operation.work, { actorUserId: _actor, consentId: _consent, controlVersion: _control, ...fields } = w;
  const request = application.parseCanonicalApplication({ schemaVersion: 1, ...fields });
  if (operation.state !== 'applied' || !operation.terminal || !Number.isSafeInteger(operation.terminal.recordedAtMs) ||
      operation.tenantId !== request.canonical.tenantId || operation.clerkUserId !== pair.ownerClerkUserId ||
      operation.terminal.receiptId !== pair.receiptId || application.applicationHash(request) !== application.applicationHash(pair.stored.request) ||
      pair.stored.ack.actorUserId !== w.actorUserId || pair.stored.ack.consentId !== w.consentId || pair.stored.ack.controlVersion !== w.controlVersion ||
      operation.original.workSha256 !== application.applicationHash(w) || !utc(operation.original.originalDeadlineAt) ||
      Date.parse(pair.stored.ack.recordedAt) > operation.terminal.recordedAtMs ||
      operation.terminal.recordedAtMs >= Date.parse(operation.original.originalDeadlineAt)) invalid();
}

/** Pure decode of owner-read rows under the caller's existing Planner gate.
 * Uses the SAME full v2/v3/predecessor and application checkers as Planner.
 * It performs no SQL, authorization, mutation, dispatch or current-output read.
 * Mutable heads are consistency witnesses, never an absence or write grant. */
export function decodeObjectivePlannerApplied(operation: ObjectivePlannerAppliedOperation,
  resources: readonly ObjectivePlannerResource[]): ObjectivePlannerAppliedAccounting {
  // Decode the strict JSON in this module's realm. A host-provided
  // structuredClone can otherwise manufacture foreign-realm prototypes, which
  // the shared closed-record checker correctly rejects.
  const pinned = JSON.parse(application.applicationJson(operation)) as ObjectivePlannerAppliedOperation;
  const rows = JSON.parse(application.applicationJson(resources)) as ObjectivePlannerResource[];
  const byId = new Map<string, ObjectivePlannerResource>();
  for (const row of rows) {
    application.applicationUuid(row.id);
    if (row.tenantId !== pinned.tenantId || byId.has(row.id)) invalid();
    byId.set(row.id, row);
  }
  const used = new Set<string>(), seen = new Set<string>(), pairs = new Map<string, ObjectivePlannerAppliedPair>();
  const rowAt = (id: string, kind: string, owner?: string) => {
    const row = byId.get(id);
    if (!row || row.kind !== kind || row.tenantId !== pinned.tenantId || row.archived !== false || row.projectId !== null ||
        row.shareTokenHash !== null || typeof row.ownerId !== 'string' || !row.ownerId || row.ownerId.length > 128 ||
        owner !== undefined && row.ownerId !== owner || !positive(row.version) || kind !== CANONICAL_APPLICATION_HEAD && row.version !== 1) return invalid();
    used.add(row.id); return row;
  };
  const read = (receiptId: string): ObjectivePlannerAppliedPair => {
    const cached = pairs.get(receiptId); if (cached) return cached;
    if (seen.has(receiptId) || seen.size >= 128) return invalid();
    seen.add(receiptId);
    const appRow = rowAt(receiptId, CANONICAL_APPLICATION_RECEIPT);
    const raw = appRow.data as StoredCanonicalApplication;
    const request = application.parseCanonicalApplication(raw?.request);
    if (!sameScope(request.canonical, pinned.work.canonical) || request.canonical.tenantId !== pinned.tenantId ||
        receiptId !== application.applicationReceiptId(pinned.tenantId, appRow.ownerId, request.applicationRequestId)) return invalid();
    const ownerRowId = materialization.canonicalMaterializationReceiptId(pinned.tenantId, appRow.ownerId, request.applicationRequestId);
    const ownerRow = rowAt(ownerRowId, CANONICAL_MATERIALIZATION_RECEIPT, appRow.ownerId);
    const saved = ownerRow.data as StoredCanonicalMaterialization;
    if (![2, 3].includes(saved?.receiptVersion) || saved.input?.requestId !== request.applicationRequestId ||
        saved.result?.requestId !== request.applicationRequestId) return invalid();
    const binding = materialization.parseCanonicalMaterializationBinding(saved.binding, request.applicationRequestId);
    if (application.applicationHash(binding) !== application.applicationHash({ canonical: request.canonical,
      generationRequestId: request.generationRequestId, objectiveReceiptSha256: request.objectiveReceiptSha256,
      snapshotDigest: request.snapshotDigest })) return invalid();
    let predecessor: CanonicalMaterializationPredecessor | undefined;
    if (saved.receiptVersion === 3) {
      const reference = saved.reconciliation?.previous;
      if (!reference) return invalid();
      const priorOwnerRow = rowAt(application.applicationUuid(reference.ownerReceiptId), CANONICAL_MATERIALIZATION_RECEIPT);
      const priorOwner = priorOwnerRow.data as StoredCanonicalMaterialization;
      const priorRequest = application.applicationUuid(priorOwner?.input?.requestId);
      if (priorOwnerRow.id !== materialization.canonicalMaterializationReceiptId(pinned.tenantId, priorOwnerRow.ownerId, priorRequest)) return invalid();
      const old = read(application.applicationReceiptId(pinned.tenantId, priorOwnerRow.ownerId, priorRequest));
      predecessor = { owner: old.owner, applicationRequestId: old.stored.request.applicationRequestId,
        applicationAckSha256: old.stored.ackSha256, ownerReceiptId: old.ownerRowId,
        ownerReceiptSha256: application.applicationHash(old.owner) };
      if (application.applicationHash(reference) !== application.applicationHash({ applicationRequestId: predecessor.applicationRequestId,
        applicationAckSha256: predecessor.applicationAckSha256, ownerReceiptId: predecessor.ownerReceiptId,
        ownerReceiptSha256: predecessor.ownerReceiptSha256 })) return invalid();
    }
    const checked = materialization.checkedCanonicalMaterialization(saved, binding, pinned.tenantId, appRow.ownerId, predecessor);
    const stored = application.checkStoredApplication(raw, checked, ownerRowId);
    const pair = { receiptId, stored, owner: checked, ownerRowId, ownerClerkUserId: appRow.ownerId };
    pairs.set(receiptId, pair); return pair;
  };
  const receiptId = application.applicationReceiptId(pinned.tenantId, pinned.clerkUserId, pinned.work.applicationRequestId);
  const pair = read(receiptId); requireObjectivePlannerAppliedOperation(pinned, pair);
  const head = rowAt(application.applicationHeadId(pair.stored.request.canonical), CANONICAL_APPLICATION_HEAD, pinned.clerkUserId);
  const expectedHead = { schemaVersion: 1, canonical: pair.stored.request.canonical,
    applicationRequestId: pair.stored.request.applicationRequestId, ackSha256: pair.stored.ackSha256,
    source: pair.stored.ack.source, strategyId: pair.stored.ack.source.strategyId,
    projectId: pair.stored.request.canonical.canonicalProjectId };
  if (application.applicationHash(head.data) !== application.applicationHash(expectedHead)) invalid();
  return JSON.parse(application.applicationJson({ terminalReceiptId: receiptId, application: pair.stored, owner: pair.owner,
    consumedResourceIds: [...used], applications: [...pairs.values()] })) as ObjectivePlannerAppliedAccounting;
}
