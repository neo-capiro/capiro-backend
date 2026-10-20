import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import { plannerResourceCalendarDate } from '@capiro/shared';
import { createPlannerApplicationCodec, createPlannerMaterializationCodec } from '@capiro/shared/objective-planner-owner-codec';
import { OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { workDigest, type WorkAuthority } from './objective-work-command.js';
import { objectivePlannerHistoricalReceiptIds, verifyObjectivePlannerHistoricalConsentWithinTx } from './objective-planner-historical-proof.js';

type Json = Record<string, any>;
const id = (n: number) => `83000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const codec = createPlannerApplicationCodec({ isProxy: nodeTypes.isProxy,
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex') });
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const objectiveDigest = (value: unknown) => sha256(JSON.stringify(JSON.parse(codec.applicationJson(value))));
const materialization = createPlannerMaterializationCodec({ sha256, digest: objectiveDigest,
  canonicalRegenerationHash: codec.applicationHash, plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: () => { throw Error('Unconfirmed full v2 fixture'); } });
const now = Date.parse('2026-10-17T06:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();
const NAMESPACE = 'capiro.objective-planner.continuation:v1';
function privateId(value: unknown): string {
  const h = codec.applicationHash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Synthetic owner-local SQL rows. No native SQL, lock, current-authority or
 * applied-effect qualification is claimed by this historical metadata suite. */
function fixture(state = 'failed') {
  const a: WorkAuthority = { tenantId: id(1), clientId: id(2), objectiveId: id(3), actorUserId: id(50),
    actorMembershipId: id(51), clerkUserId: 'current_editor', objectiveRevisionId: id(52), objectiveVersion: 8, objectiveStatus: 'ready' };
  const snapshot = { id: id(3), clientId: id(2), version: 1, status: 'ready', deletedAt: null,
    outcome: 'Original ready source', numericKeys: { '10': 10, '2': 2 } };
  const canonical = { tenantId: id(1), clientId: id(2), objectiveId: id(3), canonicalPlanId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 1, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 1, snapshotHash: workDigest(snapshot) };
  const work = { canonical, applicationRequestId: codec.canonicalApplicationRequestId(canonical, id(9)),
    generationJobId: id(10), generationRequestId: id(11), strategyId: id(5), strategyVersionId: id(12),
    objectiveReceiptSha256: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64), actorUserId: id(9), consentId: id(14), controlVersion: 2 };
  const op: Json = { schemaVersion: 1, namespace: NAMESPACE, tenantId: id(1), clerkUserId: 'original_clerk', membershipId: id(19),
    work, original: { originalDeadlineAt: iso(30_000) }, state, lease: null, terminal: { receiptId: id(99), recordedAtMs: now } };
  const rebind = () => {
    const workSha256 = codec.applicationHash(op.work), operationId = privateId([NAMESPACE, op.work.applicationRequestId, op.work.consentId, workSha256]);
    op.original = { operationId, attemptId: privateId([NAMESPACE, 'attempt', operationId]), runId: privateId([NAMESPACE, 'run', operationId]),
      workSha256, originalDeadlineAt: op.original.originalDeadlineAt,
      requestFingerprint: codec.applicationHash({ namespace: NAMESPACE, workSha256, clerkUserId: op.clerkUserId,
        membershipId: op.membershipId, originalDeadlineAt: op.original.originalDeadlineAt }) };
    op.terminal.receiptId = op.state === 'applied' ? codec.applicationReceiptId(id(1), op.clerkUserId, work.applicationRequestId) : operationId;
  };
  rebind();
  const source = { canonical_plan_id: id(4), canonical_epoch: 1, canonical_strategy_id: id(5), canonical_project_id: id(6),
    canonical_binding_version: 1, root_intent_id: id(7), source_revision_id: id(8), source_objective_version: 1,
    source_snapshot_hash: canonical.snapshotHash, root_actor_user_id: id(15) };
  const controlId = id(16), command = { schemaVersion: 1, requestId: id(17), command: 'retry', workAction: 'objective.plan.prepare',
    expectedObjectiveVersion: 1, expectedControlVersion: 1, expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: id(18) };
  const payload = workDigest({ clientId: id(2), objectiveId: id(3), command });
  const row: Json = { consent: { id: id(14), tenant_id: id(1), client_id: id(2), objective_id: id(3),
    work_action: 'objective.plan.prepare', control_id: controlId, ...source, previous_consent_id: id(18),
    consenting_actor_user_id: id(9), consenting_membership_id: id(19), consent_policy_id: 'capiro.objective-generation-consent',
    consent_policy_revision: 1, configured_duration_ms: 600_000, effective_duration_ms: 60_000,
    stricter_expires_at: iso(50_000), stricter_limit_ref: 'original-owner-cap', confirmed_at: iso(-10_000), expires_at: iso(50_000),
    command_request_id: id(17), command_receipt_id: id(20), payload_digest: payload },
  receipt: { id: id(20), tenant_id: id(1), client_id: id(2), objective_id: id(3), work_action: 'objective.plan.prepare',
    control_id: controlId, ...source, actor_user_id: id(9), actor_membership_id: id(19), request_id: id(17), payload_digest: payload,
    command, command_kind: 'retry', command_revision_id: id(8), command_objective_version: 1,
    control_version_before: 1, control_version_after: 2, target_consent_id: id(18), created_consent_id: id(14), result_consent_id: id(14),
    outcome: 'reconsent_recorded', committed_at: iso(-9_000) },
  intent: { id: id(7), tenant_id: id(1), client_id: id(2), objective_id: id(3), objective_revision_id: id(8), objective_version: 1,
    actor_user_id: id(15), purpose: OBJECTIVE_WORK_PURPOSE, snapshot_hash: canonical.snapshotHash, state: 'pending',
    blocked_reason: OBJECTIVE_WORK_BLOCKER, created_at: iso(-20_000) },
  revision: { id: id(8), tenant_id: id(1), client_id: id(2), objective_id: id(3), version: 1, operation: 'confirm_ready',
    actor_user_id: id(15), snapshot, created_at: iso(-20_000) }, clerkUserId: 'original_clerk' };
  let rows = [row];
  const query = jest.fn(async function (this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx); const sql = strings.join('?');
    expect(sql).toMatch(/\bFOR SHARE OF m,u\s*$/); expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(sql).not.toContain("status='active'");
    expect(values).toEqual([id(1), id(2), id(3), 'objective.plan.prepare', id(14), controlId]); return rows;
  });
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  const read = () => verifyObjectivePlannerHistoricalConsentWithinTx(tx, a, controlId, op);
  return { a, row, op, query, tx, controlId, rebind, read, empty() { rows = []; }, duplicate() { rows.push(row); } };
}

/** The retained fullV2 codec fixture's exact IDs, reconstructed through the
 * actual owner/application factories rather than a partial receipt body. */
function fullV2Fixture() {
  const key = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const at = '2026-10-16T12:00:00.000Z', clerkUserId = 'user_original';
  const canonical = { tenantId: key(1), clientId: key(2), objectiveId: key(3), canonicalPlanId: key(7),
    canonicalStrategyId: key(8), canonicalProjectId: key(9), bindingVersion: 1, epoch: 1,
    requestedIntentId: key(10), requestedObjectiveRevisionId: key(6), requestedObjectiveVersion: 1,
    snapshotHash: codec.applicationHash({ id: key(3), clientId: key(2), version: 1, status: 'ready', deletedAt: null }) };
  const snapshot = { meta: { id: key(8), clientId: key(2), title: 'Saved project', type: 'legislative', goal: null,
    meriContext: null, meriSummary: null, targetDate: null, ownerUserId: clerkUserId, createdByUserId: clerkUserId, createdAt: at },
  nodes: [101, 102].map((n, index) => ({ id: key(n), kind: 'action', subject: 'deliverable', title: index ? 'Prior work' : 'Original work',
    note: 'Saved note', ownerUserId: null, status: 'draft', startsOn: '2026-10-16', endsOn: '2026-10-17', openEnded: false,
    dependsOnIds: [], meriAuthored: true, createdByUserId: clerkUserId, createdAt: at })) };
  const work = { canonical, applicationRequestId: codec.canonicalApplicationRequestId(canonical, key(14)),
    generationJobId: key(18), generationRequestId: key(19), strategyId: key(8), strategyVersionId: key(20),
    objectiveReceiptSha256: 'c'.repeat(64), snapshotDigest: objectiveDigest(snapshot), actorUserId: key(14), consentId: key(12), controlVersion: 2 };
  const input = { requestId: work.applicationRequestId, generationJobId: work.generationJobId,
    expected: { strategyId: work.strategyId, strategyVersionId: work.strategyVersionId, objectiveRevisionId: key(6) } };
  const source = { generationJobId: work.generationJobId, generationRequestId: work.generationRequestId, clientId: key(2),
    objectiveId: key(3), objectiveVersion: 1, objectiveRevisionId: key(6), strategyId: key(8), strategyVersionId: key(20), snapshotDigest: work.snapshotDigest };
  const binding = { canonical, generationRequestId: work.generationRequestId, objectiveReceiptSha256: work.objectiveReceiptSha256,
    snapshotDigest: work.snapshotDigest };
  const plan = materialization.materializationPlan(snapshot, snapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), input);
  const owner = { receiptVersion: 2 as const, input, binding, fingerprint: materialization.canonicalMaterializationFingerprint(input, binding),
    snapshot, archivedSourceNodeIds: [], result: materialization.materializationResult(plan, input, source, key(1), clerkUserId, at,
      materialization.materializationOutputResolver(key(1), clerkUserId, input.requestId, binding)) };
  materialization.checkedCanonicalMaterialization(owner, binding, key(1), clerkUserId);
  const ownerId = materialization.canonicalMaterializationReceiptId(key(1), clerkUserId, work.applicationRequestId);
  const applicationId = codec.applicationReceiptId(key(1), clerkUserId, work.applicationRequestId);
  const { actorUserId, consentId, controlVersion, ...fields } = work, request = { schemaVersion: 1 as const, ...fields };
  const ack = codec.creationAck(request, { tenantId: key(1), clerkUserId, actorUserId, consentId, controlVersion,
    requestSha256: codec.applicationHash(request), canonicalSha256: codec.applicationHash(canonical),
    tokenExpiresAtMs: now, claimExpiresAtMs: now, delegationExpiresAtMs: now }, owner, ownerId, at);
  codec.checkStoredApplication({ receiptVersion: 1, request, ack, ackSha256: codec.applicationHash(ack) }, owner, ownerId);
  return { work, owner, ownerId, applicationId, clerkUserId };
}

describe('historical Planner operation consent proof', () => {
  it.each(['failed', 'cancelled', 'applied'])('verifies %s native lineage independently of the current actor/root', async state => {
    const f = fixture(state), proof = await f.read();
    expect(f.a.actorUserId).not.toBe(f.row.intent.actor_user_id); expect(f.a.actorUserId).not.toBe(f.op.work.actorUserId);
    expect(proof).toEqual({ consentId: id(14), previousConsentId: id(18), controlVersion: 2,
      confirmedAtMs: now - 10_000, committedAtMs: now - 9_000, expiresAtMs: now + 50_000 });
    expect(Object.isFrozen(proof)).toBe(true); f.row.consent.id = id(100); expect(proof.consentId).toBe(id(14));
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'cancelled'])('allows %s accounting after original timeout without extending its deadline', async state => {
    const f = fixture(state); f.op.terminal.recordedAtMs = now + 86_400_000;
    const proof = await f.read(); expect(proof.expiresAtMs).toBe(now + 50_000); expect(f.op.original.originalDeadlineAt).toBe(iso(30_000));
  });
  it('supports equivalent PostgreSQL offsets and microseconds', async () => {
    const f = fixture(); f.row.consent.confirmed_at = '2026-10-17T07:59:50.000000+02:00';
    f.row.consent.expires_at = f.row.consent.stricter_expires_at = '2026-10-17T08:00:50.000000+02:00';
    f.row.receipt.committed_at = '2026-10-17T01:59:51.000000-04:00'; f.row.intent.created_at = '2026-10-17T01:59:40.123456-04:00';
    expect((await f.read()).committedAtMs).toBe(now - 9_000);
  });
  it.each([
    ['consent', 'control_id', id(100)], ['consent', 'consenting_actor_user_id', id(100)],
    ['consent', 'consenting_membership_id', id(100)], ['consent', 'source_snapshot_hash', 'f'.repeat(64)],
    ['consent', 'root_actor_user_id', id(50)], ['receipt', 'root_actor_user_id', id(50)],
    ['receipt', 'source_revision_id', id(100)], ['receipt', 'command_revision_id', id(100)],
    ['receipt', 'payload_digest', 'f'.repeat(64)], ['receipt', 'control_version_after', 3], ['receipt', 'target_consent_id', id(100)],
    ['consent', 'configured_duration_ms', 1_800_001], ['consent', 'effective_duration_ms', 59_999],
    ['consent', 'stricter_limit_ref', ''], ['consent', 'consent_policy_revision', 2],
    ['receipt', 'committed_at', iso(50_000)], ['intent', 'state', 'completed'], ['intent', 'purpose', 'other'],
    ['intent', 'blocked_reason', 'other'], ['revision', 'actor_user_id', id(100)],
    ['revision', 'operation', 'update'], ['revision', 'client_id', id(100)],
  ])('refuses mismatched original %s.%s', async (record, field, value) => {
    const f = fixture(); f.row[record as string][field as string] = value; await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it('requires exact operation, attempt, run, work hash and fingerprint identity', async () => {
    for (const field of ['operationId', 'attemptId', 'runId', 'workSha256', 'requestFingerprint']) {
      const f = fixture(); f.op.original[field] = field.endsWith('Id') ? id(100) : 'f'.repeat(64);
      await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
    }
  });
  it('requires original member/Clerk, self terminal receipt, bounded deadline and terminal after command commit', async () => {
    for (const corrupt of ['member', 'clerk', 'self', 'deadline-before', 'deadline-after', 'terminal-before']) {
      const f = fixture();
      if (corrupt === 'member') { f.op.membershipId = id(100); f.rebind(); }
      if (corrupt === 'clerk') { f.op.clerkUserId = 'another_clerk'; f.rebind(); }
      if (corrupt === 'self') f.op.terminal.receiptId = id(100);
      if (corrupt === 'deadline-before') { f.op.original.originalDeadlineAt = iso(-10_000); f.rebind(); }
      if (corrupt === 'deadline-after') { f.op.original.originalDeadlineAt = iso(50_001); f.rebind(); }
      if (corrupt === 'terminal-before') f.op.terminal.recordedAtMs = now - 9_001;
      await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
    }
  });
  it.each(['queued', 'leased', 'unknown'])('refuses nonterminal/unknown operation state %s', async state => {
    const f = fixture(state); await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
  });
  it('refuses missing/duplicate rows, extra row fields and modified command/source snapshot', async () => {
    for (const corrupt of ['missing', 'duplicate', 'extra', 'command', 'snapshot']) {
      const f = fixture();
      if (corrupt === 'missing') f.empty(); if (corrupt === 'duplicate') f.duplicate();
      if (corrupt === 'extra') f.row.intent.unchecked = true;
      if (corrupt === 'command') f.row.receipt.command.expectedControlVersion = 0;
      if (corrupt === 'snapshot') f.row.revision.snapshot.outcome = 'substituted';
      await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
    }
  });
  it('rejects getters and proxies before any getter/trap is invoked', async () => {
    const f = fixture(); let reads = 0;
    Object.defineProperty(f.row.revision.snapshot, 'outcome', { enumerable: true, get() { reads++; return 'unsafe'; } });
    await expect(f.read()).rejects.toThrow(); expect(reads).toBe(0);
    const g = fixture(); g.row.revision.snapshot = new Proxy(g.row.revision.snapshot, { get() { reads++; return 'unsafe'; } });
    await expect(g.read()).rejects.toThrow(); expect(reads).toBe(0);
    const h = fixture(); const unsafe = new Proxy(h.op, { get() { reads++; return 'unsafe'; } });
    await expect(verifyObjectivePlannerHistoricalConsentWithinTx(h.tx, h.a, h.controlId, unsafe)).rejects.toThrow();
    expect(reads).toBe(0); expect(h.query).not.toHaveBeenCalled();
  });
  it('pins the parsed operation and authority before its first await', async () => {
    const f = fixture(), pending = f.read(); f.op.clerkUserId = 'mutated'; f.op.work.actorUserId = id(100); f.a.objectiveId = id(100);
    expect((await pending).consentId).toBe(id(14));
  });
  it.each(['2026-10-17T06:00:00.000Z\n', '2026-10-17T06:00:00.000+24:00',
    '2026-10-17T06:00:00.000+02:60', '2026-02-30T06:00:00.000Z', '2026-10-17T06:00:00.0000000Z'])
  ('refuses malformed timestamp %p', async value => {
    const f = fixture(); f.row.intent.created_at = value; await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it('refuses newline-suffixed original UUIDs and SHA values', async () => {
    const f = fixture(); f.row.consent.previous_consent_id += '\n'; await expect(f.read()).rejects.toThrow();
    const g = fixture(); g.row.consent.payload_digest += '\n'; await expect(g.read()).rejects.toThrow();
  });
  it('derives exact application/owner receipt IDs matching the actual full v2 fixture and retained known IDs', () => {
    const full = fullV2Fixture(), f = fixture('applied');
    f.op.work = full.work; f.op.tenantId = full.work.canonical.tenantId; f.op.clerkUserId = full.clerkUserId; f.rebind();
    f.op.terminal.receiptId = full.applicationId;
    const actual = objectivePlannerHistoricalReceiptIds(f.op);
    expect(actual).toEqual({ applicationId: full.applicationId, ownerId: full.ownerId });
    expect(actual).toEqual({ applicationId: 'e5c6739c-f033-89e1-8a4b-ac77452691d5', ownerId: 'e8790312-d73c-5ae5-817b-0b5c07777e0f' });
    expect(Object.isFrozen(actual)).toBe(true); expect(f.query).not.toHaveBeenCalled();
  });
  it('refuses receipt ID derivation from malformed operations and unsafe inputs', () => {
    for (const corrupt of ['state', 'fingerprint', 'work', 'terminal']) {
      const f = fixture();
      if (corrupt === 'state') f.op.state = 'queued';
      if (corrupt === 'fingerprint') f.op.original.requestFingerprint = 'f'.repeat(64);
      if (corrupt === 'work') f.op.work.generationJobId += '\n';
      if (corrupt === 'terminal') f.op.terminal.receiptId = id(100);
      expect(() => objectivePlannerHistoricalReceiptIds(f.op)).toThrow('OUTCOME_UNCONFIRMED');
    }
    let reads = 0; const f = fixture();
    Object.defineProperty(f.op.work, 'consentId', { enumerable: true, get() { reads++; return id(14); } });
    expect(() => objectivePlannerHistoricalReceiptIds(f.op)).toThrow();
    expect(() => objectivePlannerHistoricalReceiptIds(new Proxy(fixture().op, { get() { reads++; return undefined; } }))).toThrow();
    expect(reads).toBe(0);
  });
});
