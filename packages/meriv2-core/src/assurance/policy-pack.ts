import { createHash } from 'node:crypto';
import type { RiskTier, TenantRole } from '@capiro/shared';
import type { GovernmentAffairsJurisdiction } from './operating-frame';

/**
 * Every lifecycle transition a persisted pack can record. Mirrors the
 * `compliance_policy_pack_event.action` CHECK constraint so the append-only
 * ledger and the in-code lifecycle cannot drift.
 */
export const POLICY_PACK_ACTIONS = [
  'create',
  'revise',
  'submit_review',
  'review',
  'approve',
  'publish',
  'retire',
  'rollback',
  'simulate',
] as const;
export type PolicyPackAction = (typeof POLICY_PACK_ACTIONS)[number];

export type PolicyPackOutcome = 'PASS' | 'WARN' | 'BLOCK';
export type PolicyPackStatus =
  | 'draft'
  | 'pending_review'
  | 'reviewed'
  | 'published'
  | 'retired'
  | 'disabled_example';
export type PolicyReviewStatus =
  | 'not_required_product_policy'
  | 'pending'
  | 'approved'
  | 'rejected';

export interface PolicyAuthority {
  type: 'approved_product_policy' | 'legal_authority' | 'client_policy' | 'example_only';
  title: string;
  sourceRef?: string;
  sourceVersion?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface PolicyRuleMatch {
  tools?: string[];
  jurisdictions?: GovernmentAffairsJurisdiction[];
  actorRoles?: TenantRole[];
  channels?: Array<'internal' | 'email' | 'document' | 'filing' | 'automation' | 'crm'>;
  recipientTypes?: Array<'internal' | 'government' | 'client' | 'public' | 'unknown'>;
  clientIds?: string[];
  /** Exact, server-derived context flags. Browser claims are not authority. */
  contextFlags?: Record<string, string | number | boolean>;
}

export interface CompliancePolicyPackRule {
  id: string;
  description: string;
  outcome: PolicyPackOutcome;
  code?: string;
  tier?: RiskTier;
  enabled: boolean;
  match: PolicyRuleMatch;
  reason: string;
  authorityRef: string;
  tests: string[];
}

export interface CompliancePolicyPack {
  id: string;
  version: string;
  jurisdiction: GovernmentAffairsJurisdiction | 'all';
  status: PolicyPackStatus;
  legalReviewStatus: PolicyReviewStatus;
  authority: PolicyAuthority;
  effectiveFrom: string;
  effectiveUntil?: string;
  ownerUserId: string;
  reviewedByUserId?: string;
  reviewedAt?: string;
  secondApprovedByUserId?: string;
  secondApprovedAt?: string;
  publishedByUserId?: string;
  publishedAt?: string;
  fourEyesRequired: boolean;
  rules: CompliancePolicyPackRule[];
  fallback: PolicyPackOutcome;
  changelog: Array<{ at: string; actorUserId: string; note: string }>;
  nonProduction: boolean;
}

export interface PolicySelectionContext {
  tenantId: string;
  actorUserId: string;
  actorRole: TenantRole;
  jurisdiction: GovernmentAffairsJurisdiction;
  clientId?: string;
  tool: string;
  channel: 'internal' | 'email' | 'document' | 'filing' | 'automation' | 'crm';
  recipientType?: 'internal' | 'government' | 'client' | 'public' | 'unknown';
  at: string | Date;
  contextFlags?: Record<string, string | number | boolean>;
}

export interface PolicyPackDecision {
  outcome: PolicyPackOutcome;
  packId: string;
  packVersion: string;
  ruleId: string | null;
  reason: string;
  code?: string;
  tier?: RiskTier;
  simulated: boolean;
}

export interface PolicyPublishActor {
  userId: string;
  role: TenantRole;
}

export interface PolicyPackValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * The only active seed pack mirrors already-approved product behavior. It does
 * not claim any substantive lobbying-law rule: external sends, CRM mutations,
 * and standing automation require explicit approval; unknown writes fail safe.
 */
export const CAPIRO_APPROVED_GENERIC_POLICY_PACK: CompliancePolicyPack = {
  id: 'capiro-generic-action-approval',
  version: '2026-07-27.meriv2-p0.v1',
  jurisdiction: 'all',
  status: 'published',
  legalReviewStatus: 'not_required_product_policy',
  authority: {
    type: 'approved_product_policy',
    title: 'Capiro Phase 0 action-approval policy',
    sourceRef: 'packages/meriv2-core/src/compliance/compliance-rules.ts',
    sourceVersion: '2026-07-27.meriv2-p0.v1',
  },
  effectiveFrom: '2026-07-27T00:00:00.000Z',
  ownerUserId: 'system',
  reviewedByUserId: 'system',
  reviewedAt: '2026-07-27T00:00:00.000Z',
  publishedByUserId: 'system',
  publishedAt: '2026-07-27T00:00:00.000Z',
  fourEyesRequired: false,
  rules: [
    {
      id: 'send.requires_approval',
      description: 'Outbound email requires explicit human approval.',
      outcome: 'WARN',
      code: 'external_send',
      tier: 'restricted',
      enabled: true,
      match: { tools: ['send_email', 'reply_email'] },
      reason: 'Outbound email leaves the firm and requires explicit approval.',
      authorityRef: 'approved-product-policy:send.requires_approval',
      tests: ['policy.send.requires-approval'],
    },
    {
      id: 'client_profile.requires_approval',
      description: 'Client-record creation or profile updates require approval.',
      outcome: 'WARN',
      code: 'crm_mutation',
      tier: 'high',
      enabled: true,
      match: { tools: ['update_client_profile', 'create_client'] },
      reason: 'The action changes the client system of record and requires approval.',
      authorityRef: 'approved-product-policy:client_profile.requires_approval',
      tests: ['policy.client-profile.requires-approval'],
    },
    {
      id: 'crm_task.requires_approval',
      description: 'Engagement task writes require approval.',
      outcome: 'WARN',
      code: 'crm_mutation',
      tier: 'high',
      enabled: true,
      match: { tools: ['create_task', 'update_task'] },
      reason: 'The action changes an engagement task in the CRM and requires approval.',
      authorityRef: 'approved-product-policy:crm_task.requires_approval',
      tests: ['policy.crm-task.requires-approval'],
    },
    {
      id: 'automation.requires_approval',
      description: 'Standing automation requires approval.',
      outcome: 'WARN',
      code: 'standing_automation',
      tier: 'high',
      enabled: true,
      match: { tools: ['schedule_task', 'cancel_scheduled_task'] },
      reason: 'Standing automation may act later without a human in the loop.',
      authorityRef: 'approved-product-policy:automation.requires_approval',
      tests: ['policy.automation.requires-approval'],
    },
    {
      id: 'internal_artifacts.pass',
      description:
        'Internal reversible artifacts and explicit memory saves are pre-approved and audited.',
      outcome: 'PASS',
      tier: 'low',
      enabled: true,
      match: {
        tools: [
          'save_note',
          'save_memory',
          'create_word',
          'create_excel',
          'create_powerpoint',
          'create_meeting_brief',
          'draft_policy_memo',
        ],
      },
      reason: 'The action creates an internal, reversible artifact or explicit memory save.',
      authorityRef: 'approved-product-policy:internal_artifacts.pass',
      tests: ['policy.internal-artifacts.pass'],
    },
  ],
  fallback: 'WARN',
  changelog: [
    {
      at: '2026-07-27T00:00:00.000Z',
      actorUserId: 'system',
      note: 'Encoded existing Phase 0 approved generic action gates; no legal rule added.',
    },
  ],
  nonProduction: false,
};

const EXAMPLE_CATEGORIES = [
  'gifts',
  'travel',
  'pay-to-play',
  'contingent-fees',
  'procurement-integrity',
  'ex-parte-contacts',
  'fara-lda',
  'revolving-door',
  'state-registration',
] as const;

/** Disabled metadata-only fixtures. They contain no substantive PASS/WARN/BLOCK rule. */
export const DISABLED_LEGAL_POLICY_EXAMPLES: readonly CompliancePolicyPack[] =
  EXAMPLE_CATEGORIES.map((category) => ({
    id: `example-${category}`,
    version: '0.0.0-example',
    jurisdiction: 'all',
    status: 'disabled_example',
    legalReviewStatus: 'pending',
    authority: {
      type: 'example_only',
      title: `Non-production example placeholder: ${category}`,
    },
    effectiveFrom: '1970-01-01T00:00:00.000Z',
    ownerUserId: 'system',
    fourEyesRequired: true,
    rules: [],
    fallback: 'WARN',
    changelog: [
      {
        at: '2026-07-28T00:00:00.000Z',
        actorUserId: 'system',
        note: 'Disabled schema fixture only. Requires legal/domain drafting and approval before rules exist.',
      },
    ],
    nonProduction: true,
  }));

export function validatePolicyPack(pack: CompliancePolicyPack): PolicyPackValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!pack.id.trim()) errors.push('Pack id is required.');
  if (!pack.version.trim()) errors.push('Pack version is required.');
  if (!isIso(pack.effectiveFrom)) errors.push('effectiveFrom must be a valid timestamp.');
  if (pack.effectiveUntil && !isIso(pack.effectiveUntil))
    errors.push('effectiveUntil must be valid.');
  if (pack.effectiveUntil && new Date(pack.effectiveUntil) <= new Date(pack.effectiveFrom)) {
    errors.push('effectiveUntil must be after effectiveFrom.');
  }
  if (!pack.authority.title.trim()) errors.push('Authority title is required.');
  if (pack.nonProduction && pack.status === 'published') {
    errors.push('A non-production policy pack cannot be published.');
  }
  if (pack.status === 'published') {
    if (
      pack.legalReviewStatus !== 'approved' &&
      pack.legalReviewStatus !== 'not_required_product_policy'
    ) {
      errors.push('A published pack must have approved review or be approved product policy.');
    }
    if (!pack.reviewedByUserId || !pack.reviewedAt)
      errors.push('Published pack lacks review attribution.');
    if (!pack.publishedByUserId || !pack.publishedAt)
      errors.push('Published pack lacks publication attribution.');
  }
  if (pack.fourEyesRequired && (pack.status === 'reviewed' || pack.status === 'published')) {
    if (!pack.reviewedByUserId || !pack.secondApprovedByUserId) {
      errors.push('Four-eyes policy requires two named reviewers before review completes.');
    }
    if (
      pack.reviewedByUserId &&
      pack.secondApprovedByUserId &&
      pack.reviewedByUserId === pack.secondApprovedByUserId
    ) {
      errors.push('Four-eyes reviewers must be different users.');
    }
  }
  const ids = new Set<string>();
  for (const rule of pack.rules) {
    if (!rule.id.trim()) errors.push('Every rule needs a stable id.');
    if (ids.has(rule.id)) errors.push(`Duplicate rule id: ${rule.id}.`);
    ids.add(rule.id);
    if (!rule.authorityRef.trim()) errors.push(`Rule ${rule.id} lacks authorityRef.`);
    if (!rule.tests.length) errors.push(`Rule ${rule.id} lacks a regression test id.`);
    if (!rule.match.tools?.length && !rule.match.contextFlags && !rule.match.channels?.length) {
      warnings.push(`Rule ${rule.id} has a broad match; review its blast radius.`);
    }
  }
  if (!pack.rules.length && !pack.nonProduction)
    warnings.push('Production pack has no rules; fallback controls every action.');
  return { valid: errors.length === 0, errors, warnings };
}

