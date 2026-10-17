import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { Prisma } from '@prisma/client';
import { createPlannerApplicationCodec } from '@capiro/shared/objective-planner-owner-codec';
import { OBJECTIVE_CONSENT_POLICY } from '../../../auth/workload-authority/objective-consent-policy.js';
import { OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { parseWorkCommand, workDigest, workFailure, workUuid,
  type WorkAuthority, type WorkState, type WorkSource, type WorkConsent } from './objective-work-command.js';

type Json = Record<string, any>;
export interface ObjectivePlannerCurrentConsentProof {
  readonly originalClerkUserId: string;
  readonly controlVersion: number;
  readonly confirmedAtMs: number;
  readonly committedAtMs: number;
  readonly expiresAtMs: number;
  readonly consentId: string;
  readonly previousConsentId: string | null;
  readonly actorUserId: string;
  readonly membershipId: string;
}
const PLAN = 'objective.plan.prepare';
const MAX_DURATION = 1_800_000;
const application = createPlannerApplicationCodec({ isProxy: nodeTypes.isProxy,
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex') });
const fail = (): never => workFailure('OUTCOME_UNCONFIRMED');
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
function integer(value: unknown, minimum = 1, maximum = 2147483647): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || /^[0-9a-f]{64}$/.exec(value)?.[0] !== value) fail();
}
/** PostgreSQL to_jsonb(timestamptz) retains the session offset/microseconds. */
function timestamp(value: unknown): number {
  if (typeof value !== 'string' ||
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[0] !== value) return fail();
  const result = Date.parse(value), suffix = value.slice(-6);
  const offset = value.endsWith('Z') ? 0 :
    (suffix[0] === '+' ? 1 : -1) * (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4, 6))) * 60_000;
  if (!Number.isSafeInteger(result) || result < 0 ||
      new Date(result + offset).toISOString().slice(0, 19) !== value.slice(0, 19)) return fail();
  return result;
}
const sourceKeys = ['canonical_plan_id', 'canonical_epoch', 'canonical_strategy_id', 'canonical_project_id',
  'canonical_binding_version', 'root_intent_id', 'source_revision_id', 'source_objective_version',
  'source_snapshot_hash', 'root_actor_user_id'];
const stateSourceKeys = ['canonicalPlanId', 'canonicalEpoch', 'canonicalStrategyId', 'canonicalProjectId',
  'canonicalBindingVersion', 'rootIntentId', 'sourceRevisionId', 'sourceObjectiveVersion',
  'sourceSnapshotHash', 'rootActorUserId'];
const scopeKeys = ['id', 'tenant_id', 'client_id', 'objective_id', 'work_action', 'control_id', ...sourceKeys];
const consentKeys = [...scopeKeys, 'previous_consent_id', 'consenting_actor_user_id', 'consenting_membership_id',
  'consent_policy_id', 'consent_policy_revision', 'configured_duration_ms', 'effective_duration_ms',
  'stricter_expires_at', 'stricter_limit_ref', 'confirmed_at', 'expires_at', 'command_request_id', 'command_receipt_id', 'payload_digest'];
const receiptKeys = [...scopeKeys, 'actor_user_id', 'actor_membership_id', 'request_id', 'payload_digest', 'command',
  'command_kind', 'command_revision_id', 'command_objective_version', 'control_version_before', 'control_version_after',
  'target_consent_id', 'created_consent_id', 'result_consent_id', 'outcome', 'committed_at'];

/** Current-consent consistency for retained-head READ accounting only. The
 * caller owns the Planner/Core gates, current native human/source authority,
 * complete older applied anchor and exact absence proof. This helper neither
 * invents an operation nor grants policy, command or effect authority. Original
 * actor/member joins identify issuance custody; they are not current grants.
 * Original expiry may have passed: only original timing is verified here. */
