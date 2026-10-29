import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../memory-authorization.service.js';
import { skeletonSections } from '../memory-catalog.js';
import {
  draftId,
  draftRequestHash,
  draftTarget,
  parseDraftWrite,
  type DraftTarget,
} from './input.js';
import { requireDraftTarget, readDraftBase } from './authority.js';
import { draftReceipt, readDraft, writeDraft } from './store.js';
import { lockMemoryRetentionInTx } from '../memory-retention-selection.js';

@Injectable()
export class SettingsMemoryDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
  ) {}
  private run<T>(
    ctx: TenantContext,
    type: string,
    slug: string,
    fn: (tx: Prisma.TransactionClient, target: DraftTarget, current: TenantContext) => Promise<T>,
    erasing = false,
  ) {
    const target = draftTarget(type, slug, ctx.userId);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const ready = await tx.$queryRaw<
        Array<{ ready: boolean }>
      >`SELECT to_regclass('public.memory_settings_drafts') IS NOT NULL AS ready`;
      if (!ready[0]?.ready)
        throw new ServiceUnavailableException('Private memory drafts are not available yet.');
      if (erasing) await lockMemoryRetentionInTx(tx);
      const current = await requireDraftTarget(tx, ctx, target, this.authorization);
      return fn(tx, target, current);
    });
  }
  readFile(ctx: TenantContext, type: string, slug: string) {
    return this.run(ctx, type, slug, async (tx, target, current) => {
      const base = await readDraftBase(tx, current, target, this.authorization);
      const drafts = await tx.$queryRaw<
        Array<{ id: string; revision: number; expiresAt: Date; updatedAt: Date }>
      >`
        SELECT id,revision,expires_at AS "expiresAt",updated_at AS "updatedAt" FROM memory_settings_drafts
        WHERE tenant_id=${ctx.tenantId}::uuid AND author_user_id=${ctx.userId}::uuid
          AND type=${target.type} AND slug=${target.slug} AND state='draft' AND expires_at>clock_timestamp()
          AND memory_settings_draft_live(tenant_id,author_user_id,author_period_id,owner_period_id,client_id)
        ORDER BY updated_at DESC,id DESC LIMIT 101`;
      return {
        schema: 'memory-settings-file/1',
        type,
        slug,
        scope: target.scope,
        ...base,
        sections: base.baseItemId ? base.sections : skeletonSections(type),
        drafts: drafts.slice(0, 100),
        hasMoreDrafts: drafts.length > 100,
        retention: { policyVersion: 1, draftDays: 30 },
        publicationAvailable: false,
      };
    });
  }
  read(ctx: TenantContext, type: string, slug: string, id: string) {
    draftId(id);
    return this.run(ctx, type, slug, async (tx, target, current) => {
      const row = await readDraft(tx, current, target, id);
      if (!row) throw new NotFoundException('Draft unavailable or expired.');
      const base = await readDraftBase(tx, current, target, this.authorization);
      return {
        schema: 'memory-settings-draft/1',
        ...row,
        baseChanged: row.baseItemId !== base.baseItemId || row.baseVersion !== base.baseVersion,
      };
    });
  }
  async save(ctx: TenantContext, type: string, slug: string, id: string, body: unknown) {
    draftId(id);
    const write = parseDraftWrite(type, body);
    return this.run(
      ctx,
      type,
      slug,
      async (tx, target, current) => {
        const base = await readDraftBase(tx, current, target, this.authorization);
        const receipt = await writeDraft(
          tx,
          current,
          target,
          id,
          write,
          draftRequestHash(target, id, write),
          base,
        );
        return { schema: 'memory-settings-draft-receipt/1', ...receipt };
      },
      write.action === 'discard',
    );
  }
  receipt(ctx: TenantContext, type: string, slug: string, id: string, requestId: string) {
    draftId(id);
    draftId(requestId);
    return this.run(ctx, type, slug, async (tx, target, current) => {
      const receipt = await draftReceipt(tx, current, requestId);
      // Receipt content is immutable metadata only. Target identity must still match.
      const binding = await tx.$queryRaw<
        Array<{ ok: boolean }>
      >`SELECT true AS ok FROM memory_settings_draft_receipts r
        WHERE r.tenant_id=${ctx.tenantId}::uuid AND r.author_user_id=${ctx.userId}::uuid AND r.request_id=${requestId}::uuid
          AND r.type=${target.type} AND r.slug=${target.slug} AND r.draft_id=${id}::uuid`;
      if (!receipt || receipt.draftId !== id || !binding[0]?.ok)
        throw new NotFoundException('Draft receipt unavailable.');
      return { schema: 'memory-settings-draft-receipt/1', ...receipt };
    });
  }
}
