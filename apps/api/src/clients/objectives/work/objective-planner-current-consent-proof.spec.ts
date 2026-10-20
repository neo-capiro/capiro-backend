import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import { OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { workDigest, type WorkAuthority, type WorkState } from './objective-work-command.js';
import { verifyObjectivePlannerCurrentConsentWithinTx } from './objective-planner-current-consent-proof.js';

type Json = Record<string, any>;
const id = (n: number) => `84000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = Date.parse('2026-10-17T06:00:00.000Z');
const iso = (offset: number) => new Date(at + offset).toISOString();
/** Synthetic native-shaped observations only: no SQL execution, current-reader
 * authority, older anchor, effect absence or issuance permission is qualified. */
function fixture() {
  const a: WorkAuthority = { tenantId: id(1), clientId: id(2), objectiveId: id(3), actorUserId: id(50),
    actorMembershipId: id(51), clerkUserId: 'current_reader', objectiveRevisionId: id(8), objectiveVersion: 3, objectiveStatus: 'ready' };
  const snapshot = { id: id(3), clientId: id(2), version: 3, status: 'ready', deletedAt: null,
    outcome: 'New current root', numericKeys: { '10': 10, '2': 2 } };
  const source = { canonicalPlanId: id(4), canonicalEpoch: 1, canonicalStrategyId: id(5), canonicalProjectId: id(6),
    canonicalBindingVersion: 3, rootIntentId: id(7), sourceRevisionId: id(8), sourceObjectiveVersion: 3,
    sourceSnapshotHash: workDigest(snapshot), rootActorUserId: id(15) };
  const control = { id: id(16), version: 4, currentConsentId: id(14), cancelledAt: null, cancelledByUserId: null };
  const command = { schemaVersion: 1, requestId: id(17), command: 'retry', workAction: 'objective.plan.prepare',
    expectedObjectiveVersion: 3, expectedControlVersion: 3, expectedCanonicalBindingVersion: 3, targetAuthorizationRequestId: id(18) };
  const payloadDigest = workDigest({ clientId: id(2), objectiveId: id(3), command });
  const state: WorkState = { source, control, consent: { id: id(14), controlId: id(16), source: { ...source },
    previousConsentId: id(18), actorUserId: id(9), actorMembershipId: id(19), policyId: 'capiro.objective-generation-consent',
    policyRevision: 1, configuredDurationMs: 600_000, effectiveDurationMs: 60_000,
    stricterExpiresAt: iso(50_000), stricterLimitRef: 'original-request-cap', confirmedAt: iso(-10_000), expiresAt: iso(50_000),
    commandRequestId: id(17), commandReceiptId: id(20), payloadDigest } };
  const nativeSource = { canonical_plan_id: id(4), canonical_epoch: 1, canonical_strategy_id: id(5), canonical_project_id: id(6),
    canonical_binding_version: 3, root_intent_id: id(7), source_revision_id: id(8), source_objective_version: 3,
    source_snapshot_hash: source.sourceSnapshotHash, root_actor_user_id: id(15) };
  const row: Json = {
    consent: { id: id(14), tenant_id: id(1), client_id: id(2), objective_id: id(3), work_action: 'objective.plan.prepare',
      control_id: id(16), ...nativeSource, previous_consent_id: id(18), consenting_actor_user_id: id(9), consenting_membership_id: id(19),
      consent_policy_id: 'capiro.objective-generation-consent', consent_policy_revision: 1, configured_duration_ms: 600_000,
      effective_duration_ms: 60_000, stricter_expires_at: iso(50_000), stricter_limit_ref: 'original-request-cap',
      confirmed_at: iso(-10_000), expires_at: iso(50_000), command_request_id: id(17), command_receipt_id: id(20), payload_digest: payloadDigest },
    receipt: { id: id(20), tenant_id: id(1), client_id: id(2), objective_id: id(3), work_action: 'objective.plan.prepare',
      control_id: id(16), ...nativeSource, actor_user_id: id(9), actor_membership_id: id(19), request_id: id(17), payload_digest: payloadDigest,
      command, command_kind: 'retry', command_revision_id: id(8), command_objective_version: 3,
      control_version_before: 3, control_version_after: 4, target_consent_id: id(18), created_consent_id: id(14), result_consent_id: id(14),
      outcome: 'reconsent_recorded', committed_at: iso(-9_000) },
    intent: { id: id(7), tenant_id: id(1), client_id: id(2), objective_id: id(3), objective_revision_id: id(8), objective_version: 3,
      actor_user_id: id(15), purpose: OBJECTIVE_WORK_PURPOSE, snapshot_hash: source.sourceSnapshotHash,
      state: 'pending', blocked_reason: OBJECTIVE_WORK_BLOCKER, created_at: iso(-20_000) },
    revision: { id: id(8), tenant_id: id(1), client_id: id(2), objective_id: id(3), version: 3, operation: 'confirm_ready',
      actor_user_id: id(15), snapshot, created_at: iso(-20_000) }, clerkUserId: 'consenting_actor_clerk',
  };
  let rows = [row];
  const query = jest.fn(async function (this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx); const sql = strings.join('?');
    expect(sql).toMatch(/\bFOR SHARE OF m,u\s*$/); expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(sql).not.toContain("status='active'");
    expect(sql).toContain('JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.id=c.consenting_membership_id AND m.user_id=c.consenting_actor_user_id');
    expect(sql).toContain('JOIN users u ON u.id=m.user_id');
    expect(values).toEqual([id(1), id(2), id(3), 'objective.plan.prepare', id(14), id(16)]); return rows;
  });
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  const read = () => verifyObjectivePlannerCurrentConsentWithinTx(tx, a, state);
  return { a, state, row, query, tx, read, empty() { rows = []; }, duplicate() { rows.push(row); } };
}

describe('current Planner consent consistency without an operation', () => {
  it('verifies actual original issuance/root independently of the authorized current reader', async () => {
    const f = fixture(), proof = await f.read();
    expect(f.a.actorUserId).not.toBe(f.state.consent!.actorUserId); expect(f.a.actorUserId).not.toBe(f.state.source.rootActorUserId);
    expect(f.a.clerkUserId).not.toBe(proof.originalClerkUserId);
    expect(proof).toEqual({ originalClerkUserId: 'consenting_actor_clerk', controlVersion: 4,
      confirmedAtMs: at - 10_000, committedAtMs: at - 9_000, expiresAtMs: at + 50_000,
      consentId: id(14), previousConsentId: id(18), actorUserId: id(9), membershipId: id(19) });
    expect(Object.isFrozen(proof)).toBe(true); f.row.consent.id = id(100); expect(proof.consentId).toBe(id(14));
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('allows already-expired consent as read evidence without changing its original window', async () => {
    const f = fixture(), realNow = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(at + 86_400_000);
    try {
      const before = JSON.stringify(f.state), proof = await f.read();
      expect(proof.expiresAtMs).toBeLessThan(Date.now()); expect(JSON.stringify(f.state)).toBe(before);
      expect(proof.expiresAtMs - proof.confirmedAtMs).toBe(60_000);
    } finally { jest.restoreAllMocks(); expect(Date.now()).toBeGreaterThanOrEqual(realNow); }
  });
  it('accepts native offset and microsecond dates at WorkService millisecond precision', async () => {
    const f = fixture(); f.row.consent.confirmed_at = '2026-10-17T07:59:50.000000+02:00';
    f.row.consent.expires_at = f.row.consent.stricter_expires_at = '2026-10-17T08:00:50.000000+02:00';
    f.row.receipt.committed_at = '2026-10-17T01:59:51.123456-04:00';
    f.row.intent.created_at = '2026-10-17T01:59:40.123456-04:00';
    expect((await f.read()).committedAtMs).toBe(at - 8_877);
  });
  it('accepts an originally uncapped policy interval with reciprocal null cap fields', async () => {
    const f = fixture(); f.state.consent!.stricterExpiresAt = f.state.consent!.stricterLimitRef = null;
    f.row.consent.stricter_expires_at = f.row.consent.stricter_limit_ref = null;
    expect((await f.read()).expiresAtMs).toBe(at + 50_000);
  });
  it.each(['canonicalPlanId', 'canonicalEpoch', 'canonicalStrategyId', 'canonicalProjectId', 'canonicalBindingVersion',
    'rootIntentId', 'sourceRevisionId', 'sourceObjectiveVersion', 'sourceSnapshotHash', 'rootActorUserId'])
  ('requires the entire current captured source: %s', async field => {
    const f = fixture(), source = f.state.consent!.source as unknown as Json;
    source[field] = typeof source[field] === 'number' ? 4 : field === 'sourceSnapshotHash' ? 'f'.repeat(64) : id(100);
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    ['objectiveStatus', 'draft'], ['objectiveRevisionId', id(100)], ['objectiveVersion', 4],
    ['actorUserId', id(100) + '\n'], ['clerkUserId', ''],
  ])('requires captured current authority shape/source %s', async (field, value) => {
    const f = fixture(); (f.a as unknown as Json)[field] = value;
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
  });
  it.each(['missing-control', 'missing-consent', 'current-id', 'control-id', 'control-version', 'cancel-time', 'cancel-actor', 'self-previous'])
  ('refuses incompatible current control %s', async defect => {
    const f = fixture();
    if (defect === 'missing-control') f.state.control = null;
    if (defect === 'missing-consent') f.state.consent = null;
    if (defect === 'current-id') f.state.control!.currentConsentId = id(100);
    if (defect === 'control-id') f.state.control!.id = id(100);
    if (defect === 'control-version') f.state.control!.version = 0;
    if (defect === 'cancel-time') f.state.control!.cancelledAt = iso(1);
    if (defect === 'cancel-actor') f.state.control!.cancelledByUserId = id(100);
    if (defect === 'self-previous') f.state.consent!.previousConsentId = f.state.consent!.id;
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    ['previous_consent_id', id(100)], ['consenting_actor_user_id', id(100)], ['consenting_membership_id', id(100)],
    ['consent_policy_id', 'another-policy'], ['consent_policy_revision', 2], ['configured_duration_ms', 600_001],
    ['effective_duration_ms', 59_999], ['stricter_expires_at', iso(49_999)], ['stricter_limit_ref', 'other-cap'],
    ['confirmed_at', iso(-9_999)], ['expires_at', iso(50_001)], ['command_request_id', id(100)],
    ['command_receipt_id', id(100)], ['payload_digest', 'f'.repeat(64)],
  ])('requires every captured current consent field to equal native %s', async (field, value) => {
    const f = fixture(); f.row.consent[field as string] = value;
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it.each([
    ['consent', 'control_id', id(100)], ['consent', 'canonical_plan_id', id(100)], ['consent', 'canonical_epoch', 2],
    ['consent', 'canonical_strategy_id', id(100)], ['consent', 'canonical_project_id', id(100)],
    ['consent', 'canonical_binding_version', 4], ['consent', 'root_intent_id', id(100)],
    ['consent', 'source_revision_id', id(100)], ['consent', 'source_objective_version', 4],
    ['consent', 'source_snapshot_hash', 'f'.repeat(64)], ['consent', 'root_actor_user_id', id(100)],
    ['receipt', 'root_actor_user_id', id(100)], ['receipt', 'source_revision_id', id(100)],
    ['receipt', 'actor_user_id', id(100)], ['receipt', 'actor_membership_id', id(100)],
    ['receipt', 'request_id', id(100)], ['receipt', 'payload_digest', 'f'.repeat(64)],
    ['receipt', 'created_consent_id', id(100)], ['receipt', 'result_consent_id', id(100)], ['receipt', 'target_consent_id', id(100)],
    ['receipt', 'command_kind', 'cancel'], ['receipt', 'outcome', 'unchanged'], ['receipt', 'control_version_before', 2],
    ['receipt', 'control_version_after', 5], ['receipt', 'command_revision_id', id(100)],
    ['receipt', 'command_objective_version', 4], ['receipt', 'committed_at', iso(-10_001)], ['receipt', 'committed_at', iso(50_000)],
    ['intent', 'actor_user_id', id(100)], ['intent', 'state', 'completed'], ['intent', 'purpose', 'other'],
    ['intent', 'blocked_reason', 'other'], ['intent', 'snapshot_hash', 'f'.repeat(64)],
    ['revision', 'actor_user_id', id(100)], ['revision', 'operation', 'update'], ['revision', 'client_id', id(100)],
  ])('refuses inconsistent current native %s.%s', async (record, field, value) => {
    const f = fixture(); f.row[record as string][field as string] = value;
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it.each(['policy', 'revision', 'duration-too-long', 'effective-too-long', 'cap-ref', 'cap-null', 'expiry-duration'])
  ('refuses invalid original policy/timing even if native and captured values agree: %s', async defect => {
    const f = fixture(), c = f.state.consent!, native = f.row.consent;
    if (defect === 'policy') c.policyId = native.consent_policy_id = 'other';
    if (defect === 'revision') c.policyRevision = native.consent_policy_revision = 2;
    if (defect === 'duration-too-long') c.configuredDurationMs = native.configured_duration_ms = 1_800_001;
    if (defect === 'effective-too-long') c.configuredDurationMs = native.configured_duration_ms = 59_999;
    if (defect === 'cap-ref') c.stricterLimitRef = native.stricter_limit_ref = '';
    if (defect === 'cap-null') c.stricterExpiresAt = native.stricter_expires_at = null;
    if (defect === 'expiry-duration') c.expiresAt = native.expires_at = iso(50_001);
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
  });
  it.each(['command', 'snapshot', 'empty', 'duplicate', 'orphan-clerk', 'extra-consent', 'extra-receipt', 'extra-intent', 'extra-revision'])
  ('refuses incomplete or substituted native evidence %s', async defect => {
    const f = fixture();
    if (defect === 'command') f.row.receipt.command.expectedCanonicalBindingVersion = 2;
    if (defect === 'snapshot') f.row.revision.snapshot.outcome = 'substitution';
    if (defect === 'empty') f.empty(); if (defect === 'duplicate') f.duplicate();
    if (defect === 'orphan-clerk') f.row.clerkUserId = '';
    if (defect.startsWith('extra-')) f.row[defect.slice(6)].unchecked = true;
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it.each(['2026-10-17T06:00:00.000Z\n', '2026-10-17T06:00:00.000+24:00',
    '2026-10-17T06:00:00.000+02:60', '2026-02-30T06:00:00.000Z', '2026-10-17T06:00:00.0000000Z'])
  ('refuses malformed native timestamps %p', async value => {
    const f = fixture(); f.row.intent.created_at = value; await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it('rejects input getters/proxies before invoking getters/traps or reading SQL', async () => {
    let reads = 0; const f = fixture();
    Object.defineProperty(f.state.source, 'canonicalPlanId', { enumerable: true, get() { reads++; return id(4); } });
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
    const g = fixture(), proxy = new Proxy(g.a, { get() { reads++; return undefined; } });
    await expect(verifyObjectivePlannerCurrentConsentWithinTx(g.tx, proxy, g.state)).rejects.toThrow();
    expect(g.query).not.toHaveBeenCalled(); expect(reads).toBe(0);
    const h = fixture(); Object.defineProperty(h.row.revision.snapshot, 'outcome', {
      enumerable: true, get() { reads++; return 'unsafe'; },
    });
    await expect(h.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(reads).toBe(0);
  });
  it('pins current source/control/consent/authority before the first await', async () => {
    const f = fixture(), pending = f.read();
    f.a.objectiveId = id(100); f.state.source.rootIntentId = id(100); f.state.control!.version = 99;
    f.state.consent!.actorUserId = id(100); f.state.consent!.expiresAt = iso(86_400_000);
    const proof = await pending; expect(proof.consentId).toBe(id(14)); expect(proof.controlVersion).toBe(4);
    expect(proof.actorUserId).toBe(id(9)); expect(proof.expiresAtMs).toBe(at + 50_000);
  });
  it('refuses extra or missing caller fields and newline UUID/hash values', async () => {
    for (const defect of ['authority-extra', 'state-extra', 'source-extra', 'consent-extra', 'control-extra', 'uuid', 'hash']) {
      const f = fixture();
      if (defect === 'authority-extra') (f.a as unknown as Json).extra = true;
      if (defect === 'state-extra') (f.state as unknown as Json).extra = true;
      if (defect === 'source-extra') (f.state.source as unknown as Json).extra = true;
      if (defect === 'consent-extra') (f.state.consent as unknown as Json).extra = true;
      if (defect === 'control-extra') (f.state.control as unknown as Json).extra = true;
      if (defect === 'uuid') f.state.consent!.previousConsentId += '\n';
      if (defect === 'hash') f.state.consent!.payloadDigest += '\n';
      await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
    }
  });
});
