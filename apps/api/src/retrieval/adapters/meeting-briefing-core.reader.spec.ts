import { readMeetingBriefingCore } from './meeting-briefing-core.reader.js';

const request = {
  queryClass: 'lookup',
  requestedDomains: ['meetings'],
  caller: {
    tenantId: 'tenant',
    userId: 'actor',
    clientIds: ['client'],
    authorizedClientIds: ['client'],
  },
  meetingBriefing: {
    meetingId: 'current',
    scope: 'client',
    meetingLimit: 25,
    threadLimit: 100,
    messageLimit: 1000,
    meetingSince: new Date('2026-03-01'),
    emailSince: new Date('2026-06-01'),
    asOf: new Date('2026-09-12'),
    upcomingThrough: new Date('2026-10-12'),
  },
};
describe('expanded governed meeting history reader', () => {
  test('reads 25 past meetings with decrypted permitted artifacts, and labels restricted content', async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      id: 'meeting-' + index,
      subject: 'Strategy',
      startsAt: new Date('2026-08-01'),
      notes: [
        {
          id: 'allowed',
          confidential: true,
          accessLevel: 'tenant_admins_and_author',
          authorUserId: 'actor',
          bodyCiphertext: 'cipher',
          iv: 'iv',
          authTag: 'tag',
          status: 'approved',
        },
        {
          id: 'restricted',
          confidential: true,
          accessLevel: 'tenant_admins_and_author',
          authorUserId: 'someone-else',
          bodyCiphertext: 'secret',
          iv: 'iv',
          authTag: 'tag',
          status: 'approved',
        },
      ],
      debriefs: [],
    }));
    const tx = {
      meeting: { findMany: jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]) },
      tenantMembership: { findFirst: jest.fn().mockResolvedValue({ role: 'standard_user' }) },
    };
    const decrypt = jest.fn(() => 'We committed to deliver a memo.');
    const result = await readMeetingBriefingCore(
      'meetings',
      tx as never,
      request as never,
      ['client'],
      { decrypt } as never,
    );
    expect(result.records).toHaveLength(25);
    expect(decrypt).toHaveBeenCalledTimes(25);
    expect(JSON.stringify(result.records)).not.toContain('secret');
    expect(result.degradedReason).toContain('partial');
    const where = tx.meeting.findMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).toContain('actor');
    expect(JSON.stringify(where)).toContain('2026-03-01');
    expect(tx.meeting.findMany.mock.calls[0]![0].take).toBe(26);
  });
  test('open tasks have no age cutoff and pagination is explicit', async () => {
    const tx = {
      engagementTask: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 101 }, (_, i) => ({
            id: String(i),
            title: 'Old promise',
            status: 'open',
          })),
        ),
      },
    };
    const result = await readMeetingBriefingCore('tasks', tx as never, request as never, [
      'client',
    ]);
    expect(tx.engagementTask.findMany.mock.calls[0]![0].where.OR[0]).toEqual({
      status: { notIn: ['done', 'canceled'] },
    });
    expect(result.records).toHaveLength(100);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('99');
  });
  test('internal calls cannot expand into ambient authorized clients', async () => {
    const tx = { engagementTask: { findMany: jest.fn().mockResolvedValue([]) } };
    await readMeetingBriefingCore(
      'tasks',
      tx as never,
      {
        ...request,
        query: 'Annual strategy',
        meetingBriefing: { ...request.meetingBriefing, scope: 'internal' },
      } as never,
      ['unrelated-client'],
    );
    const where = tx.engagementTask.findMany.mock.calls[0]![0].where;
    expect(where.clientId).toBeNull();
    expect(where.ownerUserId).toBe('actor');
    expect(JSON.stringify(where)).not.toContain('unrelated-client');
  });
  test('disconnected mail is a source gap, not evidence of no correspondence', async () => {
    const tx = { integrationConnection: { findMany: jest.fn().mockResolvedValue([]) } };
    const result = await readMeetingBriefingCore('mail', tx as never, request as never, ['client']);
    expect(result.sourceStatus).toBe('unavailable');
    expect(result.degradedReason).toBe('authorized_mailbox_connection_not_found');
  });
  test('reads beyond 15 threads and 30 days while retaining an old promise and its latest reply', async () => {
    const ids = ['old-promise', ...Array.from({ length: 40 }, (_, i) => 'thread-' + i)];
    const message = (threadId: string, suffix: string, sentAt: string) => ({
      id: threadId + suffix,
      threadId,
      thread: { clientId: 'client' },
      bodyText: 'We will deliver the memo.',
      sentAt: new Date(sentAt),
    });
    const originals = ids.map((id) => ({ id, messages: [message(id, '-original', '2025-12-01')] }));
    const latest = ids.map((id) => ({ id, messages: [message(id, '-latest', '2026-09-01')] }));
    const tx = {
      integrationConnection: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'mailbox', provider: 'microsoft_365', status: 'connected', syncState: {} },
          ]),
      },
      engagementTask: { findMany: jest.fn().mockResolvedValue([{ mailThreadId: 'old-promise' }]) },
      mailThread: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(ids.slice(1).map((id) => ({ id })))
          .mockResolvedValueOnce(originals)
          .mockResolvedValueOnce(latest),
      },
      mailMessage: {
        count: jest.fn().mockResolvedValue(82),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const result = await readMeetingBriefingCore('mail', tx as never, request as never, ['client']);
    expect(result.records).toHaveLength(82);
    expect(result.records.map((row) => row.recordId)).toEqual(
      expect.arrayContaining(['old-promise-original', 'old-promise-latest', 'thread-39-original']),
    );
    expect(result.records[0]?.payload.clientId).toBe('client');
    const query = tx.mailThread.findMany.mock.calls[0]![0];
    expect(query.take).toBe(101);
    expect(JSON.stringify(query.where)).toContain('2026-06-01');
    expect(JSON.stringify(query.where)).toContain('old-promise');
  });
});
