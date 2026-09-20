import {
  assertMeetingPrepSourceAccess,
  assertSavedMeetingPrepAccess,
} from './meeting-prep-source-access.js';

describe('saved briefing native source authorization', () => {
  const ctx = { tenantId: 'tenant', userId: 'actor', role: 'standard_user' };
  const sources = [
    {
      id: 'meetings:old',
      access: { meetings: ['old'], notes: ['private-note'], clients: ['client'] },
    },
  ];
  const tx = () => ({
    meeting: { count: jest.fn().mockResolvedValue(1) },
    client: { count: jest.fn().mockResolvedValue(1) },
    meetingNote: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'private-note',
          confidential: true,
          accessLevel: 'tenant_admins_and_author',
          authorUserId: 'actor',
        },
      ]),
    },
  });
  test('accepts currently authorized calendar, client and note sources', async () => {
    await expect(
      assertMeetingPrepSourceAccess(tx() as never, ctx as never, sources as never),
    ).resolves.toBeUndefined();
  });
  test('uncited briefings remain usable with independent authorization provenance', async () => {
    await expect(
      assertSavedMeetingPrepAccess(tx() as never, ctx as never, {
        briefing: { version: 2 },
        grounding: {
          sources: [],
          accessSources: sources.map((source) => ({ access: source.access })),
        },
      }),
    ).resolves.toBeUndefined();
  });
  test('omitting display citations cannot bypass a revoked private source', async () => {
    const db = tx();
    db.client.count.mockResolvedValue(0);
    await expect(
      assertSavedMeetingPrepAccess(db as never, ctx as never, {
        briefing: { version: 2 },
        grounding: {
          sources: [],
          accessSources: sources.map((source) => ({ access: source.access })),
        },
      }),
    ).rejects.toThrow('source access changed');
  });
  test('a newly restricted note blocks persistence/display', async () => {
    const db = tx();
    db.meetingNote.findMany.mockResolvedValue([
      {
        id: 'private-note',
        confidential: true,
        accessLevel: 'tenant_admins_and_author',
        authorUserId: 'someone-else',
      },
    ]);
    await expect(
      assertMeetingPrepSourceAccess(db as never, ctx as never, sources as never),
    ).rejects.toThrow('source access changed');
  });
  test('revoked client-wall access blocks the saved briefing', async () => {
    const db = tx();
    db.client.count.mockResolvedValue(0);
    await expect(
      assertMeetingPrepSourceAccess(db as never, ctx as never, sources as never),
    ).rejects.toThrow('source access changed');
  });
  test('reassigned history and reparented notes must still satisfy the source scope', async () => {
    const db = tx();
    await assertMeetingPrepSourceAccess(db as never, ctx as never, sources as never);
    expect(db.meeting.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ clientId: null }, { clientId: { in: ['client'] } }] },
          ]),
        }),
      }),
    );
    expect(db.meetingNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ meetingId: { in: ['old'] } }) }),
    );
    db.meeting.count.mockResolvedValue(0);
    await expect(
      assertMeetingPrepSourceAccess(db as never, ctx as never, sources as never),
    ).rejects.toThrow('source access changed');
  });
  test('request-scoped monday evidence remains authorized after saved defaults change', async () => {
    const db = tx() as ReturnType<typeof tx> & {
      $executeRaw: jest.Mock;
      clioMcpServer: { count: jest.Mock };
      meetingPrepMondayMapping: { count: jest.Mock };
    };
    db.$executeRaw = jest.fn().mockResolvedValue(1);
    db.clioMcpServer = { count: jest.fn().mockResolvedValue(1) };
    db.meetingPrepMondayMapping = { count: jest.fn().mockResolvedValue(0) };
    await expect(
      assertMeetingPrepSourceAccess(db as never, ctx as never, [
        { access: { clients: ['client'], mondayUsers: ['actor'], mondayBoards: ['999'] } },
      ] as never),
    ).resolves.toBeUndefined();
    expect(db.meetingPrepMondayMapping.count).not.toHaveBeenCalled();
    expect(db.clioMcpServer.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant', ownerUserId: 'actor' }),
      }),
    );
  });
});
