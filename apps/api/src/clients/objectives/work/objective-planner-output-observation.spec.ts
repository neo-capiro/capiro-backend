import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { ObjectivePlannerAppliedPair } from './objective-planner-applied.js';
import type { WorkAuthority, WorkState } from './objective-work-command.js';
import type { ObjectiveWorkOutputRequest } from './objective-work-output.js';
import { readObjectivePlannerOutputObservationWithinTx } from './objective-planner-output-observation.js';

// Actual shared Planner resource reader/ACL and actual projection. Only the SQL
// snapshot and already-verified private pair input are synthetic here. Full real
// v2/v3 codecs, native ancestry and private owner-cache integration are exercised
// in objective-planner-work-owner.focused.test.mjs, not claimed by this fixture.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-18T01:00:00.000Z', now = Date.parse(at);
const iso = (offset: number) => new Date(now + offset).toISOString();
type Json = Record<string, any>;
function fixture() {
  const ctx = { tenantId: id(1), tenantSlug: 'source-only', userId: id(2), clerkUserId: 'user_current_reader',
    role: 'standard_user' } as TenantContext;
  const a: WorkAuthority = { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorMembershipId: id(3),
    clerkUserId: ctx.clerkUserId, clientId: id(4), objectiveId: id(5), objectiveRevisionId: id(7),
    objectiveVersion: 2, objectiveStatus: 'ready' };
  const canonical = { tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId,
    canonicalPlanId: id(8), epoch: 1, canonicalProjectId: id(9), canonicalStrategyId: id(10),
    requestedObjectiveRevisionId: a.objectiveRevisionId, requestedObjectiveVersion: 2, bindingVersion: 2 };
  const pair = (receiptVersion: 2 | 3, version: number, recordedAt: string) => ({
    stored: { request: { canonical: { ...canonical, bindingVersion: version, requestedObjectiveVersion: version,
      requestedObjectiveRevisionId: version === 1 ? id(6) : id(7) } } },
    owner: { receiptVersion, snapshot: { meta: { meriContext: 'PRIVATE-SNAPSHOT-CONTEXT' } }, result: {
      recordedAt, counts: { createdProjects: receiptVersion === 2 ? 1 : 0 }, projects: [
        { output: { id: canonical.canonicalProjectId, createdVersion: 1, currentVersion: receiptVersion === 2 ? 1 : 3 } },
      ] } },
  } as unknown as ObjectivePlannerAppliedPair);
  const first = pair(2, 1, iso(-3000)), second = pair(3, 2, iso(-1000));
  const state: WorkState = { source: { canonicalPlanId: canonical.canonicalPlanId, canonicalEpoch: 1,
    canonicalStrategyId: canonical.canonicalStrategyId, canonicalProjectId: canonical.canonicalProjectId,
    canonicalBindingVersion: 2, rootIntentId: id(11), sourceRevisionId: a.objectiveRevisionId,
    sourceObjectiveVersion: 2, sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: id(12) }, control: null, consent: null };
  const request: ObjectiveWorkOutputRequest = { clientId: a.clientId, objectiveId: a.objectiveId, workAction: 'objective.plan.prepare',
    source: { revision: { id: a.objectiveRevisionId, version: 2 }, canonicalBindingVersion: 2 } };
  const f = { ctx, a, state, request, pairs: [first, second], rows: [{ rowKind: 'selected_project',
    id: canonical.canonicalProjectId, tenantId: a.tenantId, ownerId: 'PRIVATE-ORIGINAL-OWNER', version: 4,
    archived: false, createdAt: iso(-4000), data: { name: 'Human current title', clientId: a.clientId,
      privacy: 'private', members: [{ userId: ctx.clerkUserId, role: 'viewer' }], secret: 'PRIVATE-DATA' } }] as Json[] };
  const query = jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
    expect(sql.join('?')).toContain('WITH requested AS');
    expect(values).toEqual([a.tenantId, a.clientId, canonical.canonicalProjectId, 'planner_project']);
    return f.rows;
  });
  const tx = { $queryRaw: query, $executeRaw: jest.fn(() => { throw Error('No writer belongs to output projection'); }) };
  return { ...f, query, tx, read: () => readObjectivePlannerOutputObservationWithinTx(tx as unknown as Prisma.TransactionClient,
    f.ctx, f.a, f.state, f.request, f.pairs, at) };
}

