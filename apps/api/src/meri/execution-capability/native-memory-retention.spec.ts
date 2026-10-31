import { nativeMemoryExecutionFixture as fixture, NOW } from './native-memory-execution.fixture.js';
import {
  receiveNativeDatabaseCommand,
  type NativeDatabaseDomain,
} from './native-approved-database-execution.js';

// Real native receiver + domain + retention transaction wrapper, scripted DB/transport.
// The SQL double enforces the migration's witness precondition; this is not an RLS/PG receipt.
describe('native memory execution uses the canonical retention transaction', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it.each([false, true])(
    'binds a fresh witness for submission and pending readback, General=%s',
    async (general) => {
      const f = fixture('personal', general);
      await f.approve();
      expect(f.candidates.size).toBe(0);
      const result: any = await f.execute();
      expect(result.outcome.result.review).toMatchObject({
        status: 'pending',
        publishedMemoryId: null,
      });
      expect(f.candidateWriteCount()).toBe(1);
      expect(f.state.retentionEvents).toEqual(['begin', 'insert', 'verify', 'begin', 'verify']);
      expect(f.state.witnessReads).toBe(4);
      const replay: any = await f.read();
      expect(replay.outcome).toEqual(result.outcome);
      expect(f.state.witnessReads).toBe(8);
      expect(f.candidateWriteCount()).toBe(1);
    },
  );

  it.each(['missing', 'changed', 'unavailable', 'database_changed'] as const)(
    'rolls candidate, submission and execution receipt back when witness is %s',
    async (failure) => {
      const f = fixture();
      await f.approve();
      if (failure === 'missing') f.state.witness = null;
      if (failure === 'changed') f.state.changeAfterInsert = true;
      if (failure === 'unavailable') f.state.witnessUnavailableAfterInsert = true;
      if (failure === 'database_changed') f.state.databaseWitnessMismatch = true;
      await expect(f.execute()).rejects.toMatchObject({
        response: { code: 'MEMORY_RETENTION_UNAVAILABLE' },
      });
      expect(f.candidates.size).toBe(0);
      expect(f.submissions.size).toBe(0);
      expect(f.receipts.size).toBe(0);
      expect(f.decisions.size).toBe(1); // separately recorded submission approval survives
    },
  );

  it('withholds a retained pending result after suppression without resubmitting', async () => {
    const f = fixture();
    await f.approve();
    await f.execute();
    f.state.suppressCandidate = true;
    await expect(f.read()).rejects.toMatchObject({
      response: { code: 'MEMORY_RETENTION_UNAVAILABLE' },
    });
    expect(f.candidateWriteCount()).toBe(1);
    expect(f.receipts.size).toBe(1);
  });

  it('keeps the committed receipt after a lost response and reconciles without a second candidate', async () => {
    const f = fixture();
    await f.approve();
    f.state.loseResponse = true;
    await expect(f.execute()).rejects.toThrow();
    expect(f.receipts.size).toBe(1);
    f.state.loseResponse = false;
    const result: any = await f.read();
    expect(result.outcome.result.candidateId).toBe(f.proposal.proposalId);
    expect(f.candidateWriteCount()).toBe(1);
  });

  it.each([3, 4])(
    'preserves a committed outcome when post-commit witness read %s fails',
    async (read) => {
      const f = fixture();
      await f.approve();
      f.state.witnessUnavailableRead = read;
      await expect(f.execute()).rejects.toMatchObject({
        response: { code: 'MEMORY_RETENTION_UNAVAILABLE' },
      });
      expect(f.candidates.size).toBe(1);
      expect(f.submissions.size).toBe(1);
      expect(f.receipts.size).toBe(1);
      const recovered: any = await f.read();
      expect(recovered.outcome.result.candidateId).toBe(f.proposal.proposalId);
      expect(f.candidateWriteCount()).toBe(1);
    },
  );

  it.each([false, true])(
    'preserves the existing default transaction with userTransaction=%s',
    async (userTransaction) => {
      const f = fixture();
      const observedTransactions: Array<'tenant' | 'user' | null> = [];
      // No domain override, matching existing callers' prior transaction choice.
      // This checks the shared absence/read path, not task business behavior.
      const domain: NativeDatabaseDomain<Record<string, unknown>> = {
        kind: 'native-memory',
        actions: ['memory.propose'],
        userTransaction,
        authorize: async () => {
          observedTransactions.push(f.state.transactionKind);
          return [];
        },
        check: async () => undefined,
        execute: async () => {
          throw Error('must not execute without approval');
        },
        validate: () => {
          throw Error('no result expected');
        },
      };
      expect(
        await receiveNativeDatabaseCommand(f.ports, domain, f.req, f.ctx, f.body, 'read'),
      ).toBeNull();
      const { prisma } = f.ports;
      expect(observedTransactions).toEqual(
        userTransaction ? ['user', 'user'] : ['tenant', 'tenant'],
      );
      for (const call of (userTransaction ? prisma.withTenantUser : prisma.withTenant).mock.calls) {
        expect(call[0]).toBe(f.ctx.tenantId);
        if (userTransaction) expect(call[1]).toBe(f.ctx.userId);
      }
      expect(f.state.witnessReads).toBe(0);
      expect(f.state.retentionEvents).toEqual([]);
      expect(f.candidates.size + f.submissions.size + f.receipts.size).toBe(0);
    },
  );
});
