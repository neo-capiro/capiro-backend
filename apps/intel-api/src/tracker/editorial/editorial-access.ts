import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { object, digest } from '../reports/report-domain.js';
import { hash } from '../folders/folder-tracker.service.js';
export async function assertEditorialAccess(
  tx: Prisma.TransactionClient,
  ctx: WorkspaceTenantContext,
  snapshot: unknown,
  folder: (id: string) => Promise<unknown>,
  dispatch = false,
) {
  const review = object(object(snapshot).editorialReview);
  if (!Object.keys(review).length) return;
  if (review.ownerId !== ctx.clerkUserId) throw new NotFoundException('RUN_NOT_FOUND');
  const rows = await tx.$queryRaw<
    Array<{
      folder_id: string | null;
      client_id: string | null;
      input_hash: string;
      payload: Record<string, unknown>;
    }>
  >`SELECT folder_id,client_id,input_hash,payload FROM intel_legiwatch_editorial_selection WHERE id=${String(review.selectionId)} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
  const row = rows[0];
  if (!row || row.input_hash !== review.sourceHash)
    throw new NotFoundException('EDITORIAL_SOURCE_UNAVAILABLE');
  if (dispatch) {
    await tx.$queryRaw`SELECT m.user_id FROM tenant_memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=${ctx.tenantId}::uuid AND u.clerk_user_id=${ctx.clerkUserId} FOR SHARE OF m`;
    if (row.folder_id)
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE id=${row.folder_id} AND tenant_id=${ctx.tenantId} FOR SHARE`;
    if (row.client_id) {
      await tx.$queryRaw`SELECT id FROM clients WHERE id::text=${row.client_id} AND tenant_id=${ctx.tenantId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT a.user_id FROM client_memory_access a JOIN users u ON u.id=a.user_id WHERE a.client_id::text=${row.client_id} AND a.tenant_id=${ctx.tenantId}::uuid AND u.clerk_user_id=${ctx.clerkUserId} FOR SHARE OF a`;
    }
  }
  const currentFolder = row.folder_id ? await folder(row.folder_id) : null;
  if (row.client_id) {
    const allowed = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT c.id FROM clients c JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.status::text='active' JOIN users u ON u.id=m.user_id AND u.clerk_user_id=${ctx.clerkUserId} WHERE c.id::text=${row.client_id} AND c.tenant_id=${ctx.tenantId}::uuid AND c.status::text<>'archived' AND (NOT c.memory_wall OR EXISTS(SELECT 1 FROM client_memory_access a WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=u.id))`;
    if (!allowed.length) throw new NotFoundException('EDITORIAL_CLIENT_UNAVAILABLE');
  }
  if (!dispatch) return;
  const clients = row.client_id
    ? await tx.$queryRaw<
        Array<{ revision: string }>
      >`SELECT md5(to_jsonb(c)::text) AS revision FROM clients c WHERE c.id::text=${row.client_id} AND c.tenant_id=${ctx.tenantId}::uuid`
    : [];
  if (
    hash({
      folder: currentFolder,
      clientId: row.client_id,
      clientRevision: clients[0]?.revision ?? null,
    }) !== row.payload.contextVersion
  )
    throw new ConflictException('EDITORIAL_CLIENT_CONTEXT_CHANGED');
  const refs = Array.isArray(row.payload.sources) ? row.payload.sources.map(object) : [];
  for (const ref of refs) {
    if (ref.kind === 'budget' || ref.kind === 'personnel') {
      const refresh = await tx.$queryRaw<
        Array<{ manifest: Record<string, unknown> }>
      >`SELECT manifest FROM legiwatch_source_receipt WHERE source='phase8-refresh' AND source_url=${String(ref.sourceUrl)} AND observed_at>${new Date(String(ref.observedAt))} ORDER BY observed_at DESC,id DESC LIMIT 1`;
      if (refresh[0]?.manifest.status === 'changed_review_required')
        throw new ConflictException('PUBLISHER_CHANGE_REQUIRES_REVIEW');
    }
    if (ref.monitorId) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_news_monitor WHERE id=${String(ref.monitorId)} AND tenant_id=${ctx.tenantId} FOR SHARE`;
      const monitors = await tx.$queryRaw<
        Array<{ version: number; state: string }>
      >`SELECT version,state FROM intel_legiwatch_news_monitor WHERE id=${String(ref.monitorId)} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
      if (monitors[0]?.version !== ref.monitorVersion || monitors[0]?.state !== 'active')
        throw new ConflictException('SELECTED_MONITOR_CHANGED');
    }
    if (ref.billAssignmentId) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder_bill WHERE id=${String(ref.billAssignmentId)} AND tenant_id=${ctx.tenantId} FOR SHARE`;
      const assignment = await tx.legiWatchFolderBill.findFirst({
        where: { id: String(ref.billAssignmentId), tenantId: ctx.tenantId },
      });
      if (!assignment || assignment.version !== ref.billAssignmentVersion)
        throw new ConflictException('SELECTED_BILL_TRACKING_CHANGED');
    }
    for (const pin of Array.isArray(ref.projectTracking) ? ref.projectTracking.map(object) : []) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_evidence_tracking WHERE id=${String(pin.id)} AND tenant_id=${ctx.tenantId} FOR SHARE`;
      const rows = await tx.$queryRaw<
        Array<{ removed: boolean; version: number }>
      >`SELECT removed,version FROM intel_legiwatch_evidence_tracking WHERE id=${String(pin.id)} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
      if (!rows[0] || rows[0].removed || rows[0].version !== pin.version)
        throw new ConflictException('SELECTED_PROJECT_TRACKING_CHANGED');
    }
    if (ref.kind === 'news') {
      await tx.$queryRaw`SELECT c.article_id FROM legiwatch_news_current c JOIN legiwatch_news_observation o ON o.article_id=c.article_id WHERE o.id=${String(ref.id)} FOR SHARE OF c`;
      const current = await tx.$queryRaw<
        Array<{ revision: string }>
      >`SELECT revision FROM legiwatch_news_source WHERE id=${String(ref.id)} AND is_current`;
      if (current[0]?.revision !== ref.revision)
        throw new ConflictException('SELECTED_NEWS_CORRECTED');
    }
    if (ref.kind === 'budget') {
      const current = await tx.$queryRaw<
        Array<{ id: string; content_hash: string }>
      >`SELECT id,content_hash FROM florida_budget_document WHERE source_url=${String(ref.sourceUrl)} ORDER BY observed_at DESC,id DESC LIMIT 1`;
      if (current[0]?.id !== ref.id || current[0]?.content_hash !== ref.revision)
        throw new ConflictException('SELECTED_BUDGET_REVISED');
    }
    if (ref.kind === 'research') {
      const current = await tx.$queryRaw<
        Array<{ revision_hash: string }>
      >`SELECT revision_hash FROM legiwatch_research_document_source WHERE document_id=${String(ref.id)} AND is_current`;
      if (current[0]?.revision_hash !== ref.revision)
        throw new ConflictException('SELECTED_RESEARCH_REVISED');
    }
    if (ref.kind === 'personnel') {
      const current = await tx.$queryRaw<
        Array<{ revision: string }>
      >`SELECT p.revision FROM florida_personnel_observation p WHERE p.source_key=(SELECT source_key FROM florida_personnel_observation WHERE id=${String(ref.id)}) ORDER BY observed_at DESC,id DESC LIMIT 1`;
      if (current[0]?.revision !== ref.revision)
        throw new ConflictException('SELECTED_PERSONNEL_REVISED');
    }
    if (row.folder_id) {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_evidence_tracking WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND folder_id=${row.folder_id} AND kind=${String(ref.kind)} AND source_id=${String(ref.id)} FOR SHARE`;
      const removed =
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_evidence_tracking WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND folder_id=${row.folder_id} AND kind=${String(ref.kind)} AND source_id=${String(ref.id)} AND removed`;
      if ((removed as unknown[]).length) throw new ConflictException('SOURCE_MANUALLY_REMOVED');
    }
    if (ref.trackingId) {
      const current = await tx.$queryRaw<
        Array<{ version: number; removed: boolean }>
      >`SELECT version,removed FROM intel_legiwatch_evidence_tracking WHERE id=${String(ref.trackingId)} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
      if (!current[0] || current[0].removed || current[0].version !== ref.trackingVersion)
        throw new ConflictException('SELECTED_TRACKING_CHANGED');
    }
  }
  if (review.configId) {
    await tx.$queryRaw`SELECT id FROM intel_legiwatch_editorial_config WHERE id=${String(review.configId)} AND tenant_id=${ctx.tenantId} FOR SHARE`;
    const configs = await tx.$queryRaw<
      Array<{
        version: number;
        config: Record<string, unknown>;
        standing_approval: Record<string, unknown> | null;
        state: string;
      }>
    >`SELECT version,config,standing_approval,state FROM intel_legiwatch_editorial_config WHERE id=${String(review.configId)} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId}`;
    const config = configs[0];
    if (
      !config ||
      config.state !== 'active' ||
      config.version !== review.configVersion ||
      config.config.sendEnabled !== true ||
      config.standing_approval?.configHash !== digest(config.config)
    )
      throw new ConflictException('EDITORIAL_SCHEDULE_CHANGED_OR_PAUSED');
  }
}
