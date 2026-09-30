import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import {
  assertSavedMeetingPrepAccess,
  filterResearchPortfolioMeetingPreps,
} from './meeting-prep-source-access.js';
const id = (n: number) => 'ed202609-2800-4000-8000-' + String(n).padStart(12, '0'),
  ctx = { tenantId: id(9400), userId: id(9410) } as TenantContext;
function fixture() {
  let internal = true,
    clientId: string | null = null,
    owner = ctx.userId,
    currentMeeting = id(9420),
    legacy = false;
  const bounded = {
      kind: 'research_portfolio',
      researchPortfolioId: id(9430),
      researchPortfolioName: 'Owned',
      researchPortfolioRevision: 1,
    },
    scope = {
      ...bounded,
      scopeVersion: createHash('sha256').update(JSON.stringify(bounded)).digest('hex'),
    };
  const generated: any = {
    schemaVersion: 'research_portfolio_institutional_v1',
    briefing: true,
    artifactId: id(9470),
    meetingId: id(9420),
    actorUserId: ctx.userId,
  };
  const artifact: any = {
    id: id(9470),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    conversationId: id(9440),
    kind: 'research_portfolio_meeting',
    metadata: {
      schemaVersion: 'research_portfolio_institutional_v1',
      researchPortfolioScope: scope,
      sourceLineage: { synthetic: true },
      meetingPrepId: id(9490),
      meetingId: id(9420),
    },
  };
  const locks: string[] = [];
  const tx: any = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('FROM meetings')) locks.push('meetings');
      if (sql.includes('FROM meeting_preps')) locks.push('meeting_preps');
      return 1;
    },
    tenantMembership: { findFirst: async () => ({ id: 'member' }) },
    researchPortfolio: {
      findFirst: async () => ({ id: id(9430), grants: [{ role: 'viewer' }], clientLinks: [] }),
    },
    clioConversation: {
      findFirst: async () => ({
        id: id(9440),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId: null,
        metadata: { researchPortfolioScope: scope },
      }),
    },
    clioArtifact: { findFirst: async () => artifact },
    meetingPrep: {
      findFirst: async () => ({
        id: id(9490),
        meetingId: currentMeeting,
        clientId,
        generatedFrom: generated,
      }),
    },
    meeting: {
      findFirst: async ({ where }: any) =>
        !where.OR || owner === ctx.userId
          ? { id: currentMeeting, clientId, isInternal: internal }
          : null,
    },
  };
  const writer: any = {
    lockMeetingClientAssignment: async () => undefined,
    ensureOwnMeeting: async () => ({ id: currentMeeting, clientId }),
  };
  return {
    tx,
    generated,
    artifact,
    locks,
    writer,
    setInternal: (v: boolean) => (internal = v),
    setClient: (v: string | null) => (clientId = v),
    setOwner: (v: string) => (owner = v),
    setMeeting: (v: string) => (currentMeeting = v),
    legacy: () => {
      legacy = true;
      delete generated.meetingId;
      delete artifact.metadata.meetingId;
    },
  };
}
describe('RP institutional canonical meeting boundary', () => {
  test('writer/replay requires current internal true, not merely client null', async () => {
    const f = fixture();
    await expect(
      EngagementService.prototype.assertOwnedResearchPortfolioMeeting.call(
        f.writer,
        f.tx,
        ctx,
        id(9420),
      ),
    ).resolves.toHaveProperty('id', id(9420));
    f.setInternal(false);
    await expect(
      EngagementService.prototype.assertOwnedResearchPortfolioMeeting.call(
        f.writer,
        f.tx,
        ctx,
        id(9420),
      ),
    ).rejects.toThrow('owned internal');
    f.setInternal(true);
    f.setClient(id(9423));
    await expect(
      EngagementService.prototype.assertOwnedResearchPortfolioMeeting.call(
        f.writer,
        f.tx,
        ctx,
        id(9420),
      ),
    ).rejects.toThrow('owned internal');
  });
  test('stored and joined prep reads deny noninternal/clientattached/currentowner changes, preserve ordinary rows', async () => {
    const f = fixture();
    await assertSavedMeetingPrepAccess(f.tx, ctx, f.generated);
    for (const mutate of [
      () => f.setInternal(false),
      () => {
        f.setInternal(true);
        f.setClient(id(9423));
      },
      () => {
        f.setClient(null);
        f.setOwner(id(9411));
      },
    ]) {
      mutate();
      await expect(assertSavedMeetingPrepAccess(f.tx, ctx, f.generated)).rejects.toThrow();
      expect(
        await filterResearchPortfolioMeetingPreps(f.tx, ctx, [
          { id: 'private', generatedFrom: f.generated },
          { id: 'ordinary', generatedFrom: {} },
        ]),
      ).toEqual([{ id: 'ordinary', generatedFrom: {} }]);
    }
  });
  test('new immutable meeting identity and reciprocal artifact/prep provenance fail closed on rebinding', async () => {
    const f = fixture();
    f.setMeeting(id(9421));
    await expect(assertSavedMeetingPrepAccess(f.tx, ctx, f.generated)).rejects.toThrow(
      'meeting identity changed',
    );
    f.setMeeting(id(9420));
    f.artifact.metadata.meetingPrepId = null;
    await expect(assertSavedMeetingPrepAccess(f.tx, ctx, f.generated)).rejects.toThrow(
      'binding is unavailable',
    );
  });
  test('legacy exact reciprocal server prep survives without invented metadata, with meeting-first lock order', async () => {
    const f = fixture();
    f.legacy();
    await assertSavedMeetingPrepAccess(f.tx, ctx, f.generated);
    expect(f.locks).toEqual(['meetings', 'meeting_preps']);
    expect(f.generated.meetingId).toBeUndefined();
    expect(f.artifact.metadata.meetingId).toBeUndefined();
  });
  test('ordinary provenance does not acquire RP locks or require an owned internal meeting', async () => {
    const f = fixture();
    f.setInternal(false);
    await assertSavedMeetingPrepAccess(f.tx, ctx, {});
    expect(f.locks).toEqual([]);
  });
});
