import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { legalTargetMatches, type LegalReference } from '@capiro/shared';
import { ResearchService } from './research.service.js';
import { checkedVersion } from '../keywords/keyword-rule.service.js';
import { hash } from '../folders/folder-tracker.service.js';
import { object } from '../reports/report-domain.js';

type Config = {
  kind: 'statute_reference';
  folderIds: string[];
  billIds: string[];
  jurisdiction: 'FL';
  sessionKey: string;
  descendants: boolean;
  cadence: 'manual' | 'hourly' | 'daily';
  recipients: Array<{ userId: string; email: boolean; inApp: boolean }>;
  [key: string]: unknown;
};
type Rule = {
  id: string;
  owner_clerk_id: string;
  config: Config;
  version: number;
  state: string;
  activation: Record<string, any> | null;
  last_run_at: Date | null;
};
@Injectable()
export class StatuteMonitorService {
  constructor(readonly research: ResearchService) {}
  async get(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, id: string, lock = false) {
    const rows = await tx.$queryRawUnsafe<Rule[]>(
      `SELECT * FROM intel_legiwatch_statute_rule WHERE tenant_id=$1 AND owner_clerk_id=$2 AND id=$3 ${lock ? 'FOR UPDATE' : ''}`,
      ctx.tenantId,
      ctx.clerkUserId,
      id,
    );
    if (!rows[0]) throw new NotFoundException('STATUTE_RULE_NOT_FOUND');
    return rows[0];
  }
  async access(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    rule: Rule,
    write = false,
  ) {
    for (const id of rule.config.folderIds) await this.research.keywords.folder(tx, ctx, id, write);
  }
  async list(ctx: WorkspaceTenantContext) {
    await this.research.authorize(ctx);
    return this.research.keywords.reports.folders.withActor(ctx, async (tx) => {
      const rows = await tx.$queryRaw<
        Rule[]
      >`SELECT * FROM intel_legiwatch_statute_rule WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} ORDER BY created_at,id LIMIT 100`;
      const allowed = [];
      for (const row of rows) {
        try {
          await this.access(tx, ctx, row);
          allowed.push(row);
        } catch {
          /* Withdrawn private scopes are not listed. */
        }
      }
      return allowed;
    });
  }
  async configure(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    await this.research.authorize(ctx);
    const b = object(input),
      c = object(b.config);
    const strings = (value: unknown, max: number) => {
      if (
        !Array.isArray(value) ||
        value.length > max ||
        value.some((v) => typeof v !== 'string' || !v || v.length > 180)
      )
        throw new BadRequestException('BOUNDED_EXPLICIT_MONITOR_SCOPE_REQUIRED');
      return [...new Set(value as string[])].sort();
    };
    const folderIds = strings(c.folderIds, 35),
      billIds = strings(c.billIds, 30);
    if (
      c.jurisdiction !== 'FL' ||
      typeof c.sessionKey !== 'string' ||
      !c.sessionKey ||
      c.sessionKey.length > 60 ||
      !['manual', 'hourly', 'daily'].includes(String(c.cadence)) ||
      typeof c.descendants !== 'boolean' ||
      !Array.isArray(c.recipients) ||
      c.recipients.length > 50
    )
      throw new BadRequestException('EXPLICIT_MONITOR_CONFIGURATION_REQUIRED');
    return this.research.keywords.reports.folders.withActor(ctx, async (tx) => {
      const old = await this.get(tx, ctx, id, true);
      if (old.version !== checkedVersion(b.expectedVersion))
        throw new ConflictException('RULE_CHANGED_RELOAD');
      for (const folderId of folderIds)
        await this.research.keywords.folder(tx, ctx, folderId, true);
      const recipients: Config['recipients'] = [];
      for (const value of c.recipients as unknown[]) {
        const r = object(value);
        if (
          typeof r.userId !== 'string' ||
          typeof r.email !== 'boolean' ||
          typeof r.inApp !== 'boolean' ||
          !(await this.research.keywords.reports.folders.source.activeMember(
            ctx.tenantId,
            r.userId,
            tx,
          ))
        )
          throw new BadRequestException('EXACT_CURRENT_STAFF_MAPPING_REQUIRED');
        recipients.push({ userId: r.userId, email: r.email, inApp: r.inApp });
      }
      const config = {
        ...old.config,
        kind: 'statute_reference',
        folderIds,
        billIds,
        jurisdiction: 'FL',
        sessionKey: c.sessionKey,
        descendants: c.descendants,
        cadence: c.cadence,
        recipients,
        matchActive: false,
        deliveryActive: false,
        internalFollowupActive: false,
      };
      await tx.$executeRaw`UPDATE intel_legiwatch_statute_rule SET config=${JSON.stringify(config)}::jsonb,version=version+1,state='needs_review',activation=NULL WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      return this.get(tx, ctx, id);
    });
  }
  async plan(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, rule: Rule) {
    await this.access(tx, ctx, rule);
    const c = rule.config,
      gaps: string[] = [];
    if (!c.folderIds.length) gaps.push('SELECT_FOLDER_TARGETS');
    if (!c.billIds?.length) gaps.push('SELECT_QUALIFIED_BILL_CORPUS');
    const targets = await tx.$queryRaw<
      Array<{
        folder_id: string;
        reference_id: string;
        version: number;
        edition: string | null;
        identity: LegalReference;
      }>
    >`SELECT m.folder_id,m.reference_id,m.version,m.edition,r.identity FROM intel_legiwatch_legal_membership m JOIN legal_reference r ON r.id=m.reference_id WHERE m.tenant_id=${ctx.tenantId} AND m.folder_id=ANY(${c.folderIds}::text[]) AND NOT m.removed ORDER BY m.folder_id,m.reference_id LIMIT 501`;
    if (targets.length > 500) gaps.push('TARGET_LIMIT_REACHED');
    if (!targets.length) gaps.push('NO_RESOLVED_TRACKED_STATUTES');
    if (targets.some((t) => !t.edition)) gaps.push('REVIEW_TARGET_EDITION');
    if (targets.some((t) => t.identity.kind === 'chapter') && !c.descendants)
      gaps.push('REVIEW_CHAPTER_DESCENDANT_POLICY');
    const documents = await tx.$queryRaw<
      Array<{ value: string }>
    >`SELECT md5(coalesce(string_agg(document_id||revision_hash||is_current::text,'|' ORDER BY document_id COLLATE "C"),'')) AS value FROM legiwatch_research_document_source WHERE jurisdiction=${c.jurisdiction ?? 'FL'} AND session_key=${c.sessionKey ?? ''} AND bill_id=ANY(${c.billIds ?? []}::text[])`;
    const inventories = await tx.$queryRaw<
      Array<{ value: string }>
    >`SELECT md5(coalesce(string_agg(id||coalesce(legiscan_change_hash,'')||coalesce(report_source_facts->'documentInventory','{}'::jsonb)::text,'|' ORDER BY id COLLATE "C"),'')) AS value FROM state_bill WHERE state=${c.jurisdiction ?? 'FL'} AND session_key=${c.sessionKey ?? ''} AND id=ANY(${c.billIds ?? []}::text[])`;
    const [receipt] = await tx.$queryRaw<
      Array<{ id: string; manifest: Record<string, any> }>
    >`SELECT id,manifest FROM legal_source_receipt WHERE source='fl-legal-pilot' AND scope->>'jurisdiction'=${c.jurisdiction ?? 'FL'} AND scope->>'sessionKey'=${c.sessionKey ?? ''} AND scope->'billIds'=${JSON.stringify(c.billIds ?? [])}::jsonb ORDER BY observed_at DESC LIMIT 1`;
    if (
      !receipt?.manifest.billDocumentCorpusComplete ||
      receipt.manifest.sourceFingerprint !== documents[0]?.value ||
      receipt.manifest.inventoryFingerprint !== inventories[0]?.value
    )
      gaps.push('SOURCE_DOCUMENT_INVENTORY_NOT_QUALIFIED');
    const [quality] = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM legal_source_receipt WHERE source='fl-citation-qualification' AND scope->>'jurisdiction'='FL' AND complete AND manifest->>'parserVersion'='fl-citation-v3' AND jsonb_typeof(manifest->'reviewedOccurrences')='number' AND manifest->'reviewedOccurrences'>='60'::jsonb AND jsonb_typeof(manifest->'reviewedRuleRecords')='number' AND manifest->'reviewedRuleRecords'>='20'::jsonb AND manifest->>'humanReviewed'='true' ORDER BY observed_at DESC LIMIT 1`;
    if (!quality) gaps.push('HELD_OUT_HUMAN_REVIEW_REQUIRED');
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        identity: LegalReference;
        bill_id: string;
        document_id: string;
        document_revision: string;
        quote: string;
        locator: string;
        relation: string;
        observed_at: Date;
        content_hash: string | null;
      }>
    >`SELECT o.*,r.identity,d.content_hash FROM legislative_legal_occurrence o JOIN legal_reference r ON r.id=o.reference_id JOIN legiwatch_research_document_source d ON d.document_id=o.document_id AND d.revision_hash=o.document_revision AND d.is_current WHERE o.jurisdiction=${c.jurisdiction ?? 'FL'} AND o.session_key=${c.sessionKey ?? ''} AND o.bill_id=ANY(${c.billIds ?? []}::text[]) AND o.parser_version='fl-citation-v3' ORDER BY o.id LIMIT 1001`;
    if (rows.length > 1000) gaps.push('OCCURRENCE_LIMIT_REACHED');
    const matches = rows.slice(0, 1000).flatMap((o) => {
      const memberships = targets.filter((t) =>
        legalTargetMatches(t.identity, o.identity, c.descendants),
      );
      return memberships.length ? [{ ...o, memberships }] : [];
    });
    const targetHash = hash(targets),
      previewHash = hash({
        version: rule.version,
        config: c,
        targets,
        matches,
        source: documents[0]?.value,
        inventory: inventories[0]?.value,
        receipt: receipt?.id,
        quality: quality?.id,
        gaps,
      });
    return {
      ruleId: rule.id,
      version: rule.version,
      targets,
      matches,
      gaps,
      targetHash,
      previewHash,
      coverage: {
        complete: !gaps.length,
        receiptId: receipt?.id ?? null,
        qualificationId: quality?.id ?? null,
      },
      deliveryActive: false,
    };
  }
  async preview(ctx: WorkspaceTenantContext, id: string) {
    await this.research.authorize(ctx);
    return this.research.keywords.reports.folders.withActor(ctx, async (tx) =>
      this.plan(tx, ctx, await this.get(tx, ctx, id)),
    );
  }
  async activation(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    await this.research.authorize(ctx);
    const b = object(input);
    return this.research.keywords.reports.folders.withActor(ctx, async (tx) => {
      const rule = await this.get(tx, ctx, id, true);
      if (rule.version !== checkedVersion(b.expectedVersion))
        throw new ConflictException('RULE_CHANGED_RELOAD');
      await this.access(tx, ctx, rule, true);
      if (b.enabled === false) {
        await tx.$executeRaw`UPDATE intel_legiwatch_statute_rule SET state='paused',activation=NULL WHERE tenant_id=${ctx.tenantId} AND id=${id}`;
        return { state: 'paused' };
      }
      if (b.enabled !== true || b.baseline !== 'from_now')
        throw new BadRequestException('EXPLICIT_FROM_NOW_ACTIVATION_REQUIRED');
      const preview = await this.plan(tx, ctx, rule);
      if (preview.previewHash !== b.previewHash || preview.gaps.length)
        throw new ConflictException({ code: 'MONITOR_REVIEW_REQUIRED', gaps: preview.gaps });
      const activation = {
        at: new Date().toISOString(),
        version: rule.version,
        targetHash: preview.targetHash,
        previewHash: preview.previewHash,
      };
      for (const match of preview.matches)
        await this.record(tx, ctx, rule, match, true, activation.at);
      await tx.$executeRaw`UPDATE intel_legiwatch_statute_rule SET state='active',activation=${JSON.stringify(activation)}::jsonb,last_run_at=now() WHERE tenant_id=${ctx.tenantId} AND id=${id}`;
      return {
        state: 'active',
        baselineMatches: preview.matches.length,
        deliveryActive: false,
        internalFollowupActive: false,
      };
    });
  }
  async record(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    rule: Rule,
    match: Record<string, any>,
    baseline: boolean,
    activation: string,
  ) {
    const identity = hash([
      rule.id,
      rule.version,
      activation,
      match.bill_id,
      match.content_hash,
      match.locator,
      match.quote,
      match.memberships.map((m: any) => m.reference_id),
    ]);
    return tx.$executeRaw`INSERT INTO intel_legiwatch_statute_match(id,tenant_id,owner_clerk_id,rule_id,rule_version,baseline,payload) VALUES(${identity},${ctx.tenantId},${ctx.clerkUserId},${rule.id},${rule.version},${baseline},${JSON.stringify(match)}::jsonb) ON CONFLICT DO NOTHING`;
  }
  async scan(ctx: WorkspaceTenantContext, id: string) {
    await this.research.authorize(ctx);
    return this.research.keywords.reports.folders.withActor(ctx, async (tx) => {
      const rule = await this.get(tx, ctx, id, true);
      if (rule.state !== 'active' || !rule.activation)
        throw new ConflictException('MONITOR_NOT_ACTIVE');
      const preview = await this.plan(tx, ctx, rule);
      if (preview.gaps.length || preview.targetHash !== rule.activation.targetHash) {
        await tx.$executeRaw`UPDATE intel_legiwatch_statute_rule SET state='needs_review' WHERE tenant_id=${ctx.tenantId} AND id=${id}`;
        return {
          state: 'held',
          gaps: [
            ...preview.gaps,
            ...(preview.targetHash !== rule.activation.targetHash
              ? ['TARGET_MEMBERSHIP_CHANGED']
              : []),
          ],
        };
      }
      let added = 0;
      for (const match of preview.matches)
        added += await this.record(
          tx,
          ctx,
          rule,
          match,
          match.observed_at.toISOString() <= rule.activation.at,
          rule.activation.at,
        );
      await tx.$executeRaw`UPDATE intel_legiwatch_statute_rule SET last_run_at=now() WHERE tenant_id=${ctx.tenantId} AND id=${id}`;
      return { state: 'complete', added, delivery: 0, sourceManifest: preview.coverage.receiptId };
    });
  }
  async events(ctx: WorkspaceTenantContext, id: string) {
    await this.research.authorize(ctx);
    return this.research.keywords.reports.folders.withActor(ctx, async (tx) => {
      const rule = await this.get(tx, ctx, id);
      await this.access(tx, ctx, rule);
      return tx.$queryRaw`SELECT id,rule_version,baseline,payload,created_at FROM intel_legiwatch_statute_match WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND rule_id=${id} ORDER BY created_at DESC,id LIMIT 100`;
    });
  }
  async due(tenantId: string) {
    if (process.env.LEGIWATCH_STATUTE_MONITOR_ENABLED !== 'true')
      return { state: 'disabled', processed: 0 };
    const rules = await this.research.keywords.reports.folders.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Rule[]
        >`SELECT * FROM intel_legiwatch_statute_rule WHERE tenant_id=${tenantId} AND state='active' AND config->>'cadence' IN ('hourly','daily') AND (last_run_at IS NULL OR last_run_at<now()-CASE WHEN config->>'cadence'='daily' THEN interval '1 day' ELSE interval '1 hour' END) ORDER BY last_run_at NULLS FIRST,id LIMIT 10`,
    );
    const results = [];
    for (const rule of rules) {
      try {
        results.push({
          ruleId: rule.id,
          ...(await this.scan({ tenantId, clerkUserId: rule.owner_clerk_id, role: null }, rule.id)),
        });
      } catch {
        results.push({
          ruleId: rule.id,
          state: 'held',
          reason: 'CURRENT_OWNER_OR_SOURCE_ACCESS_REQUIRED',
        });
      }
    }
    return { processed: results.length, results };
  }
}
