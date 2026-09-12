import { assertMeetingPrepSourceAccess } from './meeting-prep-source-access.js';

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
});
