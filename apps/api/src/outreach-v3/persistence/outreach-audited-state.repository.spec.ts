import type { TenantContext } from '@capiro/shared';
import { OutreachAuditedStateRepository } from './outreach-audited-state.repository.js';

describe('OutreachAuditedStateRepository', () => {
  const ctx = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
  } as TenantContext;
  const sessionId = '00000000-0000-4000-8000-000000000010';

  it('writes one proposal_superseded event for every eager terminal transition', async () => {
    const tx = {
      $queryRaw: jest.fn(async () => [
        {
          id: '00000000-0000-4000-8000-000000000020',
          expectedStateVersion: 4,
        },
        {
          id: '00000000-0000-4000-8000-000000000021',
          expectedStateVersion: 4,
        },
      ]),
    };
    const repository = new OutreachAuditedStateRepository();
    const appendEvent = jest
      .spyOn(repository, 'appendEvent')
      .mockResolvedValue({ id: 'event' } as never);

    await expect(
      repository.supersedeStaleProposals(tx as never, ctx, sessionId, 5),
    ).resolves.toBe(2);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledTimes(2);
    expect(appendEvent).toHaveBeenNthCalledWith(
      1,
      tx,
      ctx,
      { id: sessionId },
      {
        eventType: 'proposal_superseded',
        source: 'system',
        stateVersionBefore: 4,
        stateVersionAfter: 5,
        safeMetadata: {
          proposalId: '00000000-0000-4000-8000-000000000020',
          expectedStateVersion: 4,
          currentStateVersion: 5,
          reason: 'state_advanced',
        },
      },
    );
  });

  it('emits no audit event when no proposal is superseded', async () => {
    const tx = {
      $queryRaw: jest.fn(async () => []),
    };
    const repository = new OutreachAuditedStateRepository();
    const appendEvent = jest.spyOn(repository, 'appendEvent');

    await expect(
      repository.supersedeStaleProposals(tx as never, ctx, sessionId, 5),
    ).resolves.toBe(0);
    expect(appendEvent).not.toHaveBeenCalled();
  });
});
