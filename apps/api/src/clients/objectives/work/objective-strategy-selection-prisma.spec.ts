import { verifyObjectiveStrategySelectionWithinTx } from './objective-strategy-selection-prisma.js';
import { objectiveStrategyRequestCodec, objectiveStrategySelectionBody, objectiveStrategySelectionDigest,
  parseObjectiveStrategySelection } from './objective-strategy-selection.js';
import { workDigest, type StoredWorkReceipt, type WorkAuthority, type WorkSource } from './objective-work-command.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a: WorkAuthority = { tenantId: id(1), clientId: id(2), objectiveId: id(3), actorUserId: id(4),
  actorMembershipId: id(5), clerkUserId: 'user_original', objectiveRevisionId: id(6), objectiveVersion: 1, objectiveStatus: 'ready' };
function fixture() {
  const selected = parseObjectiveStrategySelection(a.clientId, a.objectiveId, { schemaVersion: 2,
    command: { schemaVersion: 1, requestId: id(12), command: 'retry', workAction: 'objective.strategy.draft',
      expectedObjectiveVersion: 1, expectedControlVersion: 0, expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null },
    selection: { type: 'appropriations', generationRequestId: id(13) } });
  const source: WorkSource = { canonicalPlanId: id(7), canonicalEpoch: 1, canonicalStrategyId: id(8), canonicalProjectId: id(9),
    canonicalBindingVersion: 1, rootIntentId: id(10), sourceRevisionId: id(6), sourceObjectiveVersion: 1,
    sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: id(4) };
  const stored: StoredWorkReceipt = { actorUserId: a.actorUserId, actorMembershipId: a.actorMembershipId, controlId: id(11),
    command: selected.work.command, source, receipt: { schemaVersion: 1, receiptId: id(14), requestId: id(12),
      payloadDigest: workDigest(selected.work), clientId: a.clientId, objectiveId: a.objectiveId, command: 'retry',
      workAction: 'objective.strategy.draft', commandRevision: { id: id(6), version: 1 }, sourceRevision: { id: id(6), version: 1 },
      rootIntentId: id(10), controlVersionBefore: 0, controlVersionAfter: 1, targetAuthorizationRequestId: null,
      authorizationRequestId: id(15), consent: { id: id(15), confirmedAt: '2026-10-17T01:00:00.000Z', expiresAt: '2026-10-17T01:01:00.000Z' },
      outcome: 'reconsent_recorded', committedAt: '2026-10-17T01:00:00.001Z' } };
  const draft = objectiveStrategyRequestCodec.parseObjectiveDraft({ requestId: id(13), clientId: a.clientId,
    objective: { objectiveId: a.objectiveId, objectiveVersion: 1 }, type: 'appropriations' });
  const row: any = { id: id(16), generation_job_id: id(17), tenant_id: a.tenantId, client_id: a.clientId, objective_id: a.objectiveId,
    work_action: 'objective.strategy.draft', control_id: id(11), consent_id: id(15), command_receipt_id: id(14), command_request_id: id(12),
    control_version: 1, actor_user_id: a.actorUserId, actor_membership_id: a.actorMembershipId, original_clerk_user_id: a.clerkUserId,
    canonical_plan_id: source.canonicalPlanId, canonical_epoch: 1, canonical_strategy_id: source.canonicalStrategyId,
    canonical_project_id: source.canonicalProjectId, canonical_binding_version: 1, root_intent_id: source.rootIntentId,
    source_revision_id: source.sourceRevisionId, source_objective_version: 1, source_snapshot_hash: source.sourceSnapshotHash,
    root_actor_user_id: source.rootActorUserId, selected_type: 'appropriations', generation_request_id: id(13),
    wrapper: objectiveStrategySelectionBody(selected), wrapper_sha256: objectiveStrategySelectionDigest(selected), typed_request: draft,
    request_fingerprint: objectiveStrategyRequestCodec.digest(draft), job_request_key: objectiveStrategyRequestCodec.requestKey(a.tenantId, a.clerkUserId, id(13)),
    original_deadline_at: '2026-10-17T01:01:00.000Z', reserved_at: '2026-10-17T01:00:00.002Z' };
  const tx = { $queryRaw: jest.fn(async () => [{ record: row }]), $executeRaw: jest.fn() } as any;
  return { selected, stored, row, tx };
}
describe('immutable native selected Strategy replay', () => {
  test('reads the original companion under exact native receipt scope without updates or row locks', async () => {
    const f = fixture(); await verifyObjectiveStrategySelectionWithinTx(f.tx, a, f.stored, f.selected);
    const [parts, ...values] = f.tx.$queryRaw.mock.calls[0];
    expect(parts.join('?')).toContain('FROM client_objective_strategy_intakes');
    expect(parts.join('?')).not.toMatch(/FOR\s+(SHARE|UPDATE)/);
    expect(values).toEqual([a.tenantId, a.clientId, a.objectiveId, f.stored.controlId, f.stored.receipt.receiptId]);
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  test('does not retrofit selection onto a bare historical v1 receipt', async () => {
    const f = fixture(); f.tx.$queryRaw.mockResolvedValue([]);
    await expect(verifyObjectiveStrategySelectionWithinTx(f.tx, a, f.stored, f.selected)).rejects.toMatchObject({ code: 'RECEIPT_UNVERIFIABLE' });
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  test.each(['type', 'generationRequestId'])('a changed %s under an old command identity conflicts', async field => {
    const f = fixture(), body = JSON.parse(JSON.stringify(objectiveStrategySelectionBody(f.selected)));
    body.selection[field] = field === 'type' ? 'authorization' : id(20);
    const changed = parseObjectiveStrategySelection(a.clientId, a.objectiveId, body);
    await expect(verifyObjectiveStrategySelectionWithinTx(f.tx, a, f.stored, changed)).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  test.each(['consent_id', 'command_receipt_id', 'actor_membership_id', 'source_revision_id', 'canonical_project_id',
    'request_fingerprint', 'job_request_key', 'original_clerk_user_id'])('refuses corrupted native %s lineage', async field => {
    const f = fixture(); f.row[field] = field.endsWith('_id') ? id(30) : 'corrupted';
    await expect(verifyObjectiveStrategySelectionWithinTx(f.tx, a, f.stored, f.selected)).rejects.toMatchObject({ code: 'RECEIPT_UNVERIFIABLE' });
  });
  test('does not extend the original job ceiling past the native consent', async () => {
    const f = fixture(); f.row.original_deadline_at = '2026-10-17T01:02:00.000Z';
    await expect(verifyObjectiveStrategySelectionWithinTx(f.tx, a, f.stored, f.selected)).rejects.toMatchObject({ code: 'RECEIPT_UNVERIFIABLE' });
  });
  test('propagates SQL faults so the caller cannot return an unverified receipt', async () => {
    const f = fixture(), fault = new Error('native SQL fault'); f.tx.$queryRaw.mockRejectedValue(fault);
    await expect(verifyObjectiveStrategySelectionWithinTx(f.tx, a, f.stored, f.selected)).rejects.toBe(fault);
  });
});