export function canPublishPolicyPack(
  pack: CompliancePolicyPack,
  actor: PolicyPublishActor,
): PolicyPackValidation {
  const validation = validatePolicyPack(pack);
  const errors = [...validation.errors];
  if (actor.role !== 'user_admin' && actor.role !== 'capiro_admin') {
    errors.push('Only an administrator may publish a policy pack.');
  }
  if (pack.status !== 'reviewed') errors.push('Only a reviewed policy pack may be published.');
  if (pack.nonProduction || pack.status === 'disabled_example') {
    errors.push('Example/non-production packs cannot be activated.');
  }
  if (pack.fourEyesRequired) {
    if (!pack.reviewedByUserId || !pack.secondApprovedByUserId) {
      errors.push('Required two-person review is incomplete.');
    }
    if (actor.userId === pack.reviewedByUserId || actor.userId === pack.secondApprovedByUserId) {
      errors.push(
        'The publisher must be distinct from both reviewers when four-eyes publishing is enabled.',
      );
    }
  }
  return { valid: errors.length === 0, errors, warnings: validation.warnings };
}

export function publishPolicyPack(
  pack: CompliancePolicyPack,
  actor: PolicyPublishActor,
  at: string | Date = new Date(),
): CompliancePolicyPack {
  const decision = canPublishPolicyPack(pack, actor);
  if (!decision.valid) throw new Error(decision.errors.join(' '));
  const timestamp = iso(at);
  return {
    ...clonePack(pack),
    status: 'published',
    publishedByUserId: actor.userId,
    publishedAt: timestamp,
    changelog: [
      ...pack.changelog,
      { at: timestamp, actorUserId: actor.userId, note: `Published version ${pack.version}.` },
    ],
  };
}

