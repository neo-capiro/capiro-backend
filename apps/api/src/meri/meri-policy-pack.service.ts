import { Injectable, Logger } from '@nestjs/common';
import {
  CAPIRO_APPROVED_GENERIC_POLICY_PACK,
  evaluatePolicyPack,
  policyPackRulesHash,
  policyPackRulesMatchHash,
  proposalPolicyBinding,
  selectPolicyPack,
  simulatePolicyPack,
  validatePolicyPack,
  type CompliancePolicyPack,
  type CompliancePolicyPackRule,
  type PolicyAuthority,
  type PolicyPackDecision,
  type PolicySelectionContext,
} from '@capiro/meriv2-core';
import type { TenantRole } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * PERSISTED compliance policy packs — the read + audit half of
 * packages/meriv2-core/src/assurance/policy-pack.ts.
 *
 * That module already implements the whole lifecycle (validate / canPublish /
 * publish / rollback / select / evaluate / simulate) as pure functions over an
 * in-code constant, so before this there was no draft, no review record, no
 * publication attribution, no rollback trail, and — most importantly — no record of
 * WHICH pack version bound a given action. The decision that actually ran in
 * production was a different, unversioned in-code ruleset
 * (ruleBasedCompliancePolicy([...PROPOSED_CAPIRO_RULES])).
 *
 * SAFETY POSTURE
 * - DARK BY DEFAULT. `persistedPolicyPacksEnforced` must be explicitly armed;
 *   until then this service is read-only observation and the in-code ruleset stays
 *   authoritative. Nothing about today's decisions changes by deploying this.
 * - FAIL SAFE, NEVER FAIL OPEN. Every degradation (no pack row, an invalid pack, a
 *   tampered rules_hash, a database error) resolves to `null`, and the caller falls
 *   back to the in-code ruleset. This service can therefore never make an action
 *   MORE permitted than it is today.
 * - A tampered row is refused, not used. `rules_hash` is recomputed on load; a
 *   rules_jsonb edited outside the review flow no longer matches and the pack is
 *   discarded with a warning.
 */

export type PersistedPolicyPackMode = 'off' | 'enforce';

/**
 * Master switch for letting a PERSISTED pack decide a real action.
 *
 * Deliberately NOT `MERI_RELEASE_GATE` (which arms chat's hold and api-strategy's
 * generation hold) and NOT `MERI_RELEASE_GATE_SURFACES` (which arms per-surface
 * withholds). This switch changes which RULESET binds a write — a different blast
 * radius that deserves its own flip.
 *
 * Pure parser, exact match, defaults off — same shape as
 * `resolveAssuranceReleaseMode` and `governedMemoryEnforcementEnabled`.
 */
export function resolvePersistedPolicyPackMode(raw: string | undefined): PersistedPolicyPackMode {
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'enforce'
    ? 'enforce'
    : 'off';
}

export function persistedPolicyPacksEnforced(
  raw: string | undefined = process.env.MERI_POLICY_PACK_SOURCE,
): boolean {
  return resolvePersistedPolicyPackMode(raw) === 'enforce';
}

/** The row shape this service reads. Kept local so the Prisma model can evolve. */
interface PolicyPackRow {
  id: string;
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
}

export interface PolicyDecisionAudit {
  tool: string;
  channel: 'internal' | 'email' | 'document' | 'filing' | 'automation' | 'crm';
  recipientType?: 'internal' | 'government' | 'client' | 'public' | 'unknown';
  actorUserId: string;
  actorRole: string;
  clientId?: string;
  jurisdiction: string;
  meriActionProposalId?: string;
}