export async function verifyObjectivePlannerCurrentConsentWithinTx(tx: Prisma.TransactionClient,
  rawAuthority: WorkAuthority, rawState: WorkState): Promise<ObjectivePlannerCurrentConsentProof> {
  try {
    // Validate and detach all caller data before the first await. The shared
    // strict JSON codec rejects proxies/accessors without invoking their traps.
    const a = closed(copy(rawAuthority), ['tenantId', 'actorUserId', 'actorMembershipId', 'clerkUserId',
      'clientId', 'objectiveId', 'objectiveRevisionId', 'objectiveVersion', 'objectiveStatus']);
    const state = closed(copy(rawState), ['source', 'control', 'consent']);
    const source = closed(state.source, stateSourceKeys);
    const control = closed(state.control, ['id', 'version', 'currentConsentId', 'cancelledAt', 'cancelledByUserId']);
    const consent = closed(state.consent, ['id', 'controlId', 'source', 'previousConsentId', 'actorUserId',
      'actorMembershipId', 'policyId', 'policyRevision', 'configuredDurationMs', 'effectiveDurationMs',
      'stricterExpiresAt', 'stricterLimitRef', 'confirmedAt', 'expiresAt', 'commandRequestId', 'commandReceiptId', 'payloadDigest']);
    const consentSource = closed(consent.source, stateSourceKeys);
    for (const field of ['tenantId', 'actorUserId', 'actorMembershipId', 'clientId', 'objectiveId', 'objectiveRevisionId']) uuid(a[field]);
    for (const field of ['canonicalPlanId', 'canonicalStrategyId', 'canonicalProjectId', 'rootIntentId', 'sourceRevisionId', 'rootActorUserId']) uuid(source[field]);
    for (const field of ['id', 'controlId', 'actorUserId', 'actorMembershipId', 'commandRequestId', 'commandReceiptId']) uuid(consent[field]);
    uuid(control.id); uuid(control.currentConsentId); hash(source.sourceSnapshotHash); hash(consent.payloadDigest);
    if (consent.previousConsentId !== null) uuid(consent.previousConsentId);
    if (typeof a.clerkUserId !== 'string' || !a.clerkUserId || a.clerkUserId.length > 128 ||
        a.objectiveStatus !== 'ready' || !integer(a.objectiveVersion) || a.objectiveRevisionId !== source.sourceRevisionId ||
        a.objectiveVersion !== source.sourceObjectiveVersion || source.canonicalEpoch !== 1 ||
        !integer(source.canonicalBindingVersion) || !integer(source.sourceObjectiveVersion) ||
        stateSourceKeys.some(key => source[key] !== consentSource[key]) ||
        !integer(control.version) || control.currentConsentId !== consent.id || control.id !== consent.controlId ||
        control.cancelledAt !== null || control.cancelledByUserId !== null || consent.previousConsentId === consent.id ||
        consent.policyId !== OBJECTIVE_CONSENT_POLICY.id || consent.policyRevision !== OBJECTIVE_CONSENT_POLICY.revision ||
        !integer(consent.configuredDurationMs, 1, MAX_DURATION) || !integer(consent.effectiveDurationMs, 1, MAX_DURATION) ||
        consent.effectiveDurationMs > consent.configuredDurationMs) fail();
    const capturedConfirmed = timestamp(consent.confirmedAt), capturedExpires = timestamp(consent.expiresAt);
    if (capturedExpires - capturedConfirmed !== consent.effectiveDurationMs ||
        (consent.stricterExpiresAt === null ? consent.stricterLimitRef !== null :
          timestamp(consent.stricterExpiresAt) !== capturedExpires || typeof consent.stricterLimitRef !== 'string' ||
          !consent.stricterLimitRef.trim() || consent.stricterLimitRef.length > 128)) fail();
    const native = await readNativeConsentWithinTx(tx, a as WorkAuthority, source as WorkSource,
      control.id, consent.id, control.version);
    for (const key of ['id', 'controlId', 'previousConsentId', 'actorUserId', 'actorMembershipId',
      'policyId', 'policyRevision', 'configuredDurationMs', 'effectiveDurationMs', 'stricterLimitRef',
      'commandRequestId', 'commandReceiptId', 'payloadDigest'])
      if (native.consent[key as keyof WorkConsent] !== consent[key]) fail();
    if (native.proof.confirmedAtMs !== capturedConfirmed || native.proof.expiresAtMs !== capturedExpires ||
        (native.consent.stricterExpiresAt === null ? consent.stricterExpiresAt !== null :
          consent.stricterExpiresAt === null ||
          timestamp(native.consent.stricterExpiresAt) !== timestamp(consent.stricterExpiresAt))) fail();
    return native.proof;
  } catch { return fail(); }
}