export function rollbackPolicyPack(
  current: CompliancePolicyPack,
  previous: CompliancePolicyPack,
  actor: PolicyPublishActor,
  at: string | Date = new Date(),
): { retired: CompliancePolicyPack; restored: CompliancePolicyPack } {
  if (actor.role !== 'user_admin' && actor.role !== 'capiro_admin') {
    throw new Error('Only an administrator may roll back a policy pack.');
  }
  if (previous.id !== current.id) throw new Error('Rollback pack id must match the current pack.');
  if (previous.status !== 'published' && previous.status !== 'retired') {
    throw new Error('Rollback target must be a previously reviewed published version.');
  }
  if (previous.nonProduction) throw new Error('Cannot roll back to a non-production pack.');
  const timestamp = iso(at);
  return {
    retired: {
      ...clonePack(current),
      status: 'retired',
      changelog: [
        ...current.changelog,
        {
          at: timestamp,
          actorUserId: actor.userId,
          note: `Retired during rollback to ${previous.version}.`,
        },
      ],
    },
    restored: {
      ...clonePack(previous),
      status: 'published',
      publishedByUserId: actor.userId,
      publishedAt: timestamp,
      changelog: [
        ...previous.changelog,
        {
          at: timestamp,
          actorUserId: actor.userId,
          note: `Restored by rollback from ${current.version}.`,
        },
      ],
    },
  };
}