@Injectable()
export class MeriPolicyPackService {
  private readonly logger = new Logger(MeriPolicyPackService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Decide with the tenant's PUBLISHED pack, or return null so the caller keeps
   * using the in-code ruleset.
   *
   * Returns null (⇒ fall back) when the switch is off, when no usable published
   * pack exists, or on ANY error. It never throws: a compliance decision path must
   * not be the thing that takes an action proposal down.
   */
  async decide(
    tenantId: string,
    context: PolicySelectionContext,
    audit: PolicyDecisionAudit,
  ): Promise<PolicyPackDecision | null> {
    if (!persistedPolicyPacksEnforced()) return null;
    try {
      const packs = await this.loadPublishedPacks(tenantId);
      const pack = selectPolicyPack(packs, context);
      if (!pack) {
        // No published pack is NOT "everything is fine" — say so, then fall back to
        // the in-code ruleset rather than inventing a permissive default.
        this.logger.warn(
          `[policy-pack] no published pack selected for tenant ${tenantId} (${context.tool}); falling back to the in-code ruleset`,
        );
        return null;
      }
      const decision = evaluatePolicyPack(pack, context);
      await this.recordDecision(tenantId, pack.id, decision, audit);
      return decision;
    } catch (error) {
      this.logger.warn(
        `[policy-pack] persisted decision unavailable (falling back to the in-code ruleset): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * DRY RUN a pack against a context without it binding anything. Always stamped
   * `simulated`, and the recorded audit row carries `simulated = true`, so a
   * simulation can never be mistaken for an enforcement event.
   */
  async simulate(
    tenantId: string,
    packId: string,
    context: PolicySelectionContext,
    audit: PolicyDecisionAudit,
  ): Promise<PolicyPackDecision | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      (tx as unknown as PolicyPackTx).compliancePolicyPack.findFirst({
        where: { id: packId, tenantId },
      }),
    );
    if (!row) return null;
    const pack = this.toPack(row);
    if (!pack) return null;
    const decision = simulatePolicyPack(pack, context);
    await this.recordDecision(tenantId, row.id, decision, audit);
    return decision;
  }

  /**
   * The published packs for this tenant, mapped to the pure module's shape.
   *
   * Three filters, all of which DISCARD rather than repair: a row whose
   * `rules_hash` does not match its `rules_jsonb` was edited outside the review
   * flow; a row that fails `validatePolicyPack` is structurally unsound; and
   * `selectPolicyPack` itself re-checks status/nonProduction/effective window. A
   * discarded pack means "fall back to the in-code ruleset", never "allow".
   */
  private async loadPublishedPacks(tenantId: string): Promise<CompliancePolicyPack[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      (tx as unknown as PolicyPackTx).compliancePolicyPack.findMany({
        where: { tenantId, status: 'published', nonProduction: false },
        orderBy: { effectiveFrom: 'desc' },
      }),
    );
    const packs: CompliancePolicyPack[] = [];
    for (const row of rows) {
      const pack = this.toPack(row);
      if (!pack) continue;
      if (!policyPackRulesMatchHash(pack, row.rulesHash)) {
        this.logger.error(
          `[policy-pack] REFUSING pack ${row.packKey}@${row.version}: rules_hash mismatch ` +
            `(stored ${row.rulesHash.slice(0, 12)}, computed ${policyPackRulesHash(pack).slice(0, 12)}). ` +
            'The rules were changed outside the review flow.',
        );
        continue;
      }
      const validation = validatePolicyPack(pack);
      if (!validation.valid) {
        this.logger.error(
          `[policy-pack] REFUSING pack ${row.packKey}@${row.version}: ${validation.errors.join(' ')}`,
        );
        continue;
      }
      packs.push(pack);
    }
    return packs;
  }

  private toPack(row: PolicyPackRow): CompliancePolicyPack | null {
    const rules = Array.isArray(row.rulesJson)
      ? (row.rulesJson as CompliancePolicyPackRule[])
      : null;
    const authority = row.authorityJson as PolicyAuthority | null;
    if (!rules || !authority || typeof authority.title !== 'string') {
      this.logger.error(
        `[policy-pack] REFUSING pack ${row.packKey}@${row.version}: malformed rules/authority JSON.`,
      );
      return null;
    }
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
      // The append-only changelog lives in compliance_policy_pack_event, not on the
      // pack row, so the in-memory pack carries an empty one. validatePolicyPack
      // does not inspect it.
      changelog: [],
      nonProduction: row.nonProduction,
    };
  }

  /**
   * The SELECTED-VERSION audit row. Best-effort: losing the audit must not change
   * the decision the caller already has, and must not fail the action. That is a
   * deliberate trade — the compliance decision itself is separately recorded by
   * MeriComplianceDecision, so this row is the pack-attribution layer on top.
   */
  private async recordDecision(
    tenantId: string,
    policyPackId: string | null,
    decision: PolicyPackDecision,
    audit: PolicyDecisionAudit,
  ): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        (tx as unknown as PolicyPackTx).compliancePolicyDecision.create({
          data: {
            tenantId,
            policyPackId,
            packKey: decision.packId,
            packVersion: decision.packVersion,
            ruleId: decision.ruleId,
            outcome: decision.outcome,
            code: decision.code ?? null,
            tier: decision.tier ?? null,
            simulated: decision.simulated,
            binding: proposalPolicyBinding(decision).slice(0, 280),
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
        }),
      );
    } catch (error) {
      this.logger.warn(
        `[policy-pack] decision audit write failed (non-fatal): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * The seed pack, expressed as the row a tenant-scoped writer must create.
 *
 * NOT written by a migration on purpose: RLS + FORCE makes an INSERT inside a
 * migration (which runs as capiro_master with no `app.current_tenant`) silently
 * no-op, so a migration seed would look successful and produce nothing. This is
 * therefore the payload for an application-side seeder running under a real tenant
 * context.
 *
 * DISABLED_LEGAL_POLICY_EXAMPLES is deliberately NOT exported in any seedable form.
 * Those packs carry no substantive rule, are `nonProduction`, and every in-code
 * guard plus the DB CHECK refuses to publish them.
 */
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
    fourEyesRequired: pack.fourEyesRequired,
    rulesJson: pack.rules,
    fallbackOutcome: pack.fallback,
    nonProduction: false,
    rulesHash: policyPackRulesHash(pack),
  };
}

/** Minimal structural view of the tenant-scoped client this service needs. */
interface PolicyPackTx {
  compliancePolicyPack: {
    findMany(args: unknown): Promise<PolicyPackRow[]>;
    findFirst(args: unknown): Promise<PolicyPackRow | null>;
  };
  compliancePolicyDecision: { create(args: unknown): Promise<unknown> };
}

/** Narrow a TenantRole for the selection context without widening the import. */
export function policyActorRole(role: string): TenantRole {
  return role as TenantRole;
}

/**
 * The CHANNEL a tool acts through, derived from the tool name only.
 *
 * A policy rule can match on channel, so this mapping is part of the decision. It
 * is deliberately conservative: anything not recognized is `internal`, which is the
 * NARROWEST match — an unrecognized tool therefore fails to match an
 * email/filing-scoped rule and lands on the pack's fallback (WARN), rather than
 * accidentally matching a permissive channel rule.
 */
export function policyChannelForTool(
  tool: string,
): 'internal' | 'email' | 'document' | 'filing' | 'automation' | 'crm' {
  if (/^(?:send_email|reply_email)$/.test(tool)) return 'email';
  if (/^(?:schedule_task|cancel_scheduled_task)$/.test(tool)) return 'automation';
  if (/^(?:create_client|update_client_profile|create_task|update_task)$/.test(tool)) return 'crm';
  if (
    /^(?:draft_policy_memo|create_meeting_brief|create_word|create_excel|create_powerpoint)$/.test(
      tool,
    )
  ) {
    return 'document';
  }
  return 'internal';
}

/**
 * The RECIPIENT type, again from the tool name only. `unknown` for anything that
 * does not obviously leave the firm — the fail-safe value, since a rule scoped to
 * `recipientTypes: ['government']` will not match `unknown` and the fallback applies.
 */
export function policyRecipientTypeForTool(
  tool: string,
): 'internal' | 'government' | 'client' | 'public' | 'unknown' {
  if (/^(?:send_email|reply_email)$/.test(tool)) return 'unknown';
  if (/^(?:save_note|save_memory)$/.test(tool)) return 'internal';
  return 'unknown';
}
