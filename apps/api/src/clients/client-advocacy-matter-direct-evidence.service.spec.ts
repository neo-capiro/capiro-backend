import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

/**
 * Focused unit coverage for direct private-evidence linking (product spec
 * section 8/14): meeting, mail_thread, outreach, strategy link types added
 * on top of PR #1253's program_element/bill/outcome_event/finding links.
 *
 * Each method validates access through the SAME gate the canonical read
 * path already uses (meeting: tenant+client+visibility=shared scoped
 * Prisma query; mail thread: EngagementService.listMailThreads; outreach:
 * EngagementService.getOutreachRecord) rather than re-deriving access
 * control — these tests assert that gate is actually consulted, not just
 * that a row gets inserted.
 */
describe('ClientAdvocacyMatterService — direct evidence links', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'user-1';
  const ctx = { tenantId, userId } as never;
  const clientId = '22222222-2222-2222-2222-222222222222';
  const matterId = '33333333-3333-3333-3333-333333333333';
  const meetingId = '66666666-6666-6666-6666-666666666666';
  const threadId = '77777777-7777-7777-7777-777777777777';
  const outreachId = '88888888-8888-8888-8888-888888888888';
  const strategyId = '99999999-9999-9999-9999-999999999999';

  const makeService = () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => [] as unknown[]),
      $executeRawUnsafe: jest.fn(async (_query: string, ..._args: unknown[]) => 1),
      client: { findFirst: jest.fn(async () => ({ id: clientId })) },
      meeting: { findFirst: jest.fn(async () => null) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tenantTx: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const engagement = {
      listMailThreads: jest.fn(async () => [] as unknown[]),
      getOutreachRecord: jest.fn(async () => ({}) as Record<string, unknown>),
    };
    return { service: new ClientAdvocacyMatterService(prisma as never, engagement as never), tx, prisma, engagement };
  };

  /** assertMatterBelongsToClient's SELECT — every link method calls it
   *  before touching the source object. Queue this first for tests that
   *  don't otherwise stub $queryRawUnsafe's first call. */
  function stubMatterExists(tx: ReturnType<typeof makeService>['tx']) {
    (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([{ id: matterId }]);
  }

  describe('linkMeeting', () => {
    test('links a SHARED meeting and captures attendee + government-identity metadata, never a transcript', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);
      (tx.meeting.findFirst as jest.Mock).mockResolvedValueOnce({
        id: meetingId,
        subject: 'HASC staff meeting',
        startsAt: new Date('2026-03-12T14:00:00Z'),
        attendees: [
          { name: 'Jordan Staff', email: 'jordan@hasc.house.gov', contact: { directoryEntryId: 'dir-123' } },
        ],
        debriefs: [{ id: 'debrief-1', status: 'approved' }],
      });

      await service.linkMeeting(ctx, clientId, matterId, meetingId);

      // The Prisma query itself must scope to visibility: 'shared' — proves
      // the gate is the query shape, not a post-hoc filter.
      const findFirstCall = (tx.meeting.findFirst as jest.Mock).mock.calls[0][0];
      expect(findFirstCall.where.visibility).toBe('shared');
      expect(findFirstCall.where.clientId).toBe(clientId);

      const insertCall = (tx.$executeRawUnsafe as jest.Mock).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall).toContain('meeting');
      expect(insertCall).toContain(meetingId);
      const metadataJson = insertCall!.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('{'));
      expect(metadataJson).toBeDefined();
      const metadata = JSON.parse(metadataJson as string);
      expect(metadata.attendees[0].governmentDirectoryEntryId).toBe('dir-123');
      expect(metadata.approvedDebriefId).toBe('debrief-1');
      // No transcript, note body, or debrief body anywhere in the payload.
      expect(JSON.stringify(metadata)).not.toMatch(/bodyCiphertext|transcript/i);
    });

    test('rejects a meeting that is not shared (or not this client\'s) — never falls back to a private meeting', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);
      (tx.meeting.findFirst as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.linkMeeting(ctx, clientId, matterId, meetingId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('linkMailThread', () => {
    test('links a thread returned by the canonical listMailThreads client-association gate', async () => {
      const { service, tx, engagement } = makeService();
      stubMatterExists(tx);
      (engagement.listMailThreads as jest.Mock).mockResolvedValueOnce([
        { id: threadId, subject: 'RE: Ground Robotics Funding', participants: [{ email: 'staff@hasc.house.gov' }], lastMessageAt: new Date('2026-03-01T00:00:00Z'), createdAt: new Date('2026-02-28T00:00:00Z') },
      ]);

      await service.linkMailThread(ctx, clientId, matterId, threadId);

      expect(engagement.listMailThreads).toHaveBeenCalledWith(ctx, { clientId });
      const insertCall = (tx.$executeRawUnsafe as jest.Mock).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
      );
      expect(insertCall).toContain('mail_thread');
      expect(insertCall).toContain(threadId);
    });

    test('rejects a thread id not present in the client-associated list — no body ever read', async () => {
      const { service, tx, engagement } = makeService();
      stubMatterExists(tx);
      (engagement.listMailThreads as jest.Mock).mockResolvedValueOnce([]);

      await expect(service.linkMailThread(ctx, clientId, matterId, threadId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('linkOutreach', () => {
    test('links an outreach record belonging to this client', async () => {
      const { service, tx, engagement } = makeService();
      stubMatterExists(tx);
      (engagement.getOutreachRecord as jest.Mock).mockResolvedValueOnce({
        id: outreachId,
        clientId,
        title: 'FY27 funding ask campaign',
        type: 'campaign',
        status: 'sent',
        recipientCount: 5,
        sentAt: new Date('2026-03-05T00:00:00Z'),
        createdAt: new Date('2026-03-01T00:00:00Z'),
      });

      await service.linkOutreach(ctx, clientId, matterId, outreachId);

      const insertCall = (tx.$executeRawUnsafe as jest.Mock).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
      );
      expect(insertCall).toContain('outreach');
      const metadataJson = insertCall!.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('{'));
      const metadata = JSON.parse(metadataJson as string);
      expect(metadata.recipientCount).toBe(5);
      expect(metadata.status).toBe('sent');
    });

    test('rejects an outreach record belonging to a DIFFERENT client — no cross-client leakage', async () => {
      const { service, tx, engagement } = makeService();
      stubMatterExists(tx);
      (engagement.getOutreachRecord as jest.Mock).mockResolvedValueOnce({
        id: outreachId,
        clientId: 'some-other-client',
        title: 'Unrelated campaign',
        type: 'campaign',
        status: 'sent',
        recipientCount: 1,
        sentAt: null,
        createdAt: new Date(),
      });

      await expect(service.linkOutreach(ctx, clientId, matterId, outreachId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('linkStrategy', () => {
    test('links a planned_action with causationClaimed:false and never asserts the activity occurred', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);
      (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
        { strategyTitle: 'Ground Robotics Strategy', nodeId: 'node-1', nodeTitle: 'Brief HASC staff', subject: 'member' },
      ]);

      await service.linkStrategy(ctx, clientId, matterId, { strategyId, nodeId: 'node-1', relationshipType: 'planned_action' });

      const insertCall = (tx.$executeRawUnsafe as jest.Mock).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
      );
      expect(insertCall).toContain('strategy');
      expect(insertCall).toContain('planned_action');
      const metadataJson = insertCall!.find((arg: unknown) => typeof arg === 'string' && arg.startsWith('{'));
      const metadata = JSON.parse(metadataJson as string);
      expect(metadata.causationClaimed).toBe(false);
    });

    test('links a completed_action distinctly from planned_action', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);
      (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
        { strategyTitle: 'Ground Robotics Strategy', nodeId: 'node-1', nodeTitle: 'Brief HASC staff', subject: 'member' },
      ]);

      await service.linkStrategy(ctx, clientId, matterId, { strategyId, nodeId: 'node-1', relationshipType: 'completed_action' });

      const insertCall = (tx.$executeRawUnsafe as jest.Mock).mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('INSERT INTO client_advocacy_matter_link'),
      );
      expect(insertCall).toContain('completed_action');
      expect(insertCall).not.toContain('planned_action');
    });

    test('rejects a strategy/node not found for this client', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);
      (tx.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([]);

      await expect(
        service.linkStrategy(ctx, clientId, matterId, { strategyId, relationshipType: 'planned_action' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    test('treats a missing sp_strategy table (api-strategy not provisioned in this environment) as source unavailable, not "not found"', async () => {
      const { service, tx } = makeService();
      stubMatterExists(tx);
      (tx.$queryRawUnsafe as jest.Mock).mockRejectedValueOnce(new Error('relation "sp_strategy" does not exist'));

      await expect(
        service.linkStrategy(ctx, clientId, matterId, { strategyId, relationshipType: 'planned_action' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
