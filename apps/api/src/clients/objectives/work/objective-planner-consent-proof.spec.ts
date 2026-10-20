import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import { createPlannerApplicationCodec } from '@capiro/shared/objective-planner-owner-codec';
import { OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { workDigest, type WorkAuthority } from './objective-work-command.js';
import type { ObjectivePlannerAppliedPair } from './objective-planner-applied.js';
import { verifyObjectivePlannerAppliedConsentWithinTx } from './objective-planner-consent-proof.js';

type Json = Record<string, any>;
const id = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const codec = createPlannerApplicationCodec({ isProxy: nodeTypes.isProxy,
  sha256: value => createHash('sha256').update(value, 'utf8').digest('hex') });
const now = Date.parse('2026-10-17T06:00:00.000Z');
const iso = (offset: number) => new Date(now + offset).toISOString();

/** Synthetic SQL observation of historical consent custody only. The pair is
 * already decoded input; this does not qualify native locks or DB authority. */
function fixture() {
  const a: WorkAuthority = { tenantId: id(1), clientId: id(2), objectiveId: id(3), actorUserId: id(50),
    actorMembershipId: id(51), clerkUserId: 'current_editor', objectiveRevisionId: id(52), objectiveVersion: 8, objectiveStatus: 'ready' };
  const snapshot = { id: id(3), clientId: id(2), version: 1, status: 'ready', deletedAt: null,
    outcome: 'Historical source', nested: { '10': 10, '2': 2 } };
  const canonical = { tenantId: id(1), clientId: id(2), objectiveId: id(3), canonicalPlanId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 1, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 1, snapshotHash: workDigest(snapshot) };
  const request = { schemaVersion: 1 as const, canonical, applicationRequestId: codec.canonicalApplicationRequestId(canonical, id(9)),
    generationJobId: id(10), generationRequestId: id(11), strategyId: id(5), strategyVersionId: id(12),
    objectiveReceiptSha256: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64) };
  const owner: any = { receiptVersion: 2, input: { requestId: request.applicationRequestId },
    binding: { canonical, objectiveReceiptSha256: request.objectiveReceiptSha256 }, result: {
      requestId: request.applicationRequestId, source: { generationJobId: request.generationJobId,
        generationRequestId: request.generationRequestId, strategyId: request.strategyId, strategyVersionId: request.strategyVersionId,
        snapshotDigest: request.snapshotDigest, clientId: id(2), objectiveId: id(3), objectiveVersion: 1, objectiveRevisionId: id(8) },
      status: 'prepared', replayed: false, projects: [{ groupKey: 'default', originalNodeIds: [],
        output: { availability: 'available', id: id(6), createdVersion: 1, currentVersion: 1 } }], tasks: [],
      counts: { createdProjects: 1, createdTasks: 0 }, issues: [] } };
  const ownerRowId = id(13), ownerClerkUserId = 'original_clerk';
  const ack = codec.creationAck(request, { tenantId: id(1), clerkUserId: ownerClerkUserId, actorUserId: id(9),
    consentId: id(14), controlVersion: 2, tokenExpiresAtMs: now + 60_000, claimExpiresAtMs: now + 60_000,
    delegationExpiresAtMs: now + 60_000, requestSha256: codec.applicationHash(request), canonicalSha256: codec.applicationHash(canonical) },
    owner, ownerRowId, iso(0));
  const pair: ObjectivePlannerAppliedPair = { receiptId: codec.applicationReceiptId(id(1), ownerClerkUserId, request.applicationRequestId),
    stored: { receiptVersion: 1, request, ack, ackSha256: codec.applicationHash(ack) }, owner, ownerRowId, ownerClerkUserId };
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
    actor_user_id: id(15), snapshot, created_at: iso(-20_000) }, clerkUserId: ownerClerkUserId };
  const { schemaVersion: _version, ...fields } = request;
  const work = { ...fields, actorUserId: id(9), consentId: id(14), controlVersion: 2 };
  const operation = { tenantId: id(1), clerkUserId: ownerClerkUserId, membershipId: id(19), work, state: 'applied',
    original: { originalDeadlineAt: iso(30_000), workSha256: codec.applicationHash(work) },
    terminal: { receiptId: pair.receiptId, recordedAtMs: now + 1 } };
  let rows = [row];
  const query = jest.fn(async function (this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx); const sql = strings.join('?');
    expect(sql).toMatch(/\bFOR SHARE OF m,u\s*$/); expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(sql).not.toContain("status='active'");
    expect(values).toEqual([id(1), id(2), id(3), 'objective.plan.prepare', id(14), controlId]); return rows;
  });
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  const read = (withOperation = true) => verifyObjectivePlannerAppliedConsentWithinTx(tx, a, controlId, pair, withOperation ? operation : undefined);
  return { a, row, pair, operation, query, read, empty() { rows = []; } };
}