/** Immutable native consent lineage for an already-selected SAME ready source.
 * This has no operation/current-control substitute and grants no authority.
 * The chain caller independently proves original expiry, succession and absence. */
export async function verifyObjectivePlannerSameSourceConsentWithinTx(tx: Prisma.TransactionClient,
  authority: WorkAuthority, source: WorkSource, controlId: string, consentId: string,
  controlVersion: number): Promise<ObjectivePlannerCurrentConsentProof> {
  try {
    return (await readNativeConsentWithinTx(tx, authority, source, controlId, consentId, controlVersion)).proof;
  } catch { return fail(); }
}

async function readNativeConsentWithinTx(tx: Prisma.TransactionClient, rawAuthority: WorkAuthority,
  rawSource: WorkSource, rawControlId: string, rawConsentId: string, rawControlVersion: number):
  Promise<{ consent: WorkConsent; proof: ObjectivePlannerCurrentConsentProof }> {
  try {
    // Identity/source inputs are pinned before SQL. No historical WorkState or
    // operation is fabricated to invoke current-consent verification.
    const a = closed(copy(rawAuthority), ['tenantId', 'actorUserId', 'actorMembershipId', 'clerkUserId',
      'clientId', 'objectiveId', 'objectiveRevisionId', 'objectiveVersion', 'objectiveStatus']);
    const source = closed(copy(rawSource), stateSourceKeys), controlId = uuid(rawControlId),
      consentId = uuid(rawConsentId), controlVersion = rawControlVersion;
    for (const field of ['tenantId', 'actorUserId', 'actorMembershipId', 'clientId', 'objectiveId', 'objectiveRevisionId']) uuid(a[field]);
    for (const field of ['canonicalPlanId', 'canonicalStrategyId', 'canonicalProjectId', 'rootIntentId', 'sourceRevisionId', 'rootActorUserId']) uuid(source[field]);
    hash(source.sourceSnapshotHash);
    if (typeof a.clerkUserId !== 'string' || !a.clerkUserId || a.clerkUserId.length > 128 ||
        a.objectiveStatus !== 'ready' || !integer(a.objectiveVersion) || a.objectiveRevisionId !== source.sourceRevisionId ||
        a.objectiveVersion !== source.sourceObjectiveVersion || source.canonicalEpoch !== 1 ||
        !integer(source.canonicalBindingVersion) || !integer(source.sourceObjectiveVersion) || !integer(controlVersion)) fail();
    // Append-only rows deny UPDATE (which row locks require). Only mutable
    // identity rows are locked; WorkService owns current membership authority.
    const rows = await tx.$queryRaw<Array<{ consent: Json; receipt: Json; intent: Json; revision: Json; clerkUserId: string }>>`
      SELECT to_jsonb(c) AS consent,to_jsonb(r) AS receipt,to_jsonb(i) AS intent,
        to_jsonb(v) AS revision,u.clerk_user_id AS "clerkUserId"
      FROM client_objective_work_consents c
      JOIN client_objective_work_command_receipts r ON r.tenant_id=c.tenant_id AND r.client_id=c.client_id
        AND r.objective_id=c.objective_id AND r.work_action=c.work_action AND r.control_id=c.control_id AND r.id=c.command_receipt_id
      JOIN client_objective_work_intents i ON i.tenant_id=c.tenant_id AND i.client_id=c.client_id AND i.objective_id=c.objective_id
        AND i.id=c.root_intent_id AND i.objective_revision_id=c.source_revision_id AND i.objective_version=c.source_objective_version
      JOIN client_objective_revisions v ON v.tenant_id=i.tenant_id AND v.client_id=i.client_id AND v.objective_id=i.objective_id
        AND v.id=i.objective_revision_id AND v.version=i.objective_version
      JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.id=c.consenting_membership_id AND m.user_id=c.consenting_actor_user_id
      JOIN users u ON u.id=m.user_id
      WHERE c.tenant_id=${a.tenantId}::uuid AND c.client_id=${a.clientId}::uuid AND c.objective_id=${a.objectiveId}::uuid
        AND c.work_action=${PLAN} AND c.id=${consentId}::uuid AND c.control_id=${controlId}::uuid
      FOR SHARE OF m,u`;
    if (rows.length !== 1) fail();
    const row = closed(rows[0], ['consent', 'receipt', 'intent', 'revision', 'clerkUserId']);
    const c = closed(row.consent, consentKeys), r = closed(row.receipt, receiptKeys);
    const i = closed(row.intent, ['id', 'tenant_id', 'client_id', 'objective_id', 'objective_revision_id',
      'objective_version', 'actor_user_id', 'purpose', 'snapshot_hash', 'state', 'blocked_reason', 'created_at']);
    const v = closed(row.revision, ['id', 'tenant_id', 'client_id', 'objective_id', 'version', 'operation', 'actor_user_id', 'snapshot', 'created_at']);
    const expectedSource = { canonical_plan_id: source.canonicalPlanId, canonical_epoch: source.canonicalEpoch,
      canonical_strategy_id: source.canonicalStrategyId, canonical_project_id: source.canonicalProjectId,
      canonical_binding_version: source.canonicalBindingVersion, root_intent_id: source.rootIntentId,
      source_revision_id: source.sourceRevisionId, source_objective_version: source.sourceObjectiveVersion,
      source_snapshot_hash: source.sourceSnapshotHash, root_actor_user_id: source.rootActorUserId };
    for (const record of [c, r]) {
      if (record.tenant_id !== a.tenantId || record.client_id !== a.clientId || record.objective_id !== a.objectiveId ||
          record.work_action !== PLAN || record.control_id !== controlId) fail();
      for (const [key, value] of Object.entries(expectedSource)) if (record[key] !== value) fail();
    }
    for (const value of [c.id, c.command_request_id, c.command_receipt_id, c.consenting_actor_user_id,
      c.consenting_membership_id]) uuid(value);
    if (c.previous_consent_id !== null) uuid(c.previous_consent_id);
    hash(c.payload_digest);
    if (c.id !== consentId || c.previous_consent_id === c.id ||
        c.consent_policy_id !== OBJECTIVE_CONSENT_POLICY.id || c.consent_policy_revision !== OBJECTIVE_CONSENT_POLICY.revision ||
        !integer(c.configured_duration_ms, 1, MAX_DURATION) || !integer(c.effective_duration_ms, 1, MAX_DURATION) ||
        c.effective_duration_ms > c.configured_duration_ms) fail();
    // These fields come from the actual immutable row, never a synthesized state.
    const consent: WorkConsent = { id: c.id, controlId, source: copy(source) as WorkSource,
      previousConsentId: c.previous_consent_id, actorUserId: c.consenting_actor_user_id,
      actorMembershipId: c.consenting_membership_id, policyId: c.consent_policy_id,
      policyRevision: c.consent_policy_revision, configuredDurationMs: c.configured_duration_ms,
      effectiveDurationMs: c.effective_duration_ms, stricterExpiresAt: c.stricter_expires_at,
      stricterLimitRef: c.stricter_limit_ref, confirmedAt: c.confirmed_at, expiresAt: c.expires_at,
      commandRequestId: c.command_request_id, commandReceiptId: c.command_receipt_id, payloadDigest: c.payload_digest };
    const confirmedAtMs = timestamp(c.confirmed_at), expiresAtMs = timestamp(c.expires_at), committedAtMs = timestamp(r.committed_at);
    if (expiresAtMs - confirmedAtMs !== c.effective_duration_ms ||
        (c.stricter_expires_at === null ? c.stricter_limit_ref !== null :
          timestamp(c.stricter_expires_at) !== expiresAtMs || typeof c.stricter_limit_ref !== 'string' ||
          !c.stricter_limit_ref.trim() || c.stricter_limit_ref.length > 128) ||
        typeof row.clerkUserId !== 'string' || !row.clerkUserId || row.clerkUserId.length > 128 ||
        r.id !== consent.commandReceiptId || r.request_id !== consent.commandRequestId || r.payload_digest !== consent.payloadDigest ||
        r.actor_user_id !== consent.actorUserId || r.actor_membership_id !== consent.actorMembershipId ||
        r.created_consent_id !== consent.id || r.result_consent_id !== consent.id || r.target_consent_id !== consent.previousConsentId ||
        r.command_kind !== 'retry' || r.outcome !== 'reconsent_recorded' || !integer(r.control_version_before, 0) ||
        !integer(r.control_version_after) || r.control_version_after !== r.control_version_before + 1 ||
        r.control_version_after !== controlVersion || committedAtMs < confirmedAtMs || committedAtMs >= expiresAtMs) fail();
    const command = parseWorkCommand(a.clientId, a.objectiveId, r.command);
    if (command.command.command !== 'retry' || command.command.workAction !== PLAN ||
        command.command.requestId !== consent.commandRequestId || command.command.targetAuthorizationRequestId !== consent.previousConsentId ||
        command.command.expectedControlVersion !== r.control_version_before ||
        command.command.expectedObjectiveVersion !== source.sourceObjectiveVersion ||
        command.command.expectedCanonicalBindingVersion !== source.canonicalBindingVersion ||
        r.command_revision_id !== source.sourceRevisionId || r.command_objective_version !== source.sourceObjectiveVersion ||
        workDigest(command) !== consent.payloadDigest || workDigest(command.command) !== workDigest(r.command)) fail();
    if (i.tenant_id !== a.tenantId || i.client_id !== a.clientId || i.objective_id !== a.objectiveId ||
        i.id !== source.rootIntentId || i.objective_revision_id !== source.sourceRevisionId ||
        i.objective_version !== source.sourceObjectiveVersion || i.actor_user_id !== source.rootActorUserId ||
        i.snapshot_hash !== source.sourceSnapshotHash || i.purpose !== OBJECTIVE_WORK_PURPOSE ||
        i.state !== 'pending' || i.blocked_reason !== OBJECTIVE_WORK_BLOCKER ||
        v.tenant_id !== a.tenantId || v.client_id !== a.clientId || v.objective_id !== a.objectiveId ||
        v.id !== source.sourceRevisionId || v.version !== source.sourceObjectiveVersion ||
        v.actor_user_id !== source.rootActorUserId || v.operation !== 'confirm_ready') fail();
    const snapshot = v.snapshot;
    // closed(row) validated finite, accessor-free JSON before kernel workDigest.
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.status !== 'ready' ||
        snapshot.deletedAt !== null || snapshot.id !== a.objectiveId || snapshot.clientId !== a.clientId ||
        snapshot.version !== source.sourceObjectiveVersion || workDigest(snapshot) !== source.sourceSnapshotHash) fail();
    timestamp(i.created_at); timestamp(v.created_at);
    return { consent, proof: Object.freeze({ originalClerkUserId: row.clerkUserId, controlVersion: r.control_version_after,
      confirmedAtMs, committedAtMs, expiresAtMs, consentId: c.id, previousConsentId: c.previous_consent_id,
      actorUserId: c.consenting_actor_user_id, membershipId: c.consenting_membership_id }) };
  } catch { return fail(); }
}
