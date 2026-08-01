import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext, TenantRole } from '@capiro/shared';
import {
  CAPIRO_APPROVED_GENERIC_POLICY_PACK,
  GOVERNMENT_AFFAIRS_JURISDICTIONS,
  canPublishPolicyPack,
  evaluatePolicyPack,
  policyDecisionHash,
  policyPackRulesHash,
  policyPackRulesMatchHash,
  policySelectionContextHash,
  proposalPolicyBinding,
  selectPolicyPack,
  simulatePolicyPack,
  validatePolicyPack,
  type CompliancePolicyPack,
  type CompliancePolicyPackRule,
  type GovernmentAffairsJurisdiction,
  type PolicyAuthority,
  type PolicyPackDecision,
  type PolicySelectionContext,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';

export type PersistedPolicyPackMode = 'off' | 'shadow' | 'enforce';
export type ActionPolicySource = 'static' | 'persisted' | 'fail_closed';

export interface ResolvedActionPolicyContext extends PolicySelectionContext {
  effectiveUserId: string;
  effectiveAt: Date;
}

export interface AuthoritativePolicyDecision extends PolicyPackDecision {
  mode: PersistedPolicyPackMode;
  source: ActionPolicySource;
  verified: boolean;
  bindable: true;
  policyPackRowId: string | null;
  binding: string;
  contextHash: string;
  decisionHash: string;
  context: ResolvedActionPolicyContext;
  shadowDecision?: {
    source: 'persisted' | 'unavailable';
    outcome?: PolicyPackDecision['outcome'];
    binding?: string;
    reasonCode?: string;
  };
}

export interface PolicyDecisionAudit {
  tool: string;
  channel: ResolvedActionPolicyContext['channel'];
  recipientType?: ResolvedActionPolicyContext['recipientType'];
  actorUserId: string;
  actorRole: string;
  clientId?: string;
  jurisdiction: string;
  meriActionProposalId?: string;
}

export interface PolicyPackDraftInput {
  packKey: string;
  version: string;
  jurisdiction: GovernmentAffairsJurisdiction | 'all';
  legalReviewStatus?: 'not_required_product_policy' | 'pending' | 'approved' | 'rejected';
  authority: PolicyAuthority;
  effectiveFrom: string;
  effectiveUntil?: string | null;
  fourEyesRequired?: boolean;
  rules: CompliancePolicyPackRule[];
  fallback?: 'PASS' | 'WARN' | 'BLOCK';
  nonProduction?: boolean;
}

export interface PolicyPackRevisionInput {
  jurisdiction?: GovernmentAffairsJurisdiction | 'all';
  legalReviewStatus?: 'not_required_product_policy' | 'pending' | 'approved' | 'rejected';
  authority?: PolicyAuthority;
  effectiveFrom?: string;
  effectiveUntil?: string | null;
  fourEyesRequired?: boolean;
  rules?: CompliancePolicyPackRule[];
  fallback?: 'PASS' | 'WARN' | 'BLOCK';
  nonProduction?: boolean;
}

export interface PolicySimulationResult {
  simulated: true;
  bindable: false;
  binding: null;
  decisionHash: null;
  outcome: PolicyPackDecision['outcome'];
  packKey: string;
  packVersion: string;
  ruleId: string | null;
  code?: string;
  tier?: string;
  reason: string;
  contextHash: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ROLES = new Set(['user_admin', 'capiro_admin']);

export function resolvePersistedPolicyPackMode(raw: string | undefined): PersistedPolicyPackMode {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return value === 'enforce' ? 'enforce' : value === 'shadow' ? 'shadow' : 'off';
}

export function persistedPolicyPacksEnforced(
  raw: string | undefined = process.env.MERI_POLICY_PACK_SOURCE,
): boolean {
  return resolvePersistedPolicyPackMode(raw) === 'enforce';
}

export function policyActorRole(role: string): TenantRole {
  return role as TenantRole;
}

export function policyChannelForTool(
  tool: string,
): 'internal' | 'email' | 'document' | 'filing' | 'automation' | 'crm' {
  if (/^(?:send_email|reply_email)$/.test(tool)) return 'email';
  if (/^(?:schedule_task|cancel_scheduled_task)$/.test(tool)) return 'automation';
  if (/^(?:create_client|update_client_profile|create_task|update_task)$/.test(tool)) return 'crm';
  if (/^(?:submit_filing|file_comment|submit_comment)$/.test(tool)) return 'filing';
  if (
    /^(?:draft_policy_memo|create_meeting_brief|create_word|create_excel|create_powerpoint)$/.test(
      tool,
    )
  ) {
    return 'document';
  }
  return 'internal';
}

function emailRecipients(input: Record<string, unknown>): string[] {
  const raw = input.to ?? input.recipients ?? input.recipient;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return [];
}

export function policyRecipientTypeForTool(
  tool: string,
  input: Record<string, unknown> = {},
): 'internal' | 'government' | 'client' | 'public' | 'unknown' {
  if (/^(?:save_note|save_memory)$/.test(tool)) return 'internal';
  if (!/^(?:send_email|reply_email)$/.test(tool)) return 'unknown';
  const recipients = emailRecipients(input).map((value) => value.trim().toLowerCase());
  if (!recipients.length) return 'unknown';
  if (recipients.every((value) => /@[^@]+\.(?:gov|mil)$/.test(value))) return 'government';
  return 'unknown';
}

function policyJurisdictionForAction(
  tool: string,
  input: Record<string, unknown>,
): GovernmentAffairsJurisdiction {
  const explicit = typeof input.jurisdiction === 'string' ? input.jurisdiction.toLowerCase() : '';
  if ((GOVERNMENT_AFFAIRS_JURISDICTIONS as readonly string[]).includes(explicit)) {
    return explicit as GovernmentAffairsJurisdiction;
  }
  const keys = Object.keys(input).join(' ').toLowerCase();
  const material = `${tool} ${keys}`;
  if (/state|legiscan|statebill/.test(material) || typeof input.stateCode === 'string')
    return 'state';
  if (/local|county|city|municipal|district_nexus/.test(material)) return 'local';
  if (/grant|nofo|assistance_listing/.test(material)) return 'grants';
  if (/sam_|sam\.|procurement|contract|award|solicitation|rfp/.test(material)) return 'procurement';
  if (/regulat|docket|rulemaking|federal_register/.test(material)) return 'regulatory';
  return 'federal';
}

export function resolveActionPolicyContext(
  ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'role'>,
  tool: string,
  input: Record<string, unknown>,
  at: Date = new Date(),
  overrides: { jurisdiction?: GovernmentAffairsJurisdiction; clientId?: string } = {},
): ResolvedActionPolicyContext {
  const candidateActor = (ctx as unknown as { actorUserId?: unknown }).actorUserId;
  const actorUserId =
    typeof candidateActor === 'string' && UUID_RE.test(candidateActor)
      ? candidateActor
      : ctx.userId;
  const rawClientId =
    overrides.clientId ?? (typeof input.clientId === 'string' ? input.clientId : undefined);
  const clientId = rawClientId && UUID_RE.test(rawClientId) ? rawClientId : undefined;
  const jurisdiction = overrides.jurisdiction ?? policyJurisdictionForAction(tool, input);
  const channel = policyChannelForTool(tool);
  const recipientType = policyRecipientTypeForTool(tool, input);
  return {
    tenantId: ctx.tenantId,
    actorUserId,
    effectiveUserId: ctx.userId,
    actorRole: policyActorRole(String(ctx.role ?? 'standard_user')),
    jurisdiction,
    ...(clientId ? { clientId } : {}),
    tool,
    channel,
    recipientType,
    at,
    effectiveAt: at,
    contextFlags: { impersonating: actorUserId !== ctx.userId },
  };
}

interface PolicyPackRow {
  id: string;
  tenantId: string;
  packKey: string;
  version: string;
  jurisdiction: string;
  status: string;
  legalReviewStatus: string;
  authorityJson: unknown;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  ownerUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: Date | null;
  publishedByUserId: string | null;
  publishedAt: Date | null;
  fourEyesRequired: boolean;
  rulesJson: unknown;
  fallbackOutcome: string;
  nonProduction: boolean;
  rulesHash: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface LoadedPublishedPacks {
  rowsSeen: number;
  rejected: number;
  packs: Array<{ rowId: string; pack: CompliancePolicyPack }>;
}

@Injectable()
export class MeriPolicyPackService {
  private readonly logger = new Logger(MeriPolicyPackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async decideForAction(
    ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'role'>,
    tool: string,
    input: Record<string, unknown>,
    at: Date = new Date(),
  ): Promise<AuthoritativePolicyDecision> {
    const context = resolveActionPolicyContext(ctx, tool, input, at);
    return this.decide(ctx.tenantId, context);
  }

  /**
   * One server-owned answer for every write. Off/shadow use the reviewed static
   * product baseline; enforce requires a verified tenant-published row and BLOCKS
   * when it is missing, invalid, tampered, or unavailable.
   */
  async decide(
    tenantId: string,
    context: PolicySelectionContext | ResolvedActionPolicyContext,
    _audit?: PolicyDecisionAudit,
  ): Promise<AuthoritativePolicyDecision> {
    const mode = resolvePersistedPolicyPackMode(process.env.MERI_POLICY_PACK_SOURCE);
    const resolved = this.ensureResolvedContext(context);
    const staticDecision = evaluatePolicyPack(CAPIRO_APPROVED_GENERIC_POLICY_PACK, resolved);
    if (mode === 'off') return this.envelope(staticDecision, resolved, 'off', 'static', null, true);

    try {
      const loaded = await this.loadPublishedPacks(tenantId);
      const selected = selectPolicyPack(
        loaded.packs.map((entry) => entry.pack),
        resolved,
      );
      const selectedEntry = selected
        ? loaded.packs.find(
            (entry) => entry.pack.id === selected.id && entry.pack.version === selected.version,
          )
        : undefined;

      if (mode === 'shadow') {
        const authoritative = this.envelope(
          staticDecision,
          resolved,
          'shadow',
          'static',
          null,
          true,
        );
        if (!selected || !selectedEntry) {
          authoritative.shadowDecision = {
            source: 'unavailable',
            reasonCode: loaded.rowsSeen > 0 ? 'policy_pack_integrity' : 'policy_pack_missing',
          };
          return authoritative;
        }
        const shadow = evaluatePolicyPack(selected, resolved);
        authoritative.shadowDecision = {
          source: 'persisted',
          outcome: shadow.outcome,
          binding: proposalPolicyBinding(shadow),
        };
        return authoritative;
      }

      if (!selected || !selectedEntry) {
        const code = loaded.rowsSeen > 0 ? 'policy_pack_integrity' : 'policy_pack_missing';
        return this.failClosed(
          resolved,
          code,
          loaded.rowsSeen > 0
            ? 'Published policy rows were present but none passed integrity and lifecycle validation.'
            : 'No verified published tenant policy pack is available.',
        );
      }
      return this.envelope(
        evaluatePolicyPack(selected, resolved),
        resolved,
        'enforce',
        'persisted',
        selectedEntry.rowId,
        true,
      );
    } catch (error) {
      this.logger.error(
        `[policy-pack] authoritative load failed closed for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (mode === 'shadow') {
        const decision = this.envelope(staticDecision, resolved, 'shadow', 'static', null, true);
        decision.shadowDecision = { source: 'unavailable', reasonCode: 'policy_pack_unavailable' };
        return decision;
      }
      return this.failClosed(
        resolved,
        'policy_pack_unavailable',
        'The tenant policy source could not be loaded or verified; the write is blocked.',
      );
    }
  }

  /** Mandatory, transaction-scoped selected-version audit. */
  async recordDecisionInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    decision: AuthoritativePolicyDecision,
    audit: PolicyDecisionAudit,
  ): Promise<void> {
    await (tx as unknown as PolicyPackTx).compliancePolicyDecision.create({
      data: {
        tenantId,
        policyPackId: decision.policyPackRowId,
        packKey: decision.packId,
        packVersion: decision.packVersion,
        ruleId: decision.ruleId,
        outcome: decision.outcome,
        code: decision.code ?? null,
        tier: decision.tier ?? null,
        simulated: false,
        binding: decision.binding.slice(0, 280),
        decisionHash: decision.decisionHash,
        contextHash: decision.contextHash,
        policySource: decision.source,
        policyMode: decision.mode,
        effectiveUserId: decision.context.effectiveUserId,
        effectiveAt: decision.context.effectiveAt,
        tool: audit.tool.slice(0, 80),
        channel: audit.channel,
        recipientType: audit.recipientType ?? null,
        actorUserId: audit.actorUserId,
        actorRole: audit.actorRole.slice(0, 32),
        clientId: audit.clientId ?? null,
        jurisdiction: audit.jurisdiction.slice(0, 32),
        meriActionProposalId: audit.meriActionProposalId ?? null,
        reason: decision.reason,
      },
    });
  }

  async listAdmin(ctx: TenantContext): Promise<Record<string, unknown>[]> {
    this.assertAdmin(ctx);
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      (tx as unknown as PolicyPackTx).compliancePolicyPack.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ packKey: 'asc' }, { createdAt: 'desc' }],
      }),
    );
    return rows.map((row) => this.publicRow(row));
  }

  async recentDecisions(ctx: TenantContext): Promise<unknown[]> {
    this.assertAdmin(ctx);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      (tx as unknown as PolicyPackTx).compliancePolicyDecision.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { decidedAt: 'desc' },
        take: 100,
      }),
    );
  }

  async events(ctx: TenantContext, packId: string): Promise<unknown[]> {
    this.assertAdmin(ctx);
    await this.requireRow(ctx.tenantId, packId);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      (tx as unknown as PolicyPackTx).compliancePolicyPackEvent.findMany({
        where: { tenantId: ctx.tenantId, policyPackId: packId },
        orderBy: { occurredAt: 'desc' },
      }),
    );
  }

  async seedBaseline(ctx: TenantContext): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const pack = CAPIRO_APPROVED_GENERIC_POLICY_PACK;
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      const existing = await db.compliancePolicyPack.findFirst({
        where: { tenantId: ctx.tenantId, packKey: pack.id, version: pack.version },
      });
      if (existing) return existing;
      const created = await db.compliancePolicyPack.create({
        data: approvedGenericPolicyPackSeed(ctx.tenantId, ctx.userId),
      });
      await this.appendEvent(
        db,
        ctx,
        created.id,
        null,
        'published',
        'create',
        'Installed the reviewed Capiro generic action-approval baseline.',
      );
      return created;
    });
    return this.publicRow(row);
  }

  async createDraft(
    ctx: TenantContext,
    input: PolicyPackDraftInput,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const pack = this.packFromDraft(ctx, input);
    const validation = validatePolicyPack(pack);
    if (!validation.valid) throw new BadRequestException(validation.errors.join(' '));
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      const created = await db.compliancePolicyPack.create({
        data: {
          tenantId: ctx.tenantId,
          packKey: pack.id,
          version: pack.version,
          jurisdiction: pack.jurisdiction,
          status: 'draft',
          legalReviewStatus: pack.legalReviewStatus,
          authorityJson: pack.authority,
          effectiveFrom: new Date(pack.effectiveFrom),
          effectiveUntil: pack.effectiveUntil ? new Date(pack.effectiveUntil) : null,
          ownerUserId: ctx.userId,
          fourEyesRequired: pack.fourEyesRequired,
          rulesJson: pack.rules,
          fallbackOutcome: pack.fallback,
          nonProduction: pack.nonProduction,
          rulesHash: policyPackRulesHash(pack),
        },
      });
      await this.appendEvent(
        db,
        ctx,
        created.id,
        null,
        'draft',
        'create',
        'Created policy-pack draft.',
      );
      return created;
    });
    return this.publicRow(row);
  }

  async reviseDraft(
    ctx: TenantContext,
    packId: string,
    patch: PolicyPackRevisionInput,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const current = await this.requireRow(ctx.tenantId, packId);
    if (current.status !== 'draft')
      throw new ConflictException('Only a draft may be revised in place.');
    const existing = this.toPack(current);
    if (!existing) throw new BadRequestException('The stored draft is malformed.');
    const next: CompliancePolicyPack = {
      ...existing,
      jurisdiction: patch.jurisdiction ?? existing.jurisdiction,
      legalReviewStatus: patch.legalReviewStatus ?? existing.legalReviewStatus,
      authority: patch.authority ?? existing.authority,
      effectiveFrom: patch.effectiveFrom ?? existing.effectiveFrom,
      ...(patch.effectiveUntil === undefined
        ? existing.effectiveUntil
          ? { effectiveUntil: existing.effectiveUntil }
          : {}
        : patch.effectiveUntil
          ? { effectiveUntil: patch.effectiveUntil }
          : { effectiveUntil: undefined }),
      fourEyesRequired: patch.fourEyesRequired ?? existing.fourEyesRequired,
      rules: patch.rules ?? existing.rules,
      fallback: patch.fallback ?? existing.fallback,
      nonProduction: patch.nonProduction ?? existing.nonProduction,
    };
    const validation = validatePolicyPack(next);
    if (!validation.valid) throw new BadRequestException(validation.errors.join(' '));
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      const updated = await db.compliancePolicyPack.update({
        where: { id: packId },
        data: {
          jurisdiction: next.jurisdiction,
          legalReviewStatus: next.legalReviewStatus,
          authorityJson: next.authority,
          effectiveFrom: new Date(next.effectiveFrom),
          effectiveUntil: next.effectiveUntil ? new Date(next.effectiveUntil) : null,
          fourEyesRequired: next.fourEyesRequired,
          rulesJson: next.rules,
          fallbackOutcome: next.fallback,
          nonProduction: next.nonProduction,
          rulesHash: policyPackRulesHash(next),
        },
      });
      await this.appendEvent(
        db,
        ctx,
        packId,
        'draft',
        'draft',
        'revise',
        'Revised policy-pack draft.',
      );
      return updated;
    });
    return this.publicRow(row);
  }

  async submitReview(
    ctx: TenantContext,
    packId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const current = await this.requireRow(ctx.tenantId, packId);
    if (current.status !== 'draft') throw new ConflictException('Only a draft may enter review.');
    const pack = this.toPack(current);
    if (!pack) throw new BadRequestException('The stored draft is malformed.');
    const validation = validatePolicyPack(pack);
    if (!validation.valid) throw new BadRequestException(validation.errors.join(' '));
    return this.transition(ctx, current, 'pending_review', 'submit_review', reason);
  }

  async review(
    ctx: TenantContext,
    packId: string,
    legalReviewStatus: 'not_required_product_policy' | 'approved',
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const current = await this.requireRow(ctx.tenantId, packId);
    if (current.status !== 'pending_review')
      throw new ConflictException('Pack is not pending review.');
    if (current.ownerUserId === ctx.userId)
      throw new ForbiddenException('The draft owner cannot review their own policy pack.');
    const toStatus = current.fourEyesRequired ? 'pending_review' : 'reviewed';
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      const updated = await db.compliancePolicyPack.update({
        where: { id: packId },
        data: {
          reviewedByUserId: ctx.userId,
          reviewedAt: new Date(),
          legalReviewStatus,
          status: toStatus,
        },
      });
      await this.appendEvent(db, ctx, packId, 'pending_review', toStatus, 'review', reason);
      return updated;
    });
    return this.publicRow(row);
  }

  async secondApprove(
    ctx: TenantContext,
    packId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const current = await this.requireRow(ctx.tenantId, packId);
    if (
      !current.fourEyesRequired ||
      current.status !== 'pending_review' ||
      !current.reviewedByUserId
    ) {
      throw new ConflictException('A completed first review is required before second approval.');
    }
    if (ctx.userId === current.ownerUserId || ctx.userId === current.reviewedByUserId) {
      throw new ForbiddenException(
        'The second approver must be independent of the owner and first reviewer.',
      );
    }
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      const updated = await db.compliancePolicyPack.update({
        where: { id: packId },
        data: {
          secondApprovedByUserId: ctx.userId,
          secondApprovedAt: new Date(),
          status: 'reviewed',
        },
      });
      await this.appendEvent(db, ctx, packId, 'pending_review', 'reviewed', 'approve', reason);
      return updated;
    });
    return this.publicRow(row);
  }

  async publish(
    ctx: TenantContext,
    packId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const current = await this.requireRow(ctx.tenantId, packId);
    const pack = this.toPack(current);
    if (!pack) throw new BadRequestException('The stored pack is malformed.');
    const allowed = canPublishPolicyPack(pack, {
      userId: ctx.userId,
      role: policyActorRole(String(ctx.role)),
    });
    if (!allowed.valid) throw new BadRequestException(allowed.errors.join(' '));
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      const live = await db.compliancePolicyPack.findMany({
        where: { tenantId: ctx.tenantId, packKey: current.packKey, status: 'published' },
      });
      for (const prior of live) {
        await db.compliancePolicyPack.update({
          where: { id: prior.id },
          data: { status: 'retired' },
        });
        await this.appendEvent(
          db,
          ctx,
          prior.id,
          'published',
          'retired',
          'retire',
          `Retired during publication of ${current.version}.`,
        );
      }
      const updated = await db.compliancePolicyPack.update({
        where: { id: packId },
        data: { status: 'published', publishedByUserId: ctx.userId, publishedAt: new Date() },
      });
      await this.appendEvent(db, ctx, packId, 'reviewed', 'published', 'publish', reason);
      return updated;
    });
    return this.publicRow(row);
  }

  async retire(
    ctx: TenantContext,
    packId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const current = await this.requireRow(ctx.tenantId, packId);
    if (current.status !== 'published')
      throw new ConflictException('Only a published pack may be retired.');
    return this.transition(ctx, current, 'retired', 'retire', reason);
  }

  async rollback(
    ctx: TenantContext,
    currentId: string,
    targetId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    this.assertAdmin(ctx);
    const current = await this.requireRow(ctx.tenantId, currentId);
    const target = await this.requireRow(ctx.tenantId, targetId);
    if (
      current.status !== 'published' ||
      target.status !== 'retired' ||
      current.packKey !== target.packKey
    ) {
      throw new ConflictException(
        'Rollback requires a live pack and a retired version of the same pack key.',
      );
    }
    if (target.nonProduction)
      throw new BadRequestException('Cannot roll back to a non-production pack.');
    const restored = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      await db.compliancePolicyPack.update({
        where: { id: currentId },
        data: { status: 'retired' },
      });
      await this.appendEvent(
        db,
        ctx,
        currentId,
        'published',
        'retired',
        'rollback',
        reason,
        targetId,
      );
      const row = await db.compliancePolicyPack.update({
        where: { id: targetId },
        data: { status: 'published', publishedByUserId: ctx.userId, publishedAt: new Date() },
      });
      await this.appendEvent(
        db,
        ctx,
        targetId,
        'retired',
        'published',
        'rollback',
        reason,
        currentId,
      );
      return row;
    });
    return this.publicRow(restored);
  }

  async simulateAdmin(
    ctx: TenantContext,
    packId: string,
    tool: string,
    input: Record<string, unknown>,
    overrides: { jurisdiction?: GovernmentAffairsJurisdiction; clientId?: string } = {},
  ): Promise<PolicySimulationResult> {
    this.assertAdmin(ctx);
    const row = await this.requireRow(ctx.tenantId, packId);
    const pack = this.toPack(row);
    if (!pack) throw new BadRequestException('The stored pack is malformed.');
    const context = resolveActionPolicyContext(ctx, tool, input, new Date(), overrides);
    const decision = simulatePolicyPack(pack, context);
    const contextHash = policySelectionContextHash(context);
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      await db.compliancePolicyDecision.create({
        data: {
          tenantId: ctx.tenantId,
          policyPackId: row.id,
          packKey: decision.packId,
          packVersion: decision.packVersion,
          ruleId: decision.ruleId,
          outcome: decision.outcome,
          code: decision.code ?? null,
          tier: decision.tier ?? null,
          simulated: true,
          binding: proposalPolicyBinding(decision).slice(0, 280),
          decisionHash: policyDecisionHash(decision, contextHash),
          contextHash,
          policySource: 'persisted',
          policyMode: resolvePersistedPolicyPackMode(process.env.MERI_POLICY_PACK_SOURCE),
          effectiveUserId: ctx.userId,
          effectiveAt: context.effectiveAt,
          tool,
          channel: context.channel,
          recipientType: context.recipientType ?? null,
          actorUserId: context.actorUserId,
          actorRole: String(context.actorRole),
          clientId: context.clientId ?? null,
          jurisdiction: context.jurisdiction,
          meriActionProposalId: null,
          reason: decision.reason,
        },
      });
      await this.appendEvent(
        db,
        ctx,
        row.id,
        row.status,
        row.status,
        'simulate',
        'Simulated policy decision; no action binding was created.',
      );
    });
    return {
      simulated: true,
      bindable: false,
      binding: null,
      decisionHash: null,
      outcome: decision.outcome,
      packKey: decision.packId,
      packVersion: decision.packVersion,
      ruleId: decision.ruleId,
      ...(decision.code ? { code: decision.code } : {}),
      ...(decision.tier ? { tier: decision.tier } : {}),
      reason: decision.reason,
      contextHash,
    };
  }

  /** Backward-compatible dry-run API; still never returns a bindable authority. */
  async simulate(
    tenantId: string,
    packId: string,
    context: PolicySelectionContext,
    audit: PolicyDecisionAudit,
  ): Promise<PolicySimulationResult | null> {
    const row = await this.requireRow(tenantId, packId, false);
    if (!row) return null;
    const pack = this.toPack(row);
    if (!pack) return null;
    const resolved = this.ensureResolvedContext(context);
    const decision = simulatePolicyPack(pack, resolved);
    const contextHash = policySelectionContextHash(resolved);
    await this.prisma.withTenant(tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      await db.compliancePolicyDecision.create({
        data: {
          tenantId,
          policyPackId: row.id,
          packKey: decision.packId,
          packVersion: decision.packVersion,
          ruleId: decision.ruleId,
          outcome: decision.outcome,
          code: decision.code ?? null,
          tier: decision.tier ?? null,
          simulated: true,
          binding: proposalPolicyBinding(decision),
          decisionHash: policyDecisionHash(decision, contextHash),
          contextHash,
          policySource: 'persisted',
          policyMode: resolvePersistedPolicyPackMode(process.env.MERI_POLICY_PACK_SOURCE),
          effectiveUserId: resolved.effectiveUserId,
          effectiveAt: resolved.effectiveAt,
          tool: audit.tool,
          channel: audit.channel,
          recipientType: audit.recipientType ?? null,
          actorUserId: audit.actorUserId,
          actorRole: audit.actorRole,
          clientId: audit.clientId ?? null,
          jurisdiction: audit.jurisdiction,
          meriActionProposalId: audit.meriActionProposalId ?? null,
          reason: decision.reason,
        },
      });
    });
    return {
      simulated: true,
      bindable: false,
      binding: null,
      decisionHash: null,
      outcome: decision.outcome,
      packKey: decision.packId,
      packVersion: decision.packVersion,
      ruleId: decision.ruleId,
      ...(decision.code ? { code: decision.code } : {}),
      ...(decision.tier ? { tier: decision.tier } : {}),
      reason: decision.reason,
      contextHash,
    };
  }

  private ensureResolvedContext(
    context: PolicySelectionContext | ResolvedActionPolicyContext,
  ): ResolvedActionPolicyContext {
    const effectiveAt = context.at instanceof Date ? context.at : new Date(context.at);
    const effectiveUserId =
      (context as ResolvedActionPolicyContext).effectiveUserId ?? context.actorUserId;
    return { ...context, effectiveUserId, effectiveAt, at: effectiveAt };
  }

  private envelope(
    decision: PolicyPackDecision,
    context: ResolvedActionPolicyContext,
    mode: PersistedPolicyPackMode,
    source: ActionPolicySource,
    policyPackRowId: string | null,
    verified: boolean,
  ): AuthoritativePolicyDecision {
    const contextHash = policySelectionContextHash(context);
    return {
      ...decision,
      mode,
      source,
      verified,
      bindable: true,
      policyPackRowId,
      binding: proposalPolicyBinding(decision),
      contextHash,
      decisionHash: policyDecisionHash(decision, contextHash),
      context,
    };
  }

  private failClosed(
    context: ResolvedActionPolicyContext,
    code: string,
    reason: string,
  ): AuthoritativePolicyDecision {
    const decision: PolicyPackDecision = {
      outcome: 'BLOCK',
      packId: 'policy-pack-fail-closed',
      packVersion: 'enforce',
      ruleId: null,
      reason,
      code,
      tier: 'restricted',
      simulated: false,
    };
    return this.envelope(decision, context, 'enforce', 'fail_closed', null, false);
  }

  private async loadPublishedPacks(tenantId: string): Promise<LoadedPublishedPacks> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      (tx as unknown as PolicyPackTx).compliancePolicyPack.findMany({
        where: { tenantId, status: 'published', nonProduction: false },
        orderBy: { effectiveFrom: 'desc' },
      }),
    );
    const packs: LoadedPublishedPacks['packs'] = [];
    let rejected = 0;
    for (const row of rows) {
      const pack = this.toPack(row);
      if (
        !pack ||
        !policyPackRulesMatchHash(pack, row.rulesHash) ||
        !validatePolicyPack(pack).valid
      ) {
        rejected += 1;
        this.logger.error(`[policy-pack] refusing unverified ${row.packKey}@${row.version}`);
        continue;
      }
      packs.push({ rowId: row.id, pack });
    }
    return { rowsSeen: rows.length, rejected, packs };
  }

  private toPack(row: PolicyPackRow): CompliancePolicyPack | null {
    const rules = Array.isArray(row.rulesJson)
      ? (row.rulesJson as CompliancePolicyPackRule[])
      : null;
    const authority = row.authorityJson as PolicyAuthority | null;
    if (!rules || !authority || typeof authority.title !== 'string') return null;
    return {
      id: row.packKey,
      version: row.version,
      jurisdiction: row.jurisdiction as CompliancePolicyPack['jurisdiction'],
      status: row.status as CompliancePolicyPack['status'],
      legalReviewStatus: row.legalReviewStatus as CompliancePolicyPack['legalReviewStatus'],
      authority,
      effectiveFrom: row.effectiveFrom.toISOString(),
      ...(row.effectiveUntil ? { effectiveUntil: row.effectiveUntil.toISOString() } : {}),
      ownerUserId: row.ownerUserId,
      ...(row.reviewedByUserId ? { reviewedByUserId: row.reviewedByUserId } : {}),
      ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
      ...(row.secondApprovedByUserId ? { secondApprovedByUserId: row.secondApprovedByUserId } : {}),
      ...(row.secondApprovedAt ? { secondApprovedAt: row.secondApprovedAt.toISOString() } : {}),
      ...(row.publishedByUserId ? { publishedByUserId: row.publishedByUserId } : {}),
      ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
      fourEyesRequired: row.fourEyesRequired,
      rules,
      fallback: row.fallbackOutcome as CompliancePolicyPack['fallback'],
      changelog: [],
      nonProduction: row.nonProduction,
    };
  }

  private packFromDraft(ctx: TenantContext, input: PolicyPackDraftInput): CompliancePolicyPack {
    return {
      id: input.packKey.trim(),
      version: input.version.trim(),
      jurisdiction: input.jurisdiction,
      status: 'draft',
      legalReviewStatus: input.legalReviewStatus ?? 'pending',
      authority: input.authority,
      effectiveFrom: input.effectiveFrom,
      ...(input.effectiveUntil ? { effectiveUntil: input.effectiveUntil } : {}),
      ownerUserId: ctx.userId,
      fourEyesRequired: input.fourEyesRequired ?? true,
      rules: input.rules,
      fallback: input.fallback ?? 'WARN',
      changelog: [],
      nonProduction: input.nonProduction ?? true,
    };
  }

  private publicRow(row: PolicyPackRow): Record<string, unknown> {
    return {
      id: row.id,
      packKey: row.packKey,
      version: row.version,
      jurisdiction: row.jurisdiction,
      status: row.status,
      legalReviewStatus: row.legalReviewStatus,
      authority: row.authorityJson,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
      ownerUserId: row.ownerUserId,
      reviewedByUserId: row.reviewedByUserId,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      secondApprovedByUserId: row.secondApprovedByUserId,
      secondApprovedAt: row.secondApprovedAt?.toISOString() ?? null,
      publishedByUserId: row.publishedByUserId,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      fourEyesRequired: row.fourEyesRequired,
      rules: row.rulesJson,
      fallback: row.fallbackOutcome,
      nonProduction: row.nonProduction,
      rulesHash: row.rulesHash,
      createdAt: row.createdAt?.toISOString() ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null,
    };
  }

  private assertAdmin(ctx: TenantContext): void {
    if (!ADMIN_ROLES.has(String(ctx.role)))
      throw new ForbiddenException('Policy-pack administration requires an administrator.');
  }

  private async requireRow(
    tenantId: string,
    id: string,
    throwIfMissing = true,
  ): Promise<PolicyPackRow> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      (tx as unknown as PolicyPackTx).compliancePolicyPack.findFirst({ where: { id, tenantId } }),
    );
    if (!row && throwIfMissing) throw new NotFoundException('Policy pack not found.');
    return row as PolicyPackRow;
  }

  private async transition(
    ctx: TenantContext,
    current: PolicyPackRow,
    toStatus: string,
    action: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const db = tx as unknown as PolicyPackTx;
      const updated = await db.compliancePolicyPack.update({
        where: { id: current.id },
        data: { status: toStatus },
      });
      await this.appendEvent(db, ctx, current.id, current.status, toStatus, action, reason);
      return updated;
    });
    return this.publicRow(row);
  }

  private async appendEvent(
    tx: PolicyPackTx,
    ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'role'>,
    policyPackId: string,
    fromStatus: string | null,
    toStatus: string | null,
    action: string,
    reason: string,
    rolledBackFromPackId: string | null = null,
  ): Promise<void> {
    await tx.compliancePolicyPackEvent.create({
      data: {
        tenantId: ctx.tenantId,
        policyPackId,
        fromStatus,
        toStatus,
        action,
        actorUserId: ctx.userId,
        actorRole: String(ctx.role),
        rolledBackFromPackId,
        reason: reason.trim().slice(0, 4000) || action,
        metadataJson: {},
      },
    });
  }
}

export function approvedGenericPolicyPackSeed(
  tenantId: string,
  ownerUserId: string,
): Record<string, unknown> {
  const pack = CAPIRO_APPROVED_GENERIC_POLICY_PACK;
  return {
    tenantId,
    packKey: pack.id,
    version: pack.version,
    jurisdiction: pack.jurisdiction,
    status: pack.status,
    legalReviewStatus: pack.legalReviewStatus,
    authorityJson: pack.authority,
    effectiveFrom: new Date(pack.effectiveFrom),
    ownerUserId,
    reviewedByUserId: ownerUserId,
    reviewedAt: new Date(pack.reviewedAt ?? pack.effectiveFrom),
    publishedByUserId: ownerUserId,
    publishedAt: new Date(pack.publishedAt ?? pack.effectiveFrom),
    fourEyesRequired: false,
    rulesJson: pack.rules,
    fallbackOutcome: pack.fallback,
    nonProduction: false,
    rulesHash: policyPackRulesHash(pack),
  };
}

interface PolicyPackTx {
  compliancePolicyPack: {
    findMany(args: unknown): Promise<PolicyPackRow[]>;
    findFirst(args: unknown): Promise<PolicyPackRow | null>;
    create(args: unknown): Promise<PolicyPackRow>;
    update(args: unknown): Promise<PolicyPackRow>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  compliancePolicyPackEvent: {
    create(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown[]>;
  };
  compliancePolicyDecision: {
    create(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown[]>;
  };
}