describe('historical Planner consent proof', () => {
  it('checks original native lineage in one supplied-tx read while current editor/source differ', async () => {
    const f = fixture(); await f.read(); await f.read(false); expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('accepts PostgreSQL timestamp offsets and microsecond JSON formatting', async () => {
    const f = fixture();
    f.row.consent.confirmed_at = '2026-10-17T07:59:50.000000+02:00';
    f.row.consent.expires_at = '2026-10-17T08:00:50.000000+02:00';
    f.row.consent.stricter_expires_at = '2026-10-17T08:00:50.000000+02:00';
    f.row.receipt.committed_at = '2026-10-17T07:59:51.000000+02:00';
    f.row.intent.created_at = '2026-10-17T01:59:40.123456-04:00';
    await f.read();
  });
  it.each([
    '2026-10-17T06:00:00.000Z\n', '2026-10-17T06:00:00.000+02:00\n',
    '2026-10-17T06:00:00.000+24:00', '2026-10-17T06:00:00.000+02:60',
    '2026-10-17T06:00:00.000+02', '2026-10-17T06:00:00.0000000Z',
    '2026-02-30T06:00:00.000Z', '2026-10-17T06:00:00.000z',
  ])('refuses malformed PostgreSQL timestamp %p', async value => {
    const f = fixture(); f.row.intent.created_at = value; await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it('refuses newline-suffixed UUID and SHA fields', async () => {
    const f = fixture(); f.row.consent.previous_consent_id += '\n';
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
    const g = fixture(); g.row.consent.payload_digest += '\n';
    await expect(g.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it.each([
    ['consent', 'control_id', id(100)], ['consent', 'consenting_actor_user_id', id(100)],
    ['consent', 'consenting_membership_id', id(100)], ['consent', 'source_snapshot_hash', 'f'.repeat(64)],
    ['receipt', 'source_revision_id', id(100)], ['receipt', 'root_actor_user_id', id(100)],
    ['receipt', 'command_revision_id', id(100)], ['receipt', 'payload_digest', 'f'.repeat(64)],
    ['receipt', 'control_version_after', 3], ['receipt', 'target_consent_id', id(100)],
    ['consent', 'configured_duration_ms', 1_800_001], ['consent', 'effective_duration_ms', 59_999],
    ['consent', 'stricter_limit_ref', ''], ['consent', 'consent_policy_revision', 2],
    ['receipt', 'committed_at', iso(1)], ['intent', 'state', 'completed'], ['intent', 'blocked_reason', 'other'],
    ['revision', 'actor_user_id', id(100)], ['revision', 'operation', 'update'], ['revision', 'client_id', id(100)],
  ])('refuses changed historical %s.%s', async (record, field, value) => {
    const f = fixture(); f.row[record as string][field as string] = value; await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it('refuses missing rows, orphan Clerk identity, extra fields and changed command bytes', async () => {
    for (const corrupt of ['missing', 'clerk', 'extra', 'command']) {
      const f = fixture();
      if (corrupt === 'missing') f.empty();
      if (corrupt === 'clerk') f.row.clerkUserId = 'another_clerk';
      if (corrupt === 'extra') f.row.consent.unchecked = true;
      if (corrupt === 'command') f.row.receipt.command.expectedControlVersion = 0;
      await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
    }
  });
  it('refuses changed ready snapshot content and accessors without invoking getters', async () => {
    const f = fixture(); f.row.revision.snapshot.deletedAt = iso(-1); await expect(f.read()).rejects.toThrow();
    const g = fixture(); let reads = 0;
    Object.defineProperty(g.row.revision.snapshot, 'outcome', { enumerable: true, get() { reads++; return 'unsafe'; } });
    await expect(g.read()).rejects.toThrow(); expect(reads).toBe(0);
  });
  it('requires the original membership, deadline window and applied terminal time', async () => {
    for (const corrupt of ['membership', 'deadline-before', 'deadline-after', 'terminal-before', 'terminal-after']) {
      const f = fixture();
      if (corrupt === 'membership') f.operation.membershipId = id(100);
      if (corrupt === 'deadline-before') f.operation.original.originalDeadlineAt = iso(-10_000);
      if (corrupt === 'deadline-after') f.operation.original.originalDeadlineAt = iso(50_001);
      if (corrupt === 'terminal-before') f.operation.terminal.recordedAtMs = now - 1;
      if (corrupt === 'terminal-after') f.operation.terminal.recordedAtMs = now + 30_000;
      await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
    }
  });
});
