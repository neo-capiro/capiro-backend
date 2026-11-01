import type { TenantContext } from '@capiro/shared';
import { describe, it, expect, jest } from '@jest/globals';
import { readMeetingDebriefContext } from './meeting-debrief-context-read.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  tenantSlug: 'test',
  role: 'user_admin',
};
const summary = {
  version: 'd2-debrief-context-v1',
  boundTokens: 8000,
  totalTokens: 123,
  sourceTruncated: false,
  sections: [{ name: 'source', tokens: 123, state: 'kept' }],
};
function fixture() {
  const state = { member: true, meeting: true, client: true, wall: true, role: 'standard_user' };
  const artifact = {
    id: 'd1',
    tenantId: ctx.tenantId,
    meetingId: 'm1',
    clientId: 'c1',
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    confidential: true,
    accessLevel: 'tenant_admins_and_author',
    authorUserId: ctx.userId,
    generatedFromJsonb: JSON.parse(JSON.stringify(summary)) as unknown,
  };
  const tx = {
    tenantMembership: {
      findFirst: jest.fn(async () => (state.member ? { role: state.role } : null)),
    },
    meeting: {
      findFirst: jest.fn(async () => (state.meeting ? { id: 'm1', clientId: 'c1' } : null)),
    },
    client: { findFirst: jest.fn(async () => (state.client ? { id: 'c1' } : null)) },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wall }]),
    meetingDebrief: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        Object.entries(where).every(([k, v]) => artifact[k as keyof typeof artifact] === v)
          ? artifact
          : null,
      ),
    },
  };
  const prisma: any = {
    withTenantUser: jest.fn(async (_t: string, _u: string, run: (tx: unknown) => unknown) =>
      run(tx),
    ),
  };
  return {
    state,
    artifact,
    tx,
    prisma,
    read: () => readMeetingDebriefContext(prisma, ctx, 'm1', 'd1'),
  };
}

describe('saved debrief generation context', () => {
  it('reads the saved JSON under the exact tenant, meeting, client and artifact', async () => {
    const f = fixture();
    expect(await f.read()).toEqual({
      id: 'd1',
      meetingId: 'm1',
      clientId: 'c1',
      revision: '2026-11-01T00:00:00.000Z',
      generatedFrom: summary,
    });
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
    expect(f.tx.meeting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'm1', tenantId: ctx.tenantId, OR: expect.any(Array) }),
      }),
    );
    expect(f.tx.meetingDebrief.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1', meetingId: 'm1', clientId: 'c1', tenantId: ctx.tenantId },
      }),
    );
    expect(f.tx.meetingDebrief.findFirst.mock.calls[0]![0]).not.toHaveProperty('include');
  });

  it.each(['member', 'meeting', 'client', 'wall'] as const)(
    'refuses revoked %s before reading provenance',
    async (key) => {
      const f = fixture();
      f.state[key] = false;
      await expect(f.read()).rejects.toThrow('not found');
      expect(f.tx.meetingDebrief.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(['tenantId', 'meetingId', 'clientId', 'id'] as const)(
    'refuses a mismatched %s',
    async (key) => {
      const f = fixture();
      f.artifact[key] = 'different';
      await expect(f.read()).rejects.toThrow('not found');
    },
  );

  it('uses current membership role rather than the stale request admin role', async () => {
    const f = fixture();
    f.artifact.authorUserId = 'someone-else';
    await expect(f.read()).rejects.toThrow('not found');
    f.state.role = 'user_admin';
    expect((await f.read()).generatedFrom).toEqual(summary);
  });

  it('preserves the existing non-confidential and explicit tenant-member access rules', async () => {
    const f = fixture();
    f.artifact.authorUserId = 'someone-else';
    f.artifact.confidential = false;
    expect((await f.read()).generatedFrom).toEqual(summary);
    f.artifact.confidential = true;
    f.artifact.accessLevel = 'tenant_members';
    expect((await f.read()).generatedFrom).toEqual(summary);
  });

  it('distinguishes absent legacy provenance from malformed or raw provider content', async () => {
    const f = fixture();
    f.artifact.generatedFromJsonb = null;
    expect((await f.read()).generatedFrom).toBeNull();
    for (const invalid of [
      { raw: 'private' },
      { ...summary, totalTokens: -1 },
      { ...summary, sections: Array(21).fill(summary.sections[0]) },
      { ...summary, raw: 'private' },
    ]) {
      f.artifact.generatedFromJsonb = invalid;
      await expect(f.read()).rejects.toThrow('Saved generation context is unavailable');
    }
  });
});