export function selectPolicyPack(
  packs: readonly CompliancePolicyPack[],
  context: PolicySelectionContext,
): CompliancePolicyPack | null {
  const at = new Date(context.at);
  return (
    packs
      .filter((pack) => {
        if (pack.status !== 'published' || pack.nonProduction) return false;
        if (pack.jurisdiction !== 'all' && pack.jurisdiction !== context.jurisdiction) return false;
        if (new Date(pack.effectiveFrom) > at) return false;
        if (pack.effectiveUntil && new Date(pack.effectiveUntil) < at) return false;
        return validatePolicyPack(pack).valid;
      })
      .sort((a, b) => {
        const jurisdictionSpecific =
          Number(b.jurisdiction !== 'all') - Number(a.jurisdiction !== 'all');
        return (
          jurisdictionSpecific ||
          new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime() ||
          b.version.localeCompare(a.version)
        );
      })[0] ?? null
  );
}

export function evaluatePolicyPack(
  pack: CompliancePolicyPack,
  context: PolicySelectionContext,
  simulated = false,
): PolicyPackDecision {
  if (pack.status !== 'published' || pack.nonProduction) {
    return {
      outcome: 'WARN',
      packId: pack.id,
      packVersion: pack.version,
      ruleId: null,
      reason:
        'The policy pack is not an active reviewed production pack; fail-safe approval is required.',
      simulated,
    };
  }
  for (const rule of pack.rules) {
    if (!rule.enabled || !ruleMatches(rule.match, context)) continue;
    return {
      outcome: rule.outcome,
      packId: pack.id,
      packVersion: pack.version,
      ruleId: rule.id,
      reason: rule.reason,
      ...(rule.code ? { code: rule.code } : {}),
      ...(rule.tier ? { tier: rule.tier } : {}),
      simulated,
    };
  }
  return {
    outcome: pack.fallback,
    packId: pack.id,
    packVersion: pack.version,
    ruleId: null,
    reason: 'No reviewed rule matched; the pack fallback applies.',
    simulated,
  };
}

export function proposalPolicyBinding(decision: PolicyPackDecision): string {
  return `${decision.packId}@${decision.packVersion}:${decision.ruleId ?? 'fallback'}`;
}

/**
 * Stable hash of the SERVER-RESOLVED policy context. Evaluation time is
 * deliberately excluded: approval minutes later must remain valid when every
 * decision-bearing dimension and selected pack are unchanged. Effective-window
 * changes still invalidate because they select a different pack/binding.
 */
export function policySelectionContextHash(context: PolicySelectionContext): string {
  const material = {
    tenantId: context.tenantId,
    actorUserId: context.actorUserId,
    actorRole: context.actorRole,
    jurisdiction: context.jurisdiction,
    clientId: context.clientId ?? null,
    tool: context.tool,
    channel: context.channel,
    recipientType: context.recipientType ?? 'unknown',
    contextFlags: context.contextFlags ?? {},
  };
  return createHash('sha256').update(stablePolicyStringify(material)).digest('hex');
}

