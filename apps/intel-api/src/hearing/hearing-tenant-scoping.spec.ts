import { HearingSessionService } from './hearing-session.service';
import { HearingBriefService } from './hearing-brief.service';
import { PostHearingService } from './post-hearing.service';
import { SegmentCommitService } from './segment-commit.service';
import { LiveHearingSourceTypeDto } from './dto/session.dto';
import type { PrismaService } from '../prisma/prisma.service';
import type { HearingCryptoService } from './hearing-crypto.service';
import type { OrchestratorClient } from './orchestrator.client';

/**
 * G3 caller-conversion sweep proof: every hearing-module Prisma call goes
 * through `prisma.withTenant(tenantId, ...)` (which sets the `app.current_tenant`
 * GUC the RLS policy checks), not a bare `this.prisma.<model>` call. This wiring
 * is now LOAD-BEARING: the RLS policies are applied (migrations
 * 20260706000000_hearing_rls_hold + 20260706010000_intel_full_rls_hold), so under
 * FORCE ROW LEVEL SECURITY a bare `this.prisma.<model>` call would return zero
 * rows without the GUC. These tests prove every call sets it.
 */
interface FakeModel {
  findFirst: jest.Mock;
  findMany: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  // `updateMany`/`aggregate` arrived with the split of raw transcript persistence
  // from AI enrichment (commitRawFinal + enrichFinal + protectSegmentText) and the
  // resume-offset read; they must be tenant-scoped like every other call.
  updateMany: jest.Mock;
  upsert: jest.Mock;
  count: jest.Mock;
  aggregate: jest.Mock;
}

function makeFakePrisma() {
  const models = new Map<string, FakeModel>();
  const model = (name: string): FakeModel => {
    let m = models.get(name);
    if (!m) {
      m = {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'created-1' }),
        update: jest.fn().mockResolvedValue({ id: 'updated-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue({ id: 'upserted-1' }),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _max: { endMs: null } }),
      };
      models.set(name, m);
    }
    return m;
  };
  const fakeTx = new Proxy(
    {},
    {
      get: (_target, prop: string) => model(prop),
    },
  );
  const withTenant = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(fakeTx));
  const prisma = { withTenant } as unknown as PrismaService;
  return { prisma, withTenant, model };
}

describe('G3: hearing module Prisma calls are tenant-scoped via withTenant', () => {
  describe('HearingSessionService', () => {
    it('create() scopes to the caller tenantId', async () => {
      const { prisma, withTenant } = makeFakePrisma();
      const service = new HearingSessionService(prisma);

      await service.create('tenant-1', 'user-1', {
        title: 'Markup',
        sourceType: LiveHearingSourceTypeDto.hearing,
        audioSource: 'browser_mic' as never,
      } as never);

      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    });

    it('getOwned() scopes to the caller tenantId', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      model('liveHearingSession').findFirst.mockResolvedValue({ id: 's1', tenantId: 'tenant-1' });
      const service = new HearingSessionService(prisma);

      await service.getOwned('tenant-1', 's1');
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    });

    it('list() scopes to the caller tenantId AND the caller user', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      const service = new HearingSessionService(prisma);

      // `list` now takes the clerk user id too: a private meeting/webinar/agency
      // session is creator-visible only, so tenant scoping alone is not enough.
      await service.list('tenant-1', 'user-1');
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(model('liveHearingSession').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'tenant-1',
            OR: [{ sourceType: { in: ['hearing', 'markup'] } }, { createdBy: 'user-1' }],
          }),
        }),
      );
    });
  });

  describe('SegmentCommitService', () => {
    it('commitFinal() persists the segment via create (never the tenant-scope-unsafe upsert), scoped to the caller tenantId', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      const crypto = { configured: false } as unknown as HearingCryptoService;
      const service = new SegmentCommitService(prisma, crypto);

      await service.commitFinal({
        tenantId: 'tenant-1',
        sessionId: 'sess-1',
        recordingPolicy: 'transcript_only',
        segment: { startMs: 0, endMs: 100, text: 'hello' } as never,
        extraction: { entityMentions: [], issueTags: [] } as never,
      });

      // Regression guard (LegiWatch "hearings don't transcribe"): commitFinal MUST
      // write via create, NOT upsert. scopedClient injects where.tenantId into
      // every where-bearing op incl. upsert; on this table upsert's where is the
      // COMPOUND unique (sessionId,startMs,endMs), and the injected sibling
      // tenantId silently dropped every segment (0 rows, no error). create is not
      // a where-bearing op, so it is passed through unrewritten.
      expect(model('transcriptSegment').create).toHaveBeenCalled();
      expect(model('transcriptSegment').upsert).not.toHaveBeenCalled();
      // Every Prisma call still tenant-scoped (no bare this.prisma.<model> call).
      expect(withTenant.mock.calls.every((c) => c[0] === 'tenant-1')).toBe(true);
      expect(withTenant).toHaveBeenCalled();
    });
  });

  describe('HearingBriefService', () => {
    it('generate() scopes both the session lookup and the derived reads to the caller tenantId', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      model('liveHearingSession').findFirst.mockResolvedValue({ id: 's1', title: 'Markup' });
      const crypto = { configured: false } as unknown as HearingCryptoService;
      const orchestrator = { configured: false } as unknown as OrchestratorClient;
      const service = new HearingBriefService(prisma, crypto, orchestrator);

      await service.generate('tenant-1', 's1', 'jwt');

      expect(withTenant.mock.calls.every((c) => c[0] === 'tenant-1')).toBe(true);
      expect(withTenant.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('PostHearingService', () => {
    it('summarize() scopes both the session lookup and the derived reads to the caller tenantId', async () => {
      const { prisma, withTenant, model } = makeFakePrisma();
      model('liveHearingSession').findFirst.mockResolvedValue({
        id: 's1',
        title: 'Markup',
        status: 'ended',
      });
      const crypto = { configured: false } as unknown as HearingCryptoService;
      const service = new PostHearingService(prisma, crypto);

      await service.summarize('tenant-1', 's1');

      expect(withTenant.mock.calls.every((c) => c[0] === 'tenant-1')).toBe(true);
      expect(withTenant.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('findQuotes() scopes to the caller tenantId', async () => {
      const { prisma, withTenant } = makeFakePrisma();
      const crypto = { configured: false } as unknown as HearingCryptoService;
      const service = new PostHearingService(prisma, crypto);

      await service.findQuotes('tenant-1', 's1');
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    });
  });
});
