import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import { plannerResourceCalendarDate } from '@capiro/shared';
import { createPlannerApplicationCodec, createPlannerMaterializationCodec } from '@capiro/shared/objective-planner-owner-codec';
import { verifyObjectivePlannerSameSourceConsentWithinTx,
  type ObjectivePlannerCurrentConsentProof } from './objective-planner-current-consent-proof.js';
import { workDigest, workFailure, workUuid, type WorkAuthority, type WorkState } from './objective-work-command.js';

type Json = Record<string, any>;
export interface ObjectivePlannerUnusedConsentChainInput {
  readonly currentProof: ObjectivePlannerCurrentConsentProof;
  readonly anchorConsentId: string;
  readonly anchorControlVersion: number;
  readonly anchorTerminalAtMs: number;
  /** The owner supplies its COMPLETE bounded, parsed operation inventory. */
  readonly operationConsentIds: readonly string[];
}
const MAX_ROWS = 256;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const application = createPlannerApplicationCodec({ sha256, isProxy: nodeTypes.isProxy });
const fail = (): never => workFailure('OUTCOME_UNCONFIRMED');
const materialization = createPlannerMaterializationCodec({ sha256,
  digest: value => sha256(JSON.stringify(JSON.parse(application.applicationJson(value)))),
  canonicalRegenerationHash: application.applicationHash, plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: fail });
const copy = <T>(value: T): T => JSON.parse(application.applicationJson(value)) as T;
function closed(value: unknown, keys: string[]): Json {
  application.applicationJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return fail();
  return value as Json;
}
function uuid(value: unknown): string {
  if (workUuid(value) !== value) return fail();
  return value as string;
}
const positive = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const time = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const sourceKeys = ['canonicalPlanId', 'canonicalEpoch', 'canonicalStrategyId', 'canonicalProjectId',
  'canonicalBindingVersion', 'rootIntentId', 'sourceRevisionId', 'sourceObjectiveVersion', 'sourceSnapshotHash', 'rootActorUserId'];
function proof(value: unknown): ObjectivePlannerCurrentConsentProof {
  const p = closed(value, ['originalClerkUserId', 'controlVersion', 'confirmedAtMs', 'committedAtMs', 'expiresAtMs',
    'consentId', 'previousConsentId', 'actorUserId', 'membershipId']);
  for (const field of ['consentId', 'actorUserId', 'membershipId']) uuid(p[field]);
  if (p.previousConsentId !== null) uuid(p.previousConsentId);
  if (typeof p.originalClerkUserId !== 'string' || !p.originalClerkUserId || p.originalClerkUserId.length > 128 ||
      !positive(p.controlVersion) || !time(p.confirmedAtMs) || !time(p.committedAtMs) || !time(p.expiresAtMs) ||
      p.expiresAtMs <= p.confirmedAtMs || p.committedAtMs < p.confirmedAtMs || p.committedAtMs >= p.expiresAtMs ||
      p.previousConsentId === p.consentId) fail();
  return p as ObjectivePlannerCurrentConsentProof;
}

/** Historical unused-consent consistency/absence ONLY. The caller owns the
 * Planner/Core gates, current native consent proof, complete applied anchor,
 * complete operation inventory and current effect absence. This returns no
 * policy/effect grant and never renews a consent, generation, lease or deadline.
 * Each intermediate is read from native immutable lineage, not a fabricated
 * operation or a historical state assembled from the current control. */