/**
 * Stable evidence hash over the exact pack/rule/outcome and resolved context.
 * Human-facing reason text is excluded so copy edits cannot silently invalidate
 * an otherwise identical approval; every decision-bearing field is included.
 */
export function policyDecisionHash(
  decision: PolicyPackDecision,
  contextHash: string,
): string {
  const material = {
    binding: proposalPolicyBinding(decision),
    outcome: decision.outcome,
    code: decision.code ?? null,
    tier: decision.tier ?? null,
    contextHash,
    simulated: decision.simulated,
  };
  return createHash('sha256').update(stablePolicyStringify(material)).digest('hex');
}

/**
 * Stable content hash over the ENABLED rule set + fallback.
 *
 * This is what makes a persisted pack tamper-evident: a row whose `rules_jsonb`
 * was edited without going back through review has a `rules_hash` that no longer
 * matches, and `policyPackRulesMatchHash` says so. Deliberately excludes review /
 * publication attribution and the changelog — those legitimately change during
 * the lifecycle without changing what the pack DECIDES.
 */
export function policyPackRulesHash(pack: CompliancePolicyPack): string {
  const material = {
    fallback: pack.fallback,
    rules: [...pack.rules]
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        id: rule.id,
        outcome: rule.outcome,
        code: rule.code ?? null,
        tier: rule.tier ?? null,
        match: rule.match,
        authorityRef: rule.authorityRef,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash('sha256').update(stablePolicyStringify(material)).digest('hex');
}

export function policyPackRulesMatchHash(pack: CompliancePolicyPack, hash: string): boolean {
  return policyPackRulesHash(pack) === hash;
}

/**
 * SIMULATION: evaluate a pack that is NOT (or not yet) live and report the
 * outcome without it ever binding a real action. `simulated: true` is carried on
 * the decision so a persisted `compliance_policy_decision` row can never be
 * mistaken for an enforcement event.
 *
 * A draft/pending_review pack is intentionally evaluated as if published so a
 * reviewer can see what it WOULD decide — that is the whole point of a dry run —
 * which is exactly why the result is stamped `simulated` and why
 * `selectPolicyPack` still refuses to hand a non-published pack to live traffic.
 */
export function simulatePolicyPack(
  pack: CompliancePolicyPack,
  context: PolicySelectionContext,
): PolicyPackDecision {
  const validation = validatePolicyPack({ ...pack, status: 'draft', nonProduction: false });
  if (!validation.valid) {
    return {
      outcome: 'WARN',
      packId: pack.id,
      packVersion: pack.version,
      ruleId: null,
      reason: `Simulation refused: the pack is structurally invalid (${validation.errors[0] ?? 'unknown error'}).`,
      simulated: true,
    };
  }
  for (const rule of pack.rules) {
    if (!rule.enabled || !ruleMatches(rule.match, context)) continue;
    return {
      outcome: rule.outcome,
      packId: pack.id,
      packVersion: pack.version,
      ruleId: rule.id,
      reason: rule.reason,
      ...(rule.code ? { code: rule.code } : {}),
      ...(rule.tier ? { tier: rule.tier } : {}),
      simulated: true,
    };
  }
  return {
    outcome: pack.fallback,
    packId: pack.id,
    packVersion: pack.version,
    ruleId: null,
    reason: 'Simulation: no rule matched; the pack fallback applies.',
    simulated: true,
  };
}

function stablePolicyStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePolicyStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stablePolicyStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function ruleMatches(match: PolicyRuleMatch, context: PolicySelectionContext): boolean {
  if (match.tools?.length && !match.tools.includes(context.tool)) return false;
  if (match.jurisdictions?.length && !match.jurisdictions.includes(context.jurisdiction))
    return false;
  if (match.actorRoles?.length && !match.actorRoles.includes(context.actorRole)) return false;
  if (match.channels?.length && !match.channels.includes(context.channel)) return false;
  if (
    match.recipientTypes?.length &&
    !match.recipientTypes.includes(context.recipientType ?? 'unknown')
  )
    return false;
  if (match.clientIds?.length && (!context.clientId || !match.clientIds.includes(context.clientId)))
    return false;
  for (const [key, expected] of Object.entries(match.contextFlags ?? {})) {
    if (context.contextFlags?.[key] !== expected) return false;
  }
  return true;
}

function clonePack(pack: CompliancePolicyPack): CompliancePolicyPack {
  return JSON.parse(JSON.stringify(pack)) as CompliancePolicyPack;
}

function isIso(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid policy timestamp.');
  return date.toISOString();
}
