import { MeriExecutionReceiverService } from './meri-execution-receiver.service.js';
import { nativeCanonicalSha256 as hash } from '../native-approvals/native-approval.contract.js';
import { nativeMemoryExecutionFixture, id, NOW } from './native-memory-execution.fixture.js';

function fixture(scope = 'personal', general = false) {
  return nativeMemoryExecutionFixture(
    scope,
    general,
    ({ prisma, approvals, tenant, memory }) =>
      new MeriExecutionReceiverService(
        prisma,
        {} as any,
        null,
        approvals,
        tenant,
        undefined,
        memory,
      ),
  );
}

describe('native approved memory submission and exact review readback', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());
  it.each([
    ['personal', false],
    ['personal', true],
    ['client', false],
    ['firm', true],
  ] as const)(
    'submits %s General=%s only after approval and never publishes',
    async (scope, general) => {
      const f = fixture(scope, general);
      expect(await f.read()).toBeNull();
      await expect(f.execute()).rejects.toThrow();
      expect(f.candidates.size).toBe(0);
      await f.approve();
      expect(f.candidates.size).toBe(0);
      const first: any = await f.execute();
      expect(first.status).toBe('observed');
      expect(first.outcome.execution.kind).toBe('native-memory');
      expect(first.outcome.result.review.status).toBe('pending');
      expect(first.outcome.result.review.publishedMemoryId).toBeNull();
      expect(f.candidates.get(id(9)).payload.value).toBe(f.command.arguments.content);
      expect(f.candidates.get(id(9)).payload.scope).toBe(
        scope === 'personal' ? 'user_private' : scope,
      );
      expect(f.candidates.get(id(9)).provenance.origin.commandSha256).toBe(
        f.proposal.commandSha256,
      );
      expect(await f.execute()).toEqual(first);
      expect(((await f.read()) as any).outcome).toEqual(first.outcome);
      expect(f.candidateWriteCount()).toBe(1);
      expect(f.submissions.size).toBe(1);
      expect(f.receipts.size).toBe(1);
    },
  );
  it('recovers a lost post-commit response with the original outcome, even after expiry/revocation', async () => {
    const f = fixture();
    await f.approve();
    f.state.loseResponse = true;
    await expect(f.execute()).rejects.toThrow();
    expect(f.candidates.size).toBe(1);
    f.state.loseResponse = false;
    f.state.now += 1000000;
    f.state.revoked = true;
    expect(((await f.read()) as any).outcome.result.candidateId).toBe(f.proposal.proposalId);
    expect(f.candidateWriteCount()).toBe(1);
  });
  it.each(['approved', 'rejected', 'withdrawn', 'not_found'])(
    'reports current %s without another submission',
    async (status) => {
      const f = fixture();
      await f.approve();
      await f.execute();
      f.state.now += 1000;
      if (status === 'not_found') f.candidates.clear();
      else
        Object.assign(f.candidates.get(id(9)), {
          status,
          decidedAt: new Date(f.state.now),
          committedMemoryId: status === 'approved' ? id(80) : null,
        });
      const result: any = await f.read();
      expect(result.outcome.result.review.status).toBe(status);
      expect(result.outcome.result.review.publishedMemoryId).toBe(
        status === 'approved' ? `clio:${id(80)}` : null,
      );
      expect(f.candidateWriteCount()).toBe(1);
    },
  );
  it('rolls candidate and submission back when the execution receipt cannot commit', async () => {
    const f = fixture();
    await f.approve();
    f.state.complete = false;
    await expect(f.execute()).rejects.toThrow();
    expect(f.candidates.size + f.submissions.size + f.receipts.size).toBe(0);
  });
  it.each(['session', 'member', 'wall', 'conversation'])(
    'withholds execution/readback after current %s loss',
    async (key) => {
      const f = fixture('client');
      await f.approve();
      await f.execute();
      (f.state as any)[key] = false;
      await expect(f.read()).rejects.toThrow();
      await expect(f.execute()).rejects.toThrow();
      expect(f.candidateWriteCount()).toBe(1);
    },
  );
  it.each(['content', 'scope', 'ttlDays', 'clientId'])(
    'rejects altered prepared %s and does not submit',
    async (key) => {
      const f = fixture();
      (f.metadata.metadata.record.request as any)[key] = key === 'ttlDays' ? 29 : 'changed';
      await expect(f.approve()).rejects.toThrow();
      expect(f.candidates.size).toBe(0);
    },
  );
  it('refuses a keyed collision instead of guessing a correction target', async () => {
    const f = fixture();
    f.command.arguments.key = 'existing';
    f.metadata.metadata.record.request.key = 'existing';
    f.proposal.commandSha256 = hash(f.command);
    f.metadata.commandSha256 = f.proposal.commandSha256;
    f.metadata.metadata.commandSha256 = f.proposal.commandSha256;
    f.metadata.metadata.record.inputSha256 = hash({
      arguments: f.command.arguments,
      attachments: [],
    });
    await f.approve();
    f.state.collision = true;
    await expect(f.execute()).rejects.toThrow('correction');
    expect(f.candidates.size + f.receipts.size).toBe(0);
  });
  it('refuses fractional TTL instead of silently changing the reviewed lifetime', async () => {
    const f = fixture();
    f.command.arguments.ttlDays = 1.5;
    f.proposal.commandSha256 = hash(f.command);
    await expect(f.approve()).rejects.toThrow();
    expect(f.candidates.size).toBe(0);
  });
});
