import { objectiveJobFixture, id, hash } from '../../../meri/objective-job.fixture.js';
import { lockObjectiveStrategyIntakeWithinTx } from '@capiro/shared/objective-strategy-intake';
import { objectiveIntentFromSnapshot, objectiveStrategyDraftInput } from '@capiro/shared/strategy-intake';
import { canRetryObjectiveStrategyBeforePublication, objectiveGenerationLedgerId } from './objective-strategy-prepublication-retry.js';
import { objectiveStrategyRequestCodec as codec, parseObjectiveStrategySelection } from './objective-strategy-selection.js';
import type { WorkAuthority, WorkState } from './objective-work-command.js';
import { ObjectiveStrategyWorkOwner } from './objective-strategy-work-owner.js';

/** Actual immutable intake/access readers and transaction-branded job gate;
 * explicitly synthetic SQL rows. Native locking/CAS is qualified separately. */
function fixture() {
  const f = objectiveJobFixture(), { intake: i, consent: c, receipt: r, snapshot } = f.row;
  Object.assign(snapshot, { outcome: 'Synthetic outcome', governmentProblem: 'Synthetic problem', askType: 'funding', minimumWin: 'Synthetic win', limits: '' });
  for (const record of [i, c, r]) record.source_snapshot_hash = hash(snapshot);
  c.previous_consent_id = null; r.target_consent_id = null; r.control_version_before = 0;
  Object.assign(f.job, { status: 'queued', attempt: 1, claimedBy: null, claimedAt: null, strategyId: null, stage: null, error: null });
  const request = codec.parseObjectiveDraft(i.typed_request);
  f.job.input = { dto: objectiveStrategyDraftInput(i.client_id, request.type, objectiveIntentFromSnapshot(snapshot)), bearer: null,
    objectiveGeneration: { request, fingerprint: codec.digest(request), receipt: codec.pendingReceipt(request, {
      clientId: i.client_id, objectiveId: i.objective_id, objectiveVersion: i.source_objective_version, objectiveRevisionId: i.source_revision_id }) },
    objectiveCanonicalReservation: { schemaVersion: 1, intakeId: i.id, consentId: i.consent_id,
      commandReceiptId: i.command_receipt_id, wrapperSha256: i.wrapper_sha256 } };
  f.state.now = 6000;
  const a: WorkAuthority = { tenantId: i.tenant_id, clientId: i.client_id, objectiveId: i.objective_id,
    actorUserId: i.actor_user_id, actorMembershipId: i.actor_membership_id, clerkUserId: i.original_clerk_user_id,
    objectiveRevisionId: i.source_revision_id, objectiveVersion: i.source_objective_version, objectiveStatus: 'ready' };
  const source = { canonicalPlanId: i.canonical_plan_id, canonicalEpoch: i.canonical_epoch, canonicalStrategyId: i.canonical_strategy_id,
    canonicalProjectId: i.canonical_project_id, canonicalBindingVersion: i.canonical_binding_version, rootIntentId: i.root_intent_id,
    sourceRevisionId: i.source_revision_id, sourceObjectiveVersion: i.source_objective_version,
    sourceSnapshotHash: i.source_snapshot_hash, rootActorUserId: i.root_actor_user_id };
  const work: WorkState = { source, control: { id: i.control_id, version: 1, currentConsentId: i.consent_id,
    cancelledAt: null, cancelledByUserId: null }, consent: { id: i.consent_id, source } as any };
  const selected = parseObjectiveStrategySelection(a.clientId, a.objectiveId, { schemaVersion: 2, command: {
    schemaVersion: 1, requestId: id(40), command: 'retry', workAction: 'objective.strategy.draft',
    expectedObjectiveVersion: a.objectiveVersion, expectedControlVersion: 1, expectedCanonicalBindingVersion: 1,
    targetAuthorizationRequestId: i.consent_id }, selection: { type: request.type, generationRequestId: id(41) } });
  const prior = [{ job: f.job, row: f.row }], resources: any[] = [], extraJobs: any[] = [];
  const unsafe = f.tx.$queryRawUnsafe.bind(f.tx), tagged = f.tx.$queryRaw.bind(f.tx);
  f.tx.$queryRawUnsafe = async (sql: string, ...args: any[]) => {
    if (sql.includes('pg_advisory_xact_lock')) return [{}];
    if (sql.includes('LIMIT 129 FOR UPDATE NOWAIT')) return [...prior.map(p => p.job), ...extraJobs];
    if (sql.includes('objective_strategy_output_gate')) return [{ acquired: true }];
    if (sql.includes('FROM sp_draft_job') && sql.includes('FOR UPDATE')) return prior.filter(p => p.job.id === args[1]).map(p => p.job);
    if (sql.includes('to_jsonb(i)')) return prior.filter(p => p.row.intake.id === args[1]).map(p => p.row);
    if (sql.includes('SELECT id::text AS id') && sql.includes('client_objective_strategy_intakes'))
      return prior.filter(p => p.job.id === args[1]).map(p => ({ id: p.row.intake.id }));
    return unsafe(sql, ...args);
  };
  f.tx.$queryRaw = async (parts: TemplateStringsArray, ...args: any[]) => {
    const sql = parts.join('?');
    if (sql.includes('FROM client_objective_strategy_intakes')) return prior.map(p => ({ id: p.row.intake.id }));
    if (sql.includes('SELECT stage,error_message')) return prior.filter(p => p.job.id === args[1]).map(p => ({ stage: p.job.stage, error: p.job.error }));
    if (sql.includes('FROM sp_planner_resources')) return resources;
    if (sql.includes('SELECT canonical_strategy_id')) return [{ strategyId: source.canonicalStrategyId }];
    if (sql.includes('SELECT role::text AS role')) return [{ role: 'standard_user' }];
    return tagged(parts, ...args);
  };
  function admit(p = prior[0]!) {
    const n = p.row.intake, admissionId = objectiveGenerationLedgerId('objective_canonical_generation_admission', a.tenantId, a.clerkUserId, p.job.id);
    delete p.job.input.objectiveCanonicalReservation; p.job.input.canonicalGeneration = { admissionId };
    const data = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1', canonical: {
      canonicalPlanId: source.canonicalPlanId, tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId,
      canonicalStrategyId: source.canonicalStrategyId, canonicalProjectId: source.canonicalProjectId,
      bindingVersion: source.canonicalBindingVersion, epoch: source.canonicalEpoch, requestedIntentId: source.rootIntentId,
      requestedObjectiveRevisionId: source.sourceRevisionId, requestedObjectiveVersion: source.sourceObjectiveVersion, snapshotHash: source.sourceSnapshotHash },
      actorUserId: a.actorUserId, clerkUserId: a.clerkUserId, consentId: n.consent_id, controlVersion: n.control_version,
      generationJobId: p.job.id, generationRequestId: n.generation_request_id, admittedAtMs: 2000, effectExpiresAtMs: 4500, expectedStrategyVersionId: null };
    const row = { id: admissionId, kind: 'objective_canonical_generation_admission', data,
      ownerId: a.clerkUserId, archived: false, projectId: null, version: 1, shareTokenHash: null };
    resources.push(row); return row;
  }
  const run = async () => canRetryObjectiveStrategyBeforePublication(f.tx, a, work, selected,
    await lockObjectiveStrategyIntakeWithinTx(f.tx, a.tenantId));
  function appendAttempt() {
    const next = JSON.parse(JSON.stringify(prior[0])), n = next.row.intake, nc = next.row.consent, nr = next.row.receipt;
    Object.assign(n, { id: id(51), generation_job_id: id(52), consent_id: id(53), command_receipt_id: id(54),
      command_request_id: id(55), generation_request_id: id(56), control_version: 2 });
    Object.assign(nc, { id: n.consent_id, command_receipt_id: n.command_receipt_id,
      command_request_id: n.command_request_id, previous_consent_id: i.consent_id });
    Object.assign(nr, { id: n.command_receipt_id, created_consent_id: n.consent_id, result_consent_id: n.consent_id,
      request_id: n.command_request_id, target_consent_id: i.consent_id, control_version_before: 1, control_version_after: 2 });
    Object.assign(nr.command, { requestId: n.command_request_id, expectedControlVersion: 1, targetAuthorizationRequestId: i.consent_id });
    n.wrapper.command = nr.command; n.wrapper.selection.generationRequestId = n.generation_request_id;
    n.wrapper_sha256 = codec.digest({ clientId: a.clientId, objectiveId: a.objectiveId, body: n.wrapper });
    n.typed_request.requestId = n.generation_request_id; n.request_fingerprint = codec.digest(n.typed_request);
    n.job_request_key = codec.requestKey(a.tenantId, a.clerkUserId, n.generation_request_id);
    Object.assign(next.job, { id: n.generation_job_id, requestKey: n.job_request_key });
    next.job.input.objectiveGeneration = { request: n.typed_request, fingerprint: n.request_fingerprint,
      receipt: codec.pendingReceipt(n.typed_request, f.job.input.objectiveGeneration.receipt.source) };
    next.job.input.objectiveCanonicalReservation = { schemaVersion: 1, intakeId: n.id, consentId: n.consent_id,
      commandReceiptId: n.command_receipt_id, wrapperSha256: n.wrapper_sha256 };
    delete next.job.input.canonicalGeneration;
    prior.push(next); work.control!.version = 2; work.control!.currentConsentId = n.consent_id;
    work.consent = { id: n.consent_id, source } as any;
    selected.work.command.expectedControlVersion = 2; selected.work.command.targetAuthorizationRequestId = n.consent_id;
    return next;
  }
  return { ...f, a, work, selected, prior, resources, extraJobs, admit, appendAttempt, run };
}

