import { digest } from '../meri/objective-generation.types.js';
import {
  canonicalMaterializationFingerprint,
  canonicalMaterializationReceiptId,
  checkedCanonicalMaterialization,
  checkedMaterialization,
  materializationOutputId,
  materializationOutputResolver,
  materializationPlan,
  materializationReceiptId,
  materializationResult,
  parseCanonicalMaterializationBinding,
  parseMaterialization,
  requireCanonicalMaterializationSource,
  type CanonicalMaterializationBinding,
  type StoredCanonicalMaterialization,
} from './strategy-materialization.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const tenant = id(1), actor = 'user_fixture';
  const binding: CanonicalMaterializationBinding = {
    canonical: {
      canonicalPlanId: id(2), tenantId: tenant, clientId: id(3), objectiveId: id(4),
      canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 1, epoch: 1,
      requestedIntentId: id(7), requestedObjectiveRevisionId: id(8),
      requestedObjectiveVersion: 2, snapshotHash: 'a'.repeat(64),
    },
    generationRequestId: id(9), objectiveReceiptSha256: 'b'.repeat(64), snapshotDigest: '',
  };
  const input = parseMaterialization({ requestId: id(10), generationJobId: id(11), expected: {
    strategyId: id(5), strategyVersionId: id(12), objectiveRevisionId: id(8),
  } });
  const snapshot = {
    meta: { id: id(5), clientId: id(3), title: 'Saved canonical Strategy' },
    nodes: [{
      id: id(13), kind: 'action', subject: 'deliverable', title: 'Saved work', note: null,
      ownerUserId: null, status: 'draft', startsOn: '2026-10-16', endsOn: null,
      openEnded: false, meriAuthored: true, createdByUserId: actor,
      createdAt: '2026-10-16T00:00:00.000Z', dependsOnIds: [],
    }],
  };
  binding.snapshotDigest = digest(snapshot);
  const source = {
    generationJobId: input.generationJobId, generationRequestId: binding.generationRequestId,
    clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8),
    strategyId: id(5), strategyVersionId: id(12), snapshotDigest: digest(snapshot),
  };
  const plan = materializationPlan(snapshot, [{ id: id(13), archivedAt: null }], input);
  const at = '2026-10-16T00:00:00.000Z';
  const result = materializationResult(plan, input, source, tenant, actor, at,
    materializationOutputResolver(tenant, actor, input.requestId, binding));
  const stored: StoredCanonicalMaterialization = {
    receiptVersion: 2, input, binding, fingerprint: canonicalMaterializationFingerprint(input, binding),
    snapshot: plan.snapshot, archivedSourceNodeIds: [], result,
  };
  return { tenant, actor, input, binding, source, plan, stored, at };
}

describe('server-only canonical materialization identity', () => {
  test('uses the actual reserved default project in creation and checked immutable projection', () => {
    const x = fixture();
    const checked = checkedCanonicalMaterialization(x.stored, x.binding, x.tenant, x.actor);
    expect(checked.result.projects[0]!.output.id).toBe(x.binding.canonical.canonicalProjectId);
    expect(checked.result.tasks[0]!.output.id).toBe(materializationOutputId(x.tenant, x.actor, x.input.requestId, 'task', id(13)));
    expect(checked.result).toEqual(x.stored.result);
  });
  test('keeps the public/manual project derivation and v1 receipt exact', () => {
    const x = fixture();
    const result = materializationResult(x.plan, x.input, x.source, x.tenant, x.actor, x.at);
    const stored = { receiptVersion: 1 as const, input: x.input, fingerprint: digest(x.input),
      snapshot: x.plan.snapshot, archivedSourceNodeIds: [], result };
    expect(checkedMaterialization(stored, x.source, x.tenant, x.actor)).toEqual(stored);
    expect(result.projects[0]!.output.id).toBe(materializationOutputId(x.tenant, x.actor, x.input.requestId, 'project', 'default'));
    expect(canonicalMaterializationReceiptId(x.tenant, x.actor, x.input.requestId))
      .not.toBe(materializationReceiptId(x.tenant, x.actor, x.input.requestId));
  });
  test.each(['bindingVersion', 'epoch', 'requestedObjectiveVersion'] as const)('rejects malformed %s', (key) => {
    const x = fixture();
    for (const value of [0, -1, 1.5, 2147483648, '1']) {
      const binding = structuredClone(x.binding);
      (binding.canonical as Record<string, unknown>)[key] = value;
      expect(() => parseCanonicalMaterializationBinding(binding, x.input.requestId)).toThrow();
    }
  });
  test('refuses open bindings, unsupported epoch, groups and mismatched full source', () => {
    const x = fixture();
    expect(() => parseCanonicalMaterializationBinding({ ...x.binding, actor: x.actor }, x.input.requestId)).toThrow();
    expect(() => parseCanonicalMaterializationBinding({ ...x.binding, canonical: { ...x.binding.canonical, epoch: 2 } }, x.input.requestId)).toThrow();
    expect(() => requireCanonicalMaterializationSource({ ...x.input, groups: [{ key: 'default', name: 'Group', nodeIds: [id(13)] }] }, x.source, x.binding, x.tenant)).toThrow();
    for (const [key, value] of Object.entries({ generationJobId: id(20), generationRequestId: id(20), clientId: id(20), objectiveId: id(20), objectiveVersion: 3, objectiveRevisionId: id(20), strategyId: id(20), strategyVersionId: id(20), snapshotDigest: 'c'.repeat(64) }))
      expect(() => requireCanonicalMaterializationSource(x.input, { ...x.source, [key]: value }, x.binding, x.tenant)).toThrow();
    expect(() => requireCanonicalMaterializationSource(x.input, x.source, x.binding, id(20))).toThrow();
    expect(() => requireCanonicalMaterializationSource(x.input, { ...x.source, extra: 'unverified' } as typeof x.source, x.binding, x.tenant)).toThrow();
  });
  test('never treats an arbitrary group as the canonical default project', () => {
    const x = fixture();
    expect(() => materializationOutputResolver(x.tenant, x.actor, x.input.requestId, x.binding)('project', 'manual')).toThrow();
  });
  test('rejects tampered immutable output, binding, source and version-1 adoption', () => {
    const x = fixture();
    const output = structuredClone(x.stored);
    output.result.projects[0]!.output.id = id(99);
    expect(() => checkedCanonicalMaterialization(output, x.binding, x.tenant, x.actor)).toThrow();
    const source = structuredClone(x.stored);
    source.result.source.generationJobId = id(99);
    expect(() => checkedCanonicalMaterialization(source, x.binding, x.tenant, x.actor)).toThrow();
    const changed = structuredClone(x.binding);
    changed.objectiveReceiptSha256 = 'c'.repeat(64);
    expect(() => checkedCanonicalMaterialization(x.stored, changed, x.tenant, x.actor)).toThrow();
    expect(() => checkedCanonicalMaterialization({ ...x.stored, receiptVersion: 1 } as unknown as StoredCanonicalMaterialization, x.binding, x.tenant, x.actor)).toThrow();
    expect(() => checkedMaterialization(x.stored as never, x.source, x.tenant, x.actor)).toThrow();
  });
});