describe('Planner project receipt/current-access observation', () => {
  it('separates original v2 creation, v3 application and the current authorized resource', async () => {
    const f = fixture(), result = await f.read(), project = result.planner.projects[0]!;
    expect(result.state).toBe('applied'); expect(result.strategy).toEqual({ availability: 'unavailable' });
    expect(project.creation).toEqual({ receiptVersion: 2, recordedAt: iso(-3000), version: 1 });
    expect(project.application).toEqual({ receiptVersion: 3, recordedAt: iso(-1000) });
    expect(project.current).toEqual({ selection: { kind: 'planner_project', id: id(9) }, title: 'Human current title',
      ownerVersion: { kind: 'counter', value: 4 }, observedAt: at });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|meriContext|strategyId|snapshot|ownerId|task/);
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each(['private', 'archived', 'client moved', 'missing', 'bad grants'])('withholds every selector/provenance on %s', async reason => {
    const f = fixture(), row = f.rows[0]!;
    if (reason === 'private') row.data.members = [];
    if (reason === 'archived') row.archived = true;
    if (reason === 'client moved') row.data.clientId = id(99);
    if (reason === 'missing') f.rows.splice(0);
    if (reason === 'bad grants') row.data.members = [{ userId: f.ctx.clerkUserId, role: 'superuser' }];
    const result = await f.read();
    expect(result.state).toBe('applied'); expect(result.planner).toEqual({ availability: 'unavailable', projects: [
      { availability: 'unavailable', creation: null, application: null, current: null },
    ] });
    expect(JSON.stringify(result)).not.toContain(id(9));
  });
  it('rechecks current access on every call and does not retain prior selectors', async () => {
    const f = fixture(); expect((await f.read()).planner.availability).toBe('available');
    f.rows[0]!.data.members = [];
    expect((await f.read()).planner.projects[0]!.current).toBeNull(); expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each(['revision', 'source version', 'binding', 'context', 'creation missing', 'creation duplicated', 'creation future'])
  ('refuses invalid exact-source/custody projection: %s', async reason => {
    const f = fixture();
    if (reason === 'revision') f.request.source.revision.id = id(98);
    if (reason === 'source version') f.request.source.revision.version = 3;
    if (reason === 'binding') f.request.source.canonicalBindingVersion = 3;
    if (reason === 'context') f.ctx.clerkUserId = 'foreign_clerk';
    if (reason === 'creation missing') f.pairs.splice(0, 1);
    if (reason === 'creation duplicated') f.pairs.unshift(f.pairs[0]!);
    if (reason === 'creation future') f.pairs[0]!.owner.result.recordedAt = iso(500);
    const result = await f.read(); expect(result.state).toBe('outcome_unconfirmed');
    expect(result.planner.projects).toEqual([]); expect(f.query).not.toHaveBeenCalled();
  });
  it('rejects a current project version older than the proved selected application', async () => {
    const f = fixture(); f.rows[0]!.version = 2;
    expect((await f.read()).state).toBe('outcome_unconfirmed');
  });
  it('refuses coherent creation/application times both later than the observed database clock', async () => {
    const f = fixture(); f.pairs[0]!.owner.result.recordedAt = iso(500); f.pairs[1]!.owner.result.recordedAt = iso(1000);
    expect((await f.read()).state).toBe('outcome_unconfirmed'); expect(f.query).not.toHaveBeenCalled();
  });
  it('does not invoke a private-input getter', async () => {
    const f = fixture(), trap = jest.fn(() => { throw Error('Getter must not execute'); });
    Object.defineProperty(f.pairs[1]!.owner, 'result', { enumerable: true, get: trap });
    expect((await f.read()).state).toBe('outcome_unconfirmed'); expect(trap).not.toHaveBeenCalled();
  });
});
