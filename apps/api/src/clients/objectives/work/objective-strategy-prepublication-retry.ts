import type { Prisma } from '@prisma/client';
import { objectiveIntentFromSnapshot, objectiveStrategyDraftInput } from '@capiro/shared/strategy-intake';
import { readObjectiveStrategyIntakeWithinTx, readObjectiveStrategyJobSubjectWithinTx,
  requireObjectiveStrategyJobInventory, type ObjectiveStrategyJobInventory } from '@capiro/shared/objective-strategy-intake';
import { objectiveStrategyRequestCodec as codec, parseObjectiveStrategySelection, type ObjectiveStrategySelectionRequest } from './objective-strategy-selection.js';
import { workDigest, workUuid, type WorkAuthority, type WorkState } from './objective-work-command.js';

type Tx = Prisma.TransactionClient;
type Row = Record<string, any>;
const ADMISSION = 'objective_canonical_generation_admission';
const LINKED = ['objective_canonical_generation_request', 'objective_canonical_generation_acceptance',
  'objective_canonical_generation_normalization', 'objective_canonical_generation_producer'];
export function objectiveGenerationLedgerId(kind: string, tenantId: string, clerkUserId: string, jobId: string): string {
  const h = workDigest([kind, tenantId, clerkUserId, jobId]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const same = (a: unknown, b: unknown) => workDigest(a) === workDigest(b);
const FAILURE = 'Government relationship context is incomplete. Review its coverage before generating.';
const ISSUE_GROUPS = ['government_targets', 'government_profile_support', 'represented_facilities',
  'current_directory', 'member_notes', 'target_recommendations', 'state_directory', 'relationship_history'];
const ISSUE_MESSAGES: Record<string, string> = {
  REQUIRED_CONTEXT_UNAVAILABLE: 'Required context could not be completely observed.',
  REQUIRED_FIELDS_EXCEED_PACKET_BUDGET: 'Required fields do not fit the approved context budget.',
};

/** Existing job-owner failure projection only. A generic failed job or text
 * error is not evidence that no model was dispatched. The whole original
 * pending receipt survives, except for the owner's safe failure/issue fields. */
function expectedReceipt(pending: Row, actual: Row, status: string, stage: string | null, error: string | null) {
  if (status === 'queued') return error === null && same(actual, pending);
  const issues = actual?.context?.issues;
  if (status !== 'failed' || stage !== 'failed' || error !== FAILURE || !Array.isArray(issues) || !issues.length ||
      issues.some(i => !ISSUE_GROUPS.includes(i?.group) || !Object.hasOwn(ISSUE_MESSAGES, i?.code) ||
        !same(i, { group: i.group, code: i.code, message: ISSUE_MESSAGES[i.code] }))) return false;
  return same(actual, { ...pending, failure: { code: 'OBJECTIVE_CONTEXT_INCOMPLETE', message: FAILURE },
    context: { ...pending.context, state: 'incomplete', issues } });
}

/** No new authority: use the existing complete, locked job inventory, immutable
 * native intake reader and current access owner. The caller holds the canonical
 * output gate and Core source/control write locks, and separately proves that
 * the globally reserved Strategy/version IDs have never been written.
 *
 * Every prior attempt must have stopped BEFORE request publication. Publication
 * alone is uncertain even without an acceptance: Meri could have lost a reply.
 * No original row, deadline, receipt or cancellation is changed here. */
export async function canRetryObjectiveStrategyBeforePublication(tx: Tx, a: WorkAuthority, state: WorkState,
  selected: ObjectiveStrategySelectionRequest, inventory: ObjectiveStrategyJobInventory): Promise<boolean> {
  try {
    const c = state.control, s = state.source;
    if (!c || !state.consent || c.cancelledAt !== null || c.cancelledByUserId !== null ||
        c.currentConsentId !== state.consent.id || !same(state.consent.source, s) ||
        selected.work.command.expectedControlVersion !== c.version ||
        selected.work.command.targetAuthorizationRequestId !== c.currentConsentId) return false;
    const jobs = requireObjectiveStrategyJobInventory(tx, a.tenantId, inventory);
    const ids = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id
      FROM client_objective_strategy_intakes WHERE tenant_id=${a.tenantId}::uuid AND
        (objective_id=${a.objectiveId}::uuid OR canonical_plan_id=${s.canonicalPlanId}::uuid OR
         canonical_strategy_id=${s.canonicalStrategyId}::uuid OR canonical_project_id=${s.canonicalProjectId}::uuid)
      ORDER BY id LIMIT 129`;
    if (!ids.length || ids.length > 128 || new Set(ids.map(r => r.id)).size !== ids.length) return false;
    const prior = [];
    for (const { id } of ids) {
      const saved = await readObjectiveStrategyIntakeWithinTx(tx, a.tenantId, id), i = saved.intake;
      const job = jobs.find(j => j.id === i.generation_job_id);
      if (!job || job.clientId !== a.clientId || job.ownerUserId !== a.clerkUserId || job.attempt !== 1 ||
          job.claimedBy !== null || job.claimedAt !== null || job.strategyId !== null ||
          !['queued', 'failed'].includes(job.status)) return false;
      // This shared owner verifies actual immutable job/intake/consent/receipt,
      // original deadline/snapshot and current tenant/member/client/wall access.
      const subject = await readObjectiveStrategyJobSubjectWithinTx(tx, {
        tenantId: a.tenantId, generationJobId: job.id, effect: false,
      });
      const source = { canonicalPlanId: i.canonical_plan_id, canonicalEpoch: i.canonical_epoch,
        canonicalStrategyId: i.canonical_strategy_id, canonicalProjectId: i.canonical_project_id,
        canonicalBindingVersion: i.canonical_binding_version, rootIntentId: i.root_intent_id,
        sourceRevisionId: i.source_revision_id, sourceObjectiveVersion: i.source_objective_version,
        sourceSnapshotHash: i.source_snapshot_hash, rootActorUserId: i.root_actor_user_id };
      if (!same(source, s) || i.control_id !== c.id || i.actor_user_id !== a.actorUserId ||
          i.actor_membership_id !== a.actorMembershipId || subject.actorUserId !== a.actorUserId ||
          subject.consentId !== i.consent_id || subject.controlVersion !== i.control_version ||
          i.selected_type !== selected.selection.type || i.command_request_id === selected.work.command.requestId ||
          i.generation_request_id === selected.selection.generationRequestId) return false;
      const details = await tx.$queryRaw<Array<{ stage: string | null; error: string | null }>>`
        SELECT stage,error_message AS error FROM sp_draft_job WHERE tenant_id=${a.tenantId}::uuid AND id=${job.id}::uuid`;
      if (details.length !== 1) return false;
      const old = parseObjectiveStrategySelection(a.clientId, a.objectiveId, i.wrapper);
      if (old.work.command.expectedControlVersion !== i.control_version - 1 ||
          old.work.command.expectedCanonicalBindingVersion !== s.canonicalBindingVersion ||
          old.work.command.expectedObjectiveVersion !== s.sourceObjectiveVersion ||
          old.work.command.targetAuthorizationRequestId !== saved.consent.previous_consent_id ||
          old.selection.type !== i.selected_type || old.selection.generationRequestId !== i.generation_request_id) return false;
      const input = job.input as Row, request = codec.parseObjectiveDraft(i.typed_request);
      const pending = codec.pendingReceipt(request, { clientId: a.clientId, objectiveId: a.objectiveId,
        objectiveVersion: s.sourceObjectiveVersion, objectiveRevisionId: s.sourceRevisionId });
      const envelope = input?.objectiveGeneration;
      if (!expectedReceipt(pending, envelope?.receipt, job.status, details[0]!.stage, details[0]!.error)) return false;
      const admissionId = objectiveGenerationLedgerId(ADMISSION, a.tenantId, a.clerkUserId, job.id);
      const admitted = Object.hasOwn(input, 'canonicalGeneration');
      const marker = admitted ? { canonicalGeneration: { admissionId } } : { objectiveCanonicalReservation: {
        schemaVersion: 1, intakeId: i.id, consentId: i.consent_id, commandReceiptId: i.command_receipt_id,
        wrapperSha256: i.wrapper_sha256 } };
      if (!same(input, { dto: objectiveStrategyDraftInput(a.clientId, request.type, objectiveIntentFromSnapshot(saved.snapshot)),
        bearer: null, objectiveGeneration: { request, fingerprint: codec.digest(request), receipt: envelope.receipt }, ...marker })) return false;
      if (job.status === 'failed' && !admitted) return false;
      if (job.status === 'queued' && subject.checkedAtMs < Math.max(Number(saved.deadlineMs), Number(saved.consentExpiresMs))) return false;
      prior.push({ saved, job, admissionId, admitted, now: subject.checkedAtMs });
    }
    // Retain one complete immutable consent chain. An orphan/missing attempt,
    // cancellation gap, substituted owner or source remains uncertain.
    const chain = new Map(prior.map(p => [p.saved.intake.consent_id, p]));
    let current = c.currentConsentId, version = c.version, count = 0;
    while (current !== null) {
      const p = chain.get(current); if (!p || ++count > prior.length) return false;
      const { intake: i, consent, receipt } = p.saved;
      if (i.control_version !== version || receipt.control_version_before !== version - 1 ||
          consent.previous_consent_id !== receipt.target_consent_id ||
          receipt.command.targetAuthorizationRequestId !== consent.previous_consent_id) return false;
      current = consent.previous_consent_id; version--;
    }
    if (count !== prior.length || version !== 0) return false;
    const resources = await tx.$queryRaw<Row[]>`SELECT id::text AS id,kind,data,owner_id AS "ownerId",archived,
      project_id::text AS "projectId",version,share_token_hash AS "shareTokenHash"
      FROM sp_planner_resources WHERE tenant_id=${a.tenantId}::uuid ORDER BY id LIMIT 257`;
    if (resources.length > 256) return false;
    const admissions = new Map(prior.filter(p => p.admitted).map(p => [p.admissionId, p]));
    const prohibited = new Set(prior.flatMap(p => LINKED.map(kind => objectiveGenerationLedgerId(kind, a.tenantId, a.clerkUserId, p.job.id))));
    const seen = new Set<string>();
    const canonical = { canonicalPlanId: s.canonicalPlanId, tenantId: a.tenantId, clientId: a.clientId,
      objectiveId: a.objectiveId, canonicalStrategyId: s.canonicalStrategyId, canonicalProjectId: s.canonicalProjectId,
      bindingVersion: s.canonicalBindingVersion, epoch: s.canonicalEpoch, requestedIntentId: s.rootIntentId,
      requestedObjectiveRevisionId: s.sourceRevisionId, requestedObjectiveVersion: s.sourceObjectiveVersion, snapshotHash: s.sourceSnapshotHash };
    const foreignLinked = new Map<string, unknown>();
    for (const job of jobs) {
      const admission = resources.find(r => r.id === objectiveGenerationLedgerId(ADMISSION, a.tenantId, job.ownerUserId, job.id));
      if (admission?.kind === ADMISSION) for (const kind of LINKED)
        foreignLinked.set(`${kind}:${objectiveGenerationLedgerId(kind, a.tenantId, job.ownerUserId, job.id)}`, admission.data?.canonical);
    }
    for (const row of resources) {
      if (prohibited.has(row.id)) return false;
      const p = admissions.get(row.id), d = row.data;
      if (p) {
        const i = p.saved.intake;
        if (seen.has(row.id) || row.kind !== ADMISSION || row.ownerId !== a.clerkUserId || row.archived !== false ||
            row.projectId !== null || row.version !== 1 || row.shareTokenHash !== null ||
            !Number.isSafeInteger(d?.admittedAtMs) || !Number.isSafeInteger(d?.effectExpiresAtMs) ||
            d.admittedAtMs < Number(p.saved.reservedMs) || d.effectExpiresAtMs <= d.admittedAtMs ||
            d.effectExpiresAtMs > Number(p.saved.deadlineMs) ||
            p.job.status === 'queued' && p.now < d.effectExpiresAtMs ||
            !same(d, { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1', canonical,
              actorUserId: a.actorUserId, clerkUserId: a.clerkUserId, consentId: i.consent_id, controlVersion: i.control_version,
              generationJobId: p.job.id, generationRequestId: i.generation_request_id, admittedAtMs: d.admittedAtMs,
              effectExpiresAtMs: d.effectExpiresAtMs, expectedStrategyVersionId: null })) return false;
        seen.add(row.id); continue;
      }
      const candidates = [d?.canonical, d?.sourceAdmission?.canonical, d?.request?.canonical,
        d?.binding?.canonical, d?.work?.canonical, foreignLinked.get(`${row.kind}:${row.id}`)] as Row[];
      if (candidates.some(v => v && (v.canonicalPlanId === s.canonicalPlanId || v.objectiveId === a.objectiveId ||
          v.canonicalStrategyId === s.canonicalStrategyId || v.canonicalProjectId === s.canonicalProjectId)) ||
          row.kind.startsWith('objective_') && !candidates.some(v => v && typeof v.canonicalPlanId === 'string' && typeof v.objectiveId === 'string')) return false;
    }
    if (seen.size !== admissions.size) return false;
    // Match the initial owner's complete foreign-job observation. Malformed or
    // orphan Objective envelopes cannot be silently classified as unrelated.
    for (const job of jobs) {
      if (prior.some(p => p.job.id === job.id)) continue;
      const input = job.input as Row;
      if (!input || typeof input !== 'object' || Array.isArray(input) || job.strategyId === s.canonicalStrategyId) return false;
      const hasObjective = Object.hasOwn(input, 'objectiveGeneration'),
        hasCanonical = Object.hasOwn(input, 'canonicalGeneration'), hasReservation = Object.hasOwn(input, 'objectiveCanonicalReservation');
      if (hasCanonical && hasReservation) return false;
      if (hasCanonical) {
        const marker = input.canonicalGeneration;
        if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
            Object.keys(marker).sort().join(',') !== 'admissionId' || workUuid(marker.admissionId) !== marker.admissionId) return false;
      }
      if (hasReservation) codec.parseReservation(input.objectiveCanonicalReservation);
      if (hasObjective) {
        const envelope = input.objectiveGeneration;
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
            Object.keys(envelope).some(key => !['request', 'fingerprint', 'receipt', 'localDigest', 'externalDigest',
              'historyDigest', 'historyObservedAt', 'historyCheckedAt', 'coverage', 'contactIds'].includes(key))) return false;
        const request = codec.parseObjectiveDraft(envelope.request), receipt = envelope.receipt, source = receipt?.source;
        if (request.clientId !== job.clientId || envelope.fingerprint !== codec.digest(request) ||
            !receipt || receipt.schemaVersion !== 1 || receipt.requestId !== request.requestId || !source ||
            Object.keys(source).sort().join(',') !== 'clientId,objectiveId,objectiveRevisionId,objectiveVersion' ||
            source.clientId !== request.clientId || source.objectiveId !== request.objective.objectiveId ||
            source.objectiveVersion !== request.objective.objectiveVersion ||
            workUuid(source.objectiveRevisionId) !== source.objectiveRevisionId || request.objective.objectiveId === a.objectiveId) return false;
      } else if (hasCanonical || hasReservation) return false;
    }
    return true;
  } catch { return false; }
}