describe('fresh consent only for proven Strategy attempts before publication', () => {
  test.each([false, true])('expired queued attempt qualifies without changing its immutable records; admitted=%s', async admitted => {
    const f = fixture(); if (admitted) f.admit();
    const before = JSON.stringify({ prior: f.prior, work: f.work, resources: f.resources });
    await expect(f.run()).resolves.toBe(true);
    expect(JSON.stringify({ prior: f.prior, work: f.work, resources: f.resources })).toBe(before);
  });
  test('exact owner-confirmed context failure qualifies before expiry, never a generic failed status', async () => {
    const f = fixture(); f.admit(); f.state.now = 4000;
    f.job.status = f.job.stage = 'failed';
    f.job.error = 'Government relationship context is incomplete. Review its coverage before generating.';
    const receipt = f.job.input.objectiveGeneration.receipt;
    receipt.failure = { code: 'OBJECTIVE_CONTEXT_INCOMPLETE', message: f.job.error };
    receipt.context.state = 'incomplete'; receipt.context.issues = [{ group: 'target_recommendations',
      code: 'REQUIRED_FIELDS_EXCEED_PACKET_BUDGET', message: 'Required fields do not fit the approved context budget.' }];
    await expect(f.run()).resolves.toBe(true);
    receipt.failure.code = 'OBJECTIVE_GENERATION_FAILED'; await expect(f.run()).resolves.toBe(false);
  });
  test.each(['live', 'claimed', 'running', 'attempt', 'strategy', 'result', 'source', 'actor', 'wall', 'membership',
    'cancelled', 'control', 'target', 'reused-command', 'reused-generation', 'type', 'dto', 'extra-input', 'missing-intake'])('refuses %s uncertainty', async defect => {
    const f = fixture();
    if (defect === 'live') f.state.now = 4999;
    if (defect === 'claimed') f.job.claimedAt = new Date(1000);
    if (defect === 'running') f.job.status = 'running';
    if (defect === 'attempt') f.job.attempt = 2;
    if (defect === 'strategy') f.job.strategyId = id(12);
    if (defect === 'result') f.job.input.objectiveGeneration.receipt.result = {};
    if (defect === 'source') f.work.source.sourceSnapshotHash = 'f'.repeat(64);
    if (defect === 'actor') f.row.intake.actor_user_id = id(90);
    if (defect === 'wall') f.state.wall = false;
    if (defect === 'membership') f.state.member = false;
    if (defect === 'cancelled') f.work.control!.cancelledAt = new Date(1000).toISOString();
    if (defect === 'control') f.selected.work.command.expectedControlVersion++;
    if (defect === 'target') f.selected.work.command.targetAuthorizationRequestId = id(90);
    if (defect === 'reused-command') f.selected.work.command.requestId = f.row.intake.command_request_id;
    if (defect === 'reused-generation') f.selected.selection.generationRequestId = f.row.intake.generation_request_id;
    if (defect === 'type') f.selected.selection.type = 'coalition';
    if (defect === 'dto') f.job.input.dto.goal = 'Substituted';
    if (defect === 'extra-input') f.job.input.unobservedRun = {};
    if (defect === 'missing-intake') f.prior.length = 0;
    await expect(f.run()).resolves.toBe(false);
  });
  test.each(['request', 'acceptance', 'normalization', 'producer'])('even a renamed %s ledger blocks retry without trusting its body', async kind => {
    const f = fixture(); f.admit();
    f.resources.push({ id: objectiveGenerationLedgerId(`objective_canonical_generation_${kind}`, f.a.tenantId, f.a.clerkUserId, f.job.id),
      kind: 'renamed', data: {} });
    await expect(f.run()).resolves.toBe(false);
  });
  test.each(['missing', 'renamed', 'archived', 'owner', 'source', 'deadline', 'extra', 'unknown-ledger'])('refuses %s admission evidence', async defect => {
    const f = fixture(), row = f.admit();
    if (defect === 'missing') f.resources.length = 0;
    if (defect === 'renamed') row.kind = 'renamed';
    if (defect === 'archived') row.archived = true;
    if (defect === 'owner') row.ownerId = 'user_other';
    if (defect === 'source') row.data.canonical.objectiveId = id(90);
    if (defect === 'deadline') row.data.effectExpiresAtMs = 7000;
    if (defect === 'extra') Object.assign(row.data, { ignored: true });
    if (defect === 'unknown-ledger') f.resources.push({ id: id(90), kind: 'objective_future_receipt', data: {} });
    await expect(f.run()).resolves.toBe(false);
  });
  test('requires the complete immutable prior chain, including absence of publication on earlier attempts', async () => {
    const f = fixture(); f.appendAttempt(); f.admit(f.prior[0]); f.admit(f.prior[1]);
    await expect(f.run()).resolves.toBe(true);
    f.resources.push({ id: objectiveGenerationLedgerId('objective_canonical_generation_request', f.a.tenantId, f.a.clerkUserId, f.job.id),
      kind: 'renamed', data: {} });
    await expect(f.run()).resolves.toBe(false);
    f.resources.pop(); f.prior.shift();
    await expect(f.run()).resolves.toBe(false);
  });
  test.each(['same-objective', 'null-envelope', 'orphan-marker', 'substituted-fingerprint'])('refuses %s outside the verified chain', async defect => {
    const f = fixture(), orphan = JSON.parse(JSON.stringify(f.job)); orphan.id = id(80);
    if (defect === 'null-envelope') orphan.input.objectiveGeneration = null;
    if (defect === 'orphan-marker') delete orphan.input.objectiveGeneration;
    if (defect === 'substituted-fingerprint') orphan.input.objectiveGeneration.fingerprint = 'a'.repeat(64);
    f.extraJobs.push(orphan); await expect(f.run()).resolves.toBe(false);
  });
  test.each([false, true])('writer owner additionally requires global canonical output absence; occupied=%s', async occupied => {
    const f = fixture(), audit = jest.fn(async () => ({}));
    const prisma = { withSystem: async (run: any) => run({ $queryRaw: async () => [{ occupied }], auditLog: { create: audit } }) } as any;
    const owner = new ObjectiveStrategyWorkOwner({ OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: '60000' }, prisma);
    const ctx = { tenantId: f.a.tenantId, userId: f.a.actorUserId, role: 'standard_user' } as any;
    owner.bindStrategySelectionWithinTx(f.tx, ctx, f.selected); await owner.lockWithinTx(f.tx, ctx, f.selected.work);
    owner.observeLockedStrategyStateWithinTx(f.tx, f.a, 'objective.strategy.draft', f.work);
    expect((await owner.reconcileWithinTx(f.tx, f.a, 'objective.strategy.draft', f.work)).state)
      .toBe(occupied ? 'outcome_unconfirmed' : 'not_started');
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