export async function verifyObjectivePlannerUnusedConsentChainWithinTx(tx: Prisma.TransactionClient,
  rawAuthority: WorkAuthority, rawState: WorkState, rawInput: ObjectivePlannerUnusedConsentChainInput):
  Promise<readonly ObjectivePlannerCurrentConsentProof[]> {
  try {
    // Pin the full inventory and all inputs before the first await. Accessors,
    // proxies, symbols and non-finite/non-JSON values are rejected by the codec.
    const a = copy(rawAuthority), state = copy(rawState);
    const input = closed(copy(rawInput), ['currentProof', 'anchorConsentId', 'anchorControlVersion',
      'anchorTerminalAtMs', 'operationConsentIds']);
    const current = proof(input.currentProof), anchorConsentId = uuid(input.anchorConsentId);
    const source = closed(state.source, sourceKeys), consent = state.consent, control = state.control;
    if (!consent || !control) return fail();
    if (!positive(input.anchorControlVersion) || !time(input.anchorTerminalAtMs) ||
        current.consentId === anchorConsentId || current.controlVersion <= input.anchorControlVersion ||
        input.anchorTerminalAtMs > current.confirmedAtMs || !Array.isArray(input.operationConsentIds) ||
        input.operationConsentIds.length > MAX_ROWS ||
        current.consentId !== consent.id || current.previousConsentId !== consent.previousConsentId ||
        current.actorUserId !== consent.actorUserId || current.membershipId !== consent.actorMembershipId ||
        current.confirmedAtMs !== Date.parse(consent.confirmedAt) || current.expiresAtMs !== Date.parse(consent.expiresAt) ||
        current.controlVersion !== control.version || control.currentConsentId !== consent.id ||
        control.id !== consent.controlId || control.cancelledAt !== null || control.cancelledByUserId !== null ||
        workDigest(source) !== workDigest(consent.source) || a.objectiveStatus !== 'ready' ||
        a.objectiveRevisionId !== source.sourceRevisionId || a.objectiveVersion !== source.sourceObjectiveVersion) fail();
    uuid(control.id);
    const operationIds = new Set<string>();
    for (const value of input.operationConsentIds) operationIds.add(uuid(value));
    if (operationIds.has(current.consentId)) fail();
    const canonical = { tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId,
      canonicalPlanId: source.canonicalPlanId, canonicalStrategyId: source.canonicalStrategyId,
      canonicalProjectId: source.canonicalProjectId, bindingVersion: source.canonicalBindingVersion, epoch: source.canonicalEpoch,
      requestedIntentId: source.rootIntentId, requestedObjectiveRevisionId: source.sourceRevisionId,
      requestedObjectiveVersion: source.sourceObjectiveVersion, snapshotHash: source.sourceSnapshotHash };
    // Use the actual shared deterministic identity function on the direct path
    // too; the caller's current native proof owns complete source validation.
    application.canonicalApplicationRequestId(canonical, current.actorUserId);
    uuid(source.rootActorUserId);
    async function requireUnscopedOperationAbsence(consentIds: readonly string[]) {
      // A renamed/foreign-scoped/archived row can fall outside the owner's
      // bounded semantic inventory. Any tenant row bearing these exact work
      // consent identities defeats unused status, irrespective of kind/scope.
      const started = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_planner_resources
        WHERE tenant_id=${a.tenantId}::uuid AND data#>>'{work,consentId}'=ANY(${[...consentIds]}::text[]) LIMIT 1`;
      if (started.length !== 0) fail();
    }
    if (current.previousConsentId === anchorConsentId) {
      await requireUnscopedOperationAbsence([current.consentId]);
      return Object.freeze([]);
    }
    if (current.controlVersion - input.anchorControlVersion - 1 > MAX_ROWS) fail();
    const seen = new Set<string>([current.consentId, anchorConsentId]), bridges: ObjectivePlannerCurrentConsentProof[] = [];
    let successor = current;
    while (successor.previousConsentId !== anchorConsentId) {
      const consentId = successor.previousConsentId;
      if (consentId === null) return fail();
      if (seen.has(consentId) || bridges.length >= MAX_ROWS ||
          successor.controlVersion - 1 <= input.anchorControlVersion || operationIds.has(consentId)) fail();
      seen.add(consentId);
      const original = await verifyObjectivePlannerSameSourceConsentWithinTx(tx, a, source as WorkState['source'],
        control.id, consentId, successor.controlVersion - 1);
      if (original.consentId !== consentId || original.controlVersion !== successor.controlVersion - 1 ||
          original.expiresAtMs > successor.confirmedAtMs || original.committedAtMs > successor.confirmedAtMs) fail();
      // Application IDs are per source+ORIGINAL consenting actor and the actual
      // native issuance Clerk. Never use the current authorized reader's Clerk.
      const requestId = application.canonicalApplicationRequestId(canonical, original.actorUserId);
      const applicationId = application.applicationReceiptId(a.tenantId, original.originalClerkUserId, requestId);
      const ownerId = materialization.canonicalMaterializationReceiptId(a.tenantId, original.originalClerkUserId, requestId);
      const present = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_planner_resources
        WHERE tenant_id=${a.tenantId}::uuid AND id IN (${applicationId}::uuid,${ownerId}::uuid)`;
      // Hidden kind, owner or embedded scope at either exact address is still
      // effect uncertainty. No filtered absence probe may conceal it.
      if (present.length !== 0) fail();
      bridges.push(original); successor = original;
    }
    // Contiguous renewal-only controls exclude cancellation or unexplained
    // control hops between the applied anchor and the oldest unused consent.
    if (successor.controlVersion !== input.anchorControlVersion + 1 ||
        input.anchorTerminalAtMs > successor.confirmedAtMs) fail();
    await requireUnscopedOperationAbsence([current.consentId, ...bridges.map(bridge => bridge.consentId)]);
    return Object.freeze(bridges);
  } catch { return fail(); }
}
