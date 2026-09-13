import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { ReportService } from '../reports/report.service.js';
import { object, json } from '../reports/report-domain.js';
import { isFolderAdmin, hash } from '../folders/folder-tracker.service.js';
import {
  KeywordSourceRepository,
  keywordScope,
} from '../../sourcedata/keyword-source.repository.js';
import { compileKeywordQuery, evaluateKeywordDefinitions } from './keyword-query.js';
import {
  compileDefinitions,
  keywordConfig,
  queryReadiness,
  type KeywordRule,
  type KeywordConfig,
  type KeywordDefinition,
} from './keyword-domain.js';
export const KEYWORD_DISCOVERY_FEATURE = 'legiwatch_keyword_discovery_v1';
export const KEYWORD_AUTO_ADD_FEATURE = 'legiwatch_keyword_auto_add_v1';
export const KEYWORD_WORKFLOWS_FEATURE = 'legiwatch_internal_workflows_v1';
export const KEYWORD_DELIVERY_FEATURE = 'legiwatch_keyword_delivery_v1';
export const checkedVersion = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 0)
    throw new BadRequestException('EXPECTED_VERSION_REQUIRED');
  return Number(value);
};
export const requestKey = (value: unknown) => {
  if (typeof value !== 'string' || value.length < 8 || value.length > 180)
    throw new BadRequestException('REQUEST_KEY_REQUIRED');
  return value;
};
@Injectable()
export class KeywordRuleService {
  constructor(
    readonly reports: ReportService,
    readonly sources: KeywordSourceRepository,
  ) {}
  authorize(ctx: WorkspaceTenantContext) {
    return this.reports.authorize(ctx, KEYWORD_DISCOVERY_FEATURE);
  }
  async folder(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    id: string,
    write = false,
  ) {
    const folder = await this.reports.folders.folder(tx, ctx, id, write);
    if (folder.clientId) {
      const clients = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT c.id FROM clients c JOIN tenant_memberships m ON m.tenant_id=c.tenant_id AND m.status::text='active'
       JOIN users u ON u.id=m.user_id AND u.clerk_user_id=${ctx.clerkUserId}
       WHERE c.id=${folder.clientId}::uuid AND c.tenant_id=${ctx.tenantId}::uuid AND c.status::text<>'archived'
       AND (NOT c.memory_wall OR EXISTS(SELECT 1 FROM client_memory_access a WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=u.id))`;
      if (!clients.length) throw new NotFoundException('FOLDER_CLIENT_ACCESS_UNAVAILABLE');
    }
    return folder;
  }
  async get(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, id: string, lock = false) {
    const rows = await tx.$queryRawUnsafe<KeywordRule[]>(
      `SELECT * FROM intel_legiwatch_keyword_rule
      WHERE tenant_id=$1 AND owner_clerk_id=$2 AND id=$3 ${lock ? 'FOR UPDATE' : ''}`,
      ctx.tenantId,
      ctx.clerkUserId,
      id,
    );
    if (!rows[0]) throw new NotFoundException('KEYWORD_RULE_NOT_FOUND');
    return rows[0];
  }
  async list(ctx: WorkspaceTenantContext) {
    await this.authorize(ctx);
    return this.reports.folders.withActor(ctx, async (tx) => {
      const rows = await tx.$queryRaw<
        KeywordRule[]
      >`SELECT * FROM intel_legiwatch_keyword_rule WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} ORDER BY name,id LIMIT 201`;
      const allowed = [];
      for (const r of rows) {
        if (r.config.source?.kind === 'meri_suggestions') continue;
        try {
          for (const id of r.config.folderIds) await this.folder(tx, ctx, id);
          allowed.push(r);
        } catch {
          /* Withdrawn client scopes are not listed. */
        }
      }
      return allowed.map((r) => ({
        ...r,
        issues: queryReadiness(r.config),
        compiled: compileDefinitions(r.config.definitions),
      }));
    });
  }
  async save(ctx: WorkspaceTenantContext, body: unknown, id?: string) {
    await this.authorize(ctx);
    const b = object(body),
      config = keywordConfig(b.config),
      name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 200) throw new BadRequestException('RULE_NAME_REQUIRED');
    const expected = id ? checkedVersion(b.expectedVersion) : null;
    return this.reports.folders.withActor(ctx, async (tx) => {
      for (const folderId of config.folderIds) await this.folder(tx, ctx, folderId, true);
      if (id) {
        const old = await this.get(tx, ctx, id, true);
        if (old.config.source?.kind === 'meri_suggestions')
          throw new BadRequestException('SEMANTIC_SUGGESTIONS_CANNOT_BECOME_KEYWORD_RULES');
        if (old.version !== expected) throw new ConflictException('RULE_CHANGED_RELOAD');
        // Imported raw definitions are evidence, not a mutable display field.
        if (old.config.source && hash(old.config.definitions) !== hash(config.definitions))
          throw new ConflictException('IMPORTED_DEFINITIONS_REQUIRE_NEW_REPLACEMENT_RULE');
        config.source = old.config.source;
        config.recipients = old.config.recipients ?? [];
        await tx.$executeRaw`UPDATE intel_legiwatch_keyword_rule SET name=${name},config=${JSON.stringify(config)}::jsonb,version=version+1,state='needs_review',activation=NULL,updated_at=now()
          WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      } else {
        id = randomUUID();
        await tx.$executeRaw`INSERT INTO intel_legiwatch_keyword_rule(id,tenant_id,owner_clerk_id,name,config)
          VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${name},${JSON.stringify(config)}::jsonb)`;
      }
      return this.get(tx, ctx, id);
    });
  }
  async preview(ctx: WorkspaceTenantContext, body: unknown) {
    await this.authorize(ctx);
    const b = object(body),
      scope = keywordScope(b.scope);
    if (typeof b.raw !== 'string') throw new BadRequestException('RAW_QUERY_REQUIRED');
    const compiled = compileKeywordQuery(b.raw),
      boundary = await this.sources.boundary(scope);
    if (b.boundary && b.boundary !== boundary)
      throw new ConflictException('SOURCE_CHANGED_RESTART_PREVIEW');
    const page = await this.sources.page(scope, typeof b.cursor === 'string' ? b.cursor : null, 25);
    if ((await this.sources.boundary(scope)) !== boundary)
      throw new ConflictException('SOURCE_CHANGED_RESTART_PREVIEW');
    return {
      compiled,
      scope,
      boundary,
      next: page.next,
      scanned: page.rows.length,
      rows: page.rows.map((r) => ({
        bill: r.bill,
        coverage: r.coverage,
        fingerprint: r.fingerprint,
        documents: r.documents.map(({ text, ...d }) => ({
          ...d,
          evaluation: evaluateKeywordDefinitions(
            [{ id: 'preview', compiled }],
            text,
            d.complete,
            'any-v1',
          ),
        })),
      })),
      effects: [],
    };
  }
  async reviewMappings(ctx: WorkspaceTenantContext, id: string, body: unknown) {
    await this.authorize(ctx);
    const b = object(body);
    if (!isFolderAdmin(ctx) || b.reviewedOwnerId !== ctx.clerkUserId || b.ownerReviewed !== true)
      throw new ForbiddenException('EXPLICIT_CURRENT_OWNER_REVIEW_REQUIRED');
    return this.reports.folders.withActor(ctx, async (tx) => {
      const rule = await this.get(tx, ctx, id, true);
      if (rule.version !== checkedVersion(b.expectedVersion))
        throw new ConflictException('RULE_CHANGED_RELOAD');
      let recipients: NonNullable<KeywordConfig['recipients']> = [];
      if (rule.config.source) {
        const source = rule.config.source;
        const staged = await tx.legiWatchStagedConfiguration.findFirst({
          where: { tenantId: ctx.tenantId, id: String(source.stagedId) },
        });
        if (
          !staged ||
          staged.version !== source.sourceVersion ||
          hash(staged.payload) !== source.sourceHash
        )
          throw new ConflictException('STAGED_SOURCE_CHANGED');
        const channels = await tx.legiWatchStagedConfiguration.findMany({
          where: {
            tenantId: ctx.tenantId,
            sourceAccount: String(source.sourceAccount),
            kind: 'alert_channel',
          },
        });
        const capture = staged.sourceId.slice(0, staged.sourceId.lastIndexOf(':')),
          auditKey = object(staged.payload).audit_key,
          mapping = object(b.userMappings);
        for (const c of channels.filter(
          (c) => c.sourceId.startsWith(capture + ':') && object(c.payload).alert_key === auditKey,
        )) {
          const p = object(c.payload);
          if (p.email_selected !== true && p.notification_selected !== true) continue;
          const sourceUserId = String(p.user_id),
            userId = mapping[sourceUserId];
          if (
            typeof userId !== 'string' ||
            !(await this.reports.folders.source.activeMember(ctx.tenantId, userId, tx))
          )
            throw new ConflictException('EXACT_ACTIVE_STAFF_MAPPING_REQUIRED');
          recipients.push({
            sourceUserId,
            userId,
            email: p.email_selected === true,
            inApp: p.notification_selected === true,
          });
        }
      } else {
        if (!Array.isArray(b.recipients) || b.recipients.length > 50)
          throw new BadRequestException('BOUNDED_STAFF_SELECTION_REQUIRED');
        for (const value of b.recipients) {
          const x = object(value);
          if (
            typeof x.userId !== 'string' ||
            typeof x.email !== 'boolean' ||
            typeof x.inApp !== 'boolean' ||
            !(await this.reports.folders.source.activeMember(ctx.tenantId, x.userId, tx))
          )
            throw new BadRequestException('CURRENT_STAFF_REQUIRED');
          recipients.push({ userId: x.userId, email: x.email, inApp: x.inApp });
        }
      }
      if (new Set(recipients.map((r) => r.userId)).size !== recipients.length)
        throw new BadRequestException('DUPLICATE_STAFF_MAPPING_REQUIRES_REVIEW');
      const config = {
        ...rule.config,
        recipients,
        deliveryEnabled: false,
        source: rule.config.source
          ? {
              ...rule.config.source,
              ownerMapping: 'reviewed',
              recipientMapping: 'reviewed',
              reviewedBy: ctx.clerkUserId,
              reviewedAt: new Date().toISOString(),
            }
          : null,
      };
      await tx.$executeRaw`UPDATE intel_legiwatch_keyword_rule SET config=${JSON.stringify(config)}::jsonb,version=version+1,state='needs_review',activation=NULL,updated_at=now()
       WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
      return this.get(tx, ctx, id);
    });
  }
  async staged(ctx: WorkspaceTenantContext, sourceAccount: string) {
    await this.authorize(ctx);
    if (!isFolderAdmin(ctx)) throw new ForbiddenException('IMPORT_REVIEW_REQUIRES_ADMIN');
    return this.reports.folders.withActor(ctx, async (tx) => {
      const rows = await tx.legiWatchStagedConfiguration.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount,
          kind: { in: ['bill_keyword', 'alert', 'alert_target', 'alert_channel'] },
        },
        orderBy: [{ kind: 'asc' }, { sourceId: 'asc' }],
        take: 3001,
      });
      if (rows.length > 3000) throw new BadRequestException('NARROW_SOURCE_CAPTURE');
      const definitions = rows
        .filter((r) => r.kind === 'bill_keyword')
        .map((r) => ({
          id: r.id,
          sourceId: r.sourceId,
          version: r.version,
          sourceHash: hash(r.payload),
          raw: object(r.payload),
          state: r.state,
          compiled:
            typeof object(r.payload).exactKeyword === 'string'
              ? compileKeywordQuery(object(r.payload).exactKeyword as string)
              : null,
        }));
      const rules = rows.filter(
        (r) => r.kind === 'alert' && object(r.payload).family === 'Bill Keyword Alert',
      );
      const promotions = await tx.legiWatchPromotion.findMany({
        where: { tenantId: ctx.tenantId, sourceAccount, stagedId: { in: rules.map((r) => r.id) } },
      });
      return {
        sourceAccount,
        actorId: ctx.clerkUserId,
        currentStaff: await tx.$queryRaw<
          Array<{ userId: string; email: string }>
        >`SELECT u.clerk_user_id AS "userId",u.email FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id=${ctx.tenantId}::uuid AND m.status::text='active' ORDER BY u.email`,
        definitions,
        rules: rules.map((r) => ({
          ...r,
          sourceHash: hash(r.payload),
          promotion: promotions.find((p) => p.stagedId === r.id) ?? null,
        })),
        targets: rows.filter((r) => r.kind === 'alert_target'),
        channels: rows.filter((r) => r.kind === 'alert_channel'),
        counts: { definitions: definitions.length, rules: rules.length },
      };
    });
  }
  async promote(ctx: WorkspaceTenantContext, stagedId: string, body: unknown) {
    await this.authorize(ctx);
    if (!isFolderAdmin(ctx)) throw new ForbiddenException('RULE_PROMOTION_REQUIRES_ADMIN');
    const b = object(body);
    return this.reports.folders.withActor(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_staged_configuration WHERE tenant_id=${ctx.tenantId} AND id=${stagedId} FOR UPDATE`;
      const staged = await tx.legiWatchStagedConfiguration.findFirst({
        where: { tenantId: ctx.tenantId, id: stagedId, kind: 'alert', state: { not: 'excluded' } },
      });
      if (!staged || object(staged.payload).family !== 'Bill Keyword Alert')
        throw new NotFoundException('STAGED_KEYWORD_RULE_NOT_FOUND');
      if (
        staged.version !== checkedVersion(b.expectedVersion) ||
        hash(staged.payload) !== b.sourceHash
      )
        throw new ConflictException('STAGED_SOURCE_CHANGED');
      const prior = await tx.legiWatchPromotion.findFirst({
        where: { tenantId: ctx.tenantId, stagedId },
      });
      if (prior) return { id: prior.targetId, state: 'already_promoted' };
      const raw = object(staged.payload),
        auditKey = String(raw.audit_key);
      if (!/^alert-(29|3[0-8])$/.test(auditKey))
        throw new BadRequestException('KEYWORD_SOURCE_ID_REQUIRES_REVIEW');
      const others = await tx.legiWatchPromotion.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: staged.sourceAccount,
          kind: 'alert',
          sourceId: { endsWith: `:${auditKey}` },
        },
      });
      if (others.length) {
        const existing = await this.get(tx, ctx, String(b.existingRuleId ?? ''), true);
        if (!others.some((p) => p.targetId === existing.id))
          throw new ConflictException('RECONCILE_NEW_CAPTURE_WITH_EXISTING_RULE');
        await tx.legiWatchPromotion.create({
          data: {
            tenantId: ctx.tenantId,
            stagedId,
            sourceAccount: staged.sourceAccount,
            sourceId: staged.sourceId,
            sourceVersion: staged.version,
            sourceHash: hash(staged.payload),
            kind: 'alert',
            targetId: existing.id,
            reviewedBy: ctx.clerkUserId,
          },
        });
        return { id: existing.id, state: 'linked_existing_edits_preserved' };
      }
      // Explicit source selections, validated against staged definition IDs. No
      // query, target folder or owner is inferred from the alert's name.
      const groups = Array.isArray(raw.selected_targets) ? raw.selected_targets.map(object) : [];
      const selections = groups
        .filter((g) => ['keyword', 'bill_keyword'].includes(String(g.type)))
        .flatMap((g) =>
          Array.isArray(g.selected) ? g.selected.map((s) => String(object(s).id)) : [],
        );
      if (!groups.some((g) => ['keyword', 'bill_keyword'].includes(String(g.type))))
        throw new BadRequestException('CAPTURED_KEYWORD_SELECTION_SCHEMA_REQUIRES_REVIEW');
      const stagedDefs = await tx.legiWatchStagedConfiguration.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: staged.sourceAccount,
          kind: 'bill_keyword',
        },
      });
      const definitions: KeywordDefinition[] = [];
      for (const sourceId of selections) {
        const matches = stagedDefs.filter((d) => d.sourceId === sourceId && d.state !== 'excluded');
        if (matches.length !== 1 || typeof object(matches[0]!.payload).exactKeyword !== 'string')
          throw new ConflictException('EXACT_SELECTED_DEFINITION_MAPPING_REQUIRED');
        definitions.push({
          id: matches[0]!.id,
          raw: object(matches[0]!.payload).exactKeyword as string,
        });
      }
      const frequency = Array.isArray(raw.frequency) ? raw.frequency : [];
      if (frequency.length !== 1 || !['Real time', 'End of day'].includes(String(frequency[0])))
        throw new BadRequestException('CAPTURED_CADENCE_REQUIRES_REVIEW');
      const config: KeywordConfig = {
        scope: keywordScope(b.scope),
        folderIds: [],
        definitions,
        aggregation: 'unqualified',
        semanticsReviewed: false,
        mode: 'suggest',
        cadence: frequency[0] === 'Real time' ? 'realtime' : 'end_of_day',
        timezone: null,
        localMinutes: null,
        source: {
          stagedId,
          sourceAccount: staged.sourceAccount,
          sourceId: staged.sourceId,
          sourceVersion: staged.version,
          sourceHash: hash(staged.payload),
          selectedSourceIds: selections,
          ownerMapping: 'requires_review',
          recipientMapping: 'requires_review',
        },
      };
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO intel_legiwatch_keyword_rule(id,tenant_id,owner_clerk_id,name,config) VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${String(raw.name ?? 'Imported keyword rule').slice(0, 200)},${JSON.stringify(config)}::jsonb)`;
      await tx.legiWatchPromotion.create({
        data: {
          tenantId: ctx.tenantId,
          stagedId,
          sourceAccount: staged.sourceAccount,
          sourceId: staged.sourceId,
          sourceVersion: staged.version,
          sourceHash: hash(staged.payload),
          kind: 'alert',
          targetId: id,
          reviewedBy: ctx.clerkUserId,
        },
      });
      return this.get(tx, ctx, id);
    });
  }
}
