import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import { OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { workDigest, type WorkAuthority, type WorkState } from './objective-work-command.js';
import { verifyObjectivePlannerCurrentConsentWithinTx } from './objective-planner-current-consent-proof.js';
import { verifyObjectivePlannerUnusedConsentChainWithinTx,
  type ObjectivePlannerUnusedConsentChainInput } from './objective-planner-unused-consent-proof.js';

type Json = Record<string, any>;
const id = (n: number) => `85000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = Date.parse('2026-10-17T06:02:00.000Z');
const iso = (offset: number) => new Date(at + offset).toISOString();
/** Native-shaped supplied-tx observations only. The owner separately proves
 * complete inventory, current authority and the full retained applied anchor. */
function fixture() {
  const a: WorkAuthority = { tenantId: id(1), clientId: id(2), objectiveId: id(3), actorUserId: id(50),
    actorMembershipId: id(51), clerkUserId: 'current_reader', objectiveRevisionId: id(8), objectiveVersion: 3, objectiveStatus: 'ready' };
  const snapshot = { id: id(3), clientId: id(2), version: 3, status: 'ready', deletedAt: null,
    outcome: 'Current advanced ready source', numericKeys: { '10': 10, '2': 2 } };
  const source = { canonicalPlanId: id(4), canonicalEpoch: 1, canonicalStrategyId: id(5), canonicalProjectId: id(6),
    canonicalBindingVersion: 3, rootIntentId: id(7), sourceRevisionId: id(8), sourceObjectiveVersion: 3,
    sourceSnapshotHash: workDigest(snapshot), rootActorUserId: id(15) };
  const nativeSource = { canonical_plan_id: id(4), canonical_epoch: 1, canonical_strategy_id: id(5), canonical_project_id: id(6),
    canonical_binding_version: 3, root_intent_id: id(7), source_revision_id: id(8), source_objective_version: 3,
    source_snapshot_hash: source.sourceSnapshotHash, root_actor_user_id: id(15) };
  function native(consentId: string, previous: string, controlVersion: number, confirmed: number, actor: string, member: string, clerk: string) {
    const commandRequest = id(100 + controlVersion), commandReceipt = id(200 + controlVersion);
    const command = { schemaVersion: 1, requestId: commandRequest, command: 'retry', workAction: 'objective.plan.prepare',
      expectedObjectiveVersion: 3, expectedControlVersion: controlVersion - 1, expectedCanonicalBindingVersion: 3,
      targetAuthorizationRequestId: previous };
    const payload = workDigest({ clientId: id(2), objectiveId: id(3), command });
    return { consent: { id: consentId, tenant_id: id(1), client_id: id(2), objective_id: id(3),
      work_action: 'objective.plan.prepare', control_id: id(16), ...nativeSource, previous_consent_id: previous,
      consenting_actor_user_id: actor, consenting_membership_id: member, consent_policy_id: 'capiro.objective-generation-consent',
      consent_policy_revision: 1, configured_duration_ms: 600_000, effective_duration_ms: 60_000,
      stricter_expires_at: iso(confirmed + 60_000), stricter_limit_ref: 'original-request-cap', confirmed_at: iso(confirmed),
      expires_at: iso(confirmed + 60_000), command_request_id: commandRequest, command_receipt_id: commandReceipt, payload_digest: payload },
    receipt: { id: commandReceipt, tenant_id: id(1), client_id: id(2), objective_id: id(3), work_action: 'objective.plan.prepare',
      control_id: id(16), ...nativeSource, actor_user_id: actor, actor_membership_id: member, request_id: commandRequest,
      payload_digest: payload, command, command_kind: 'retry', command_revision_id: id(8), command_objective_version: 3,
      control_version_before: controlVersion - 1, control_version_after: controlVersion, target_consent_id: previous,
      created_consent_id: consentId, result_consent_id: consentId, outcome: 'reconsent_recorded', committed_at: iso(confirmed + 1000) },
    intent: { id: id(7), tenant_id: id(1), client_id: id(2), objective_id: id(3), objective_revision_id: id(8), objective_version: 3,
      actor_user_id: id(15), purpose: OBJECTIVE_WORK_PURPOSE, snapshot_hash: source.sourceSnapshotHash,
      state: 'pending', blocked_reason: OBJECTIVE_WORK_BLOCKER, created_at: iso(-200_000) },
    revision: { id: id(8), tenant_id: id(1), client_id: id(2), objective_id: id(3), version: 3, operation: 'confirm_ready',
      actor_user_id: id(15), snapshot: JSON.parse(JSON.stringify(snapshot)), created_at: iso(-200_000) }, clerkUserId: clerk } as Json;
  }
  const bridge = native(id(30), id(18), 2, -120_000, id(90), id(91), 'first_issuer');
  const currentRow = native(id(14), id(30), 3, -60_000, id(9), id(19), 'current_issuer');
  const state: WorkState = { source, control: { id: id(16), version: 3, currentConsentId: id(14),
    cancelledAt: null, cancelledByUserId: null }, consent: { id: id(14), controlId: id(16), source: { ...source },
    previousConsentId: id(30), actorUserId: id(9), actorMembershipId: id(19), policyId: 'capiro.objective-generation-consent',
    policyRevision: 1, configuredDurationMs: 600_000, effectiveDurationMs: 60_000, stricterExpiresAt: iso(0),
    stricterLimitRef: 'original-request-cap', confirmedAt: iso(-60_000), expiresAt: iso(0), commandRequestId: id(103),
    commandReceiptId: id(203), payloadDigest: currentRow.consent.payload_digest } };
  const input: ObjectivePlannerUnusedConsentChainInput = { currentProof: { originalClerkUserId: 'current_issuer', controlVersion: 3,
    confirmedAtMs: at - 60_000, committedAtMs: at - 59_000, expiresAtMs: at, consentId: id(14), previousConsentId: id(30),
    actorUserId: id(9), membershipId: id(19) }, anchorConsentId: id(18), anchorControlVersion: 1,
    anchorTerminalAtMs: at - 150_000, operationConsentIds: [id(18)] };
  const rows = new Map<string, Json[]>([[id(30), [bridge]], [id(14), [currentRow]]]);
  const receiptProbes: unknown[][] = [], operationProbes: unknown[][] = [];
  let hiddenReceipt = false, hiddenOperation = false;
  const query = jest.fn(async function (this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx); const sql = strings.join('?');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    if (sql.includes('JOIN client_objective_work_intents')) {
      expect(sql).toMatch(/\bFOR SHARE OF m,u\s*$/); expect(sql).not.toContain("status='active'");
      expect(values.slice(0, 4)).toEqual([id(1), id(2), id(3), 'objective.plan.prepare']); expect(values[5]).toBe(id(16));
      return rows.get(values[4] as string) ?? [];
    }
    if (sql.includes("data#>>'{work,consentId}'")) {
      expect(sql).toContain('=ANY(?::text[]) LIMIT 1'); expect(sql).not.toMatch(/\b(?:kind|owner_id|archived|objectiveId|canonicalPlanId)\b/);
      expect(values[0]).toBe(id(1)); operationProbes.push(values);
      return hiddenOperation ? [{ id: id(999) }] : [];
    }
    expect(sql).toContain('WHERE tenant_id=?::uuid AND id IN (?::uuid,?::uuid)');
    expect(sql).not.toMatch(/\b(?:kind|owner_id|archived|objectiveId|canonicalPlanId)\b/);
    expect(values[0]).toBe(id(1)); expect(values).toHaveLength(3); receiptProbes.push(values);
    return hiddenReceipt ? [{ id: values[1] }] : [];
  });
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  const read = () => verifyObjectivePlannerUnusedConsentChainWithinTx(tx, a, state, input);
  return { a, state, input, bridge, currentRow, rows, native, tx, query, receiptProbes, operationProbes, read,
    hideReceipt() { hiddenReceipt = true; }, hideOperation() { hiddenOperation = true; } };
}

describe('unused native Planner consent chain over a proved applied anchor', () => {
  it('proves C2 → expired unused C1 → A with original actors, source and windows intact', async () => {
    const f = fixture(); const current = await verifyObjectivePlannerCurrentConsentWithinTx(f.tx, f.a, f.state);
    expect(current).toEqual(f.input.currentProof);
    const before = JSON.stringify({ state: f.state, row: f.bridge }), chain = await f.read();
    expect(chain).toHaveLength(1); expect(chain[0]).toEqual({ originalClerkUserId: 'first_issuer', controlVersion: 2,
      confirmedAtMs: at - 120_000, committedAtMs: at - 119_000, expiresAtMs: at - 60_000,
      consentId: id(30), previousConsentId: id(18), actorUserId: id(90), membershipId: id(91) });
    expect(Object.isFrozen(chain)).toBe(true); expect(Object.isFrozen(chain[0])).toBe(true);
    expect(JSON.stringify({ state: f.state, row: f.bridge })).toBe(before);
    expect(f.receiptProbes).toHaveLength(1); expect(f.operationProbes).toEqual([[id(1), [id(14), id(30)]]]);
  });
  it('traverses multiple genuine unused renewals in newest-to-oldest order', async () => {
    const f = fixture(), next = f.native(id(31), id(30), 3, -60_000, id(92), id(93), 'second_issuer');
    f.rows.set(id(31), [next]); (f.state.control!).version = 4; f.state.consent!.previousConsentId = id(31);
    f.state.consent!.confirmedAt = iso(0); f.state.consent!.expiresAt = f.state.consent!.stricterExpiresAt = iso(60_000);
    Object.assign(f.input.currentProof, { controlVersion: 4, previousConsentId: id(31), confirmedAtMs: at,
      committedAtMs: at + 1000, expiresAtMs: at + 60_000 });
    const chain = await f.read(); expect(chain.map(p => p.consentId)).toEqual([id(31), id(30)]);
    expect(f.receiptProbes).toHaveLength(2); expect(f.receiptProbes[0]).not.toEqual(f.receiptProbes[1]);
    expect(f.operationProbes).toEqual([[id(1), [id(14), id(31), id(30)]]]);
  });
  it('preserves direct PR51 read with a larger control gap while probing current operation absence', async () => {
    const f = fixture(); f.state.consent!.previousConsentId = id(18); f.state.control!.version = 50;
    Object.assign(f.input.currentProof, { previousConsentId: id(18), controlVersion: 50 });
    expect(await f.read()).toEqual([]); expect(f.receiptProbes).toHaveLength(0);
    expect(f.operationProbes).toEqual([[id(1), [id(14)]]]); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'duplicate', 'extra-consent', 'extra-receipt', 'extra-intent', 'extra-revision', 'clerk'])
  ('refuses missing or open native bridge evidence %s', async defect => {
    const f = fixture();
    if (defect === 'missing') f.rows.delete(id(30)); if (defect === 'duplicate') f.rows.set(id(30), [f.bridge, f.bridge]);
    if (defect.startsWith('extra-')) f.bridge[defect.slice(6)].unchecked = true;
    if (defect === 'clerk') f.bridge.clerkUserId = '';
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it.each(['canonical_plan_id', 'canonical_epoch', 'canonical_strategy_id', 'canonical_project_id', 'canonical_binding_version',
    'root_intent_id', 'source_revision_id', 'source_objective_version', 'source_snapshot_hash', 'root_actor_user_id'])
  ('requires each bridge native source field to equal the current ready source: %s', async field => {
    const f = fixture(); f.bridge.consent[field] = typeof f.bridge.consent[field] === 'number' ? 4 :
      field === 'source_snapshot_hash' ? 'f'.repeat(64) : id(100);
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it.each([
    ['consent', 'consenting_actor_user_id', id(100)], ['consent', 'consenting_membership_id', id(100)],
    ['consent', 'consent_policy_id', 'other'], ['consent', 'consent_policy_revision', 2],
    ['consent', 'configured_duration_ms', 1_800_001], ['consent', 'effective_duration_ms', 59_999],
    ['consent', 'stricter_limit_ref', ''], ['consent', 'command_request_id', id(100)],
    ['consent', 'payload_digest', 'f'.repeat(64)], ['receipt', 'actor_user_id', id(100)],
    ['receipt', 'control_version_after', 4], ['receipt', 'control_version_before', 0],
    ['receipt', 'command_kind', 'cancel'], ['receipt', 'target_consent_id', id(100)],
    ['receipt', 'created_consent_id', id(100)], ['receipt', 'committed_at', iso(-60_000)],
    ['intent', 'actor_user_id', id(100)], ['intent', 'state', 'completed'], ['intent', 'blocked_reason', 'other'],
    ['revision', 'operation', 'update'], ['revision', 'actor_user_id', id(100)],
  ])('refuses corrupt original bridge %s.%s', async (record, field, value) => {
    const f = fixture(); f.bridge[record as string][field as string] = value;
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it('requires the original ready snapshot digest and reciprocal command bytes', async () => {
    const f = fixture(); f.bridge.revision.snapshot.outcome = 'substituted'; await expect(f.read()).rejects.toThrow();
    const g = fixture(); g.bridge.receipt.command.expectedCanonicalBindingVersion = 2; await expect(g.read()).rejects.toThrow();
  });
  it.each(['renewed-too-soon', 'anchor-too-late', 'gap-before-anchor', 'cycle-current', 'self-cycle', 'null-predecessor'])
  ('refuses incomplete chronology/renewal chain %s', async defect => {
    const f = fixture();
    if (defect === 'renewed-too-soon') {
      f.bridge.consent.confirmed_at = iso(-119_999); f.bridge.consent.expires_at = f.bridge.consent.stricter_expires_at = iso(-59_999);
    }
    if (defect === 'anchor-too-late') (f.input as unknown as Json).anchorTerminalAtMs = at - 119_999;
    if (defect === 'gap-before-anchor') {
      f.state.control!.version = 4; Object.assign(f.input.currentProof, { controlVersion: 4 });
      f.bridge.receipt.control_version_before = 2; f.bridge.receipt.control_version_after = 3;
      f.bridge.receipt.command.expectedControlVersion = 2;
      f.bridge.consent.payload_digest = f.bridge.receipt.payload_digest = workDigest({
        clientId: id(2), objectiveId: id(3), command: f.bridge.receipt.command,
      });
    }
    if (['cycle-current', 'self-cycle', 'null-predecessor'].includes(defect)) {
      const previous = defect === 'cycle-current' ? id(14) : defect === 'self-cycle' ? id(30) : null;
      f.bridge.consent.previous_consent_id = f.bridge.receipt.target_consent_id = previous;
      f.bridge.receipt.command.targetAuthorizationRequestId = previous;
      f.bridge.consent.payload_digest = f.bridge.receipt.payload_digest = workDigest({ clientId: id(2), objectiveId: id(3), command: f.bridge.receipt.command });
    }
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
  });
  it.each([id(30), id(14)])('refuses any parsed operation for unused/current consent %s', async consent => {
    const f = fixture(); (f.input as unknown as Json).operationConsentIds = [id(18), consent];
    await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.query).not.toHaveBeenCalled();
  });
  it('refuses hidden kind/owner/scope at exact original actor/Clerk application or owner receipt addresses', async () => {
    const f = fixture(); f.hideReceipt(); await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED');
    expect(f.receiptProbes).toHaveLength(1); expect(f.operationProbes).toHaveLength(0);
  });
  it.each(['bridge-chain', 'direct-current'])('refuses any unscoped tenant row bearing a selected consent: %s', async mode => {
    const f = fixture(); if (mode === 'direct-current') {
      f.state.consent!.previousConsentId = id(18); Object.assign(f.input.currentProof, { previousConsentId: id(18) });
    }
    f.hideOperation(); await expect(f.read()).rejects.toThrow('OUTCOME_UNCONFIRMED'); expect(f.operationProbes).toHaveLength(1);
  });
  it('bounds consent traversal and the complete operation inventory before native reads', async () => {
    const f = fixture(); f.state.control!.version = 259; Object.assign(f.input.currentProof, { controlVersion: 259 });
    await expect(f.read()).rejects.toThrow(); expect(f.query).not.toHaveBeenCalled();
    const g = fixture(); (g.input as unknown as Json).operationConsentIds = Array.from({ length: 257 }, (_, n) => id(1000 + n));
    await expect(g.read()).rejects.toThrow(); expect(g.query).not.toHaveBeenCalled();
  });
  it('rejects hostile inputs/native getters without invoking traps', async () => {
    let reads = 0; const f = fixture(); Object.defineProperty(f.input.currentProof, 'previousConsentId', {
      enumerable: true, get() { reads++; return id(30); },
    });
    await expect(f.read()).rejects.toThrow(); expect(f.query).not.toHaveBeenCalled();
    const g = fixture(), proxy = new Proxy(g.state, { get() { reads++; return undefined; } });
    await expect(verifyObjectivePlannerUnusedConsentChainWithinTx(g.tx, g.a, proxy, g.input)).rejects.toThrow();
    const h = fixture(); Object.defineProperty(h.bridge.revision.snapshot, 'outcome', {
      enumerable: true, get() { reads++; return 'unsafe'; },
    });
    await expect(h.read()).rejects.toThrow(); expect(reads).toBe(0);
  });
  it('pins caller proof/source/inventory before the first await', async () => {
    const f = fixture(), pending = f.read();
    f.a.objectiveId = id(100); f.state.source.sourceRevisionId = id(100); f.state.control!.version = 50;
    Object.assign(f.input.currentProof, { consentId: id(100) }); (f.input as unknown as Json).operationConsentIds.push(id(30));
    expect((await pending).map(p => p.consentId)).toEqual([id(30)]);
    expect(f.operationProbes).toEqual([[id(1), [id(14), id(30)]]]);
  });
});
