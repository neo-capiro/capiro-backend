import { readObjectiveStrategyJobSubjectWithinTx } from '@capiro/shared/objective-strategy-intake';
import { ObjectiveJobService } from './objective-job.service.js';
import { objectiveJobFixture, id } from './objective-job.fixture.js';

describe('native saved Objective job subject', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(2000));
  afterEach(() => jest.restoreAllMocks());
  const read = (f: ReturnType<typeof objectiveJobFixture>, effect = true) => readObjectiveStrategyJobSubjectWithinTx(f.tx,
    { tenantId: id(9), generationJobId: id(5), effect });
  it('uses the original saved actor and current member/wall, not caller identity or bearer', async () => {
    const f = objectiveJobFixture(); const s = await read(f);
    expect(s).toMatchObject({ actorUserId: id(15), clientId: id(2), tenantId: id(9), checkedAtMs: 2000, effectExpiresAtMs: 5000 });
    expect(f.calls[0]).toContain('FOR UPDATE');
    expect(f.calls.findIndex(q => q.includes('JOIN tenant_memberships'))).toBeLessThan(f.calls.findIndex(q => q.includes('FOR SHARE OF ctl')));
  });
  it.each(['member', 'wall', 'objective', 'controls', 'acceptance'] as const)('refuses unavailable canonical %s', async key => {
    const f = objectiveJobFixture(); f.state[key] = false; await expect(read(f)).rejects.toThrow();
  });
  it.each([
    (f: any) => { f.control.cancelled = true; }, (f: any) => { f.control.consentId = id(90); },
    (f: any) => { f.control.version++; }, (f: any) => { f.control.sourceCurrent = false; },
    (f: any) => { f.member.membershipId = id(90); }, (f: any) => { f.job.claimedBy = 'legacy'; },
    (f: any) => { f.job.attempt = 3; }, (f: any) => { f.acceptance.sourceBinding.actorId = id(90); },
    (f: any) => { f.acceptance.effectExpiresAtMs = 6000; }, (f: any) => { f.job.input.bearer = 'discarded'; },
    (f: any) => { f.row.snapshot.version++; }, (f: any) => { f.row.receipt.actor_user_id = id(90); },
    (f: any) => { f.row.intake.typed_request.clientId = id(90); }, (f: any) => { f.state.now = 4500; },
  ])('refuses changed original consent/source/claim/currentness %#', async mutate => {
    const f = objectiveJobFixture(); mutate(f); await expect(read(f)).rejects.toThrow();
  });
  it('allows queued admission before AgentCore claim and late completion reads without renewing effects', async () => {
    const f = objectiveJobFixture(); Object.assign(f.job, { status: 'queued', attempt: 1, claimedBy: null, claimedAt: null });
    expect((await read(f)).status).toBe('queued');
    f.job.status = 'completed'; f.state.now = 9000; f.control.cancelled = true;
    expect((await read(f, false)).effectExpiresAtMs).toBe(5000);
    await expect(read(f)).rejects.toThrow(); f.state.wall = false; await expect(read(f, false)).rejects.toThrow();
  });
  function service(f: ReturnType<typeof objectiveJobFixture>, run = async () => ({ rows: ['actual-owner-dto'] })) {
    return new ObjectiveJobService(f.prisma, {} as never, {} as never, { handles: () => true, read: run } as never);
  }
  const body = (f: ReturnType<typeof objectiveJobFixture>) => ({ schemaVersion: 1, generationJobId: id(5),
    operation: 'job.readMailboxes', input: {}, context: f.context });
  it('private current/read use actual service guard; wrong service and body principal never reach DB', async () => {
    const f = objectiveJobFixture(), owner = service(f);
    await expect(owner.current({ schemaVersion: 1, generationJobId: id(5) }, {} as never)).rejects.toThrow();
    await expect(owner.current({ schemaVersion: 1, generationJobId: id(5), actorId: id(90) }, f.req)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(await owner.current({ schemaVersion: 1, generationJobId: id(5) }, f.req)).toMatchObject({ actorId: id(15), role: 'standard_user' });
    expect(await owner.read(body(f), f.req)).toEqual({ rows: ['actual-owner-dto'] });
  });
  it.each(['actorId', 'tenantId', 'runId', 'conversationId'] as const)('refuses foreign correlation %s before source access', async field => {
    const f = objectiveJobFixture(), run = jest.fn(async () => ({})), value = structuredClone(body(f));
    value.context.binding[field] = id(90);
    await expect(service(f, run).read(value, f.req)).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
  });
  it('late wall revocation and deadline expiry prevent source result release', async () => {
    const f = objectiveJobFixture();
    await expect(service(f, async () => { f.state.wall = false; return {}; }).read(body(f), f.req)).rejects.toThrow();
    const g = objectiveJobFixture();
    await expect(service(g, async () => { g.state.now = 5000; return {}; }).read(body(g), g.req)).rejects.toThrow();
  });
});
