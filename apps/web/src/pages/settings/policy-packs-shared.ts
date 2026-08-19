/**
 * UI-free policy-pack domain logic — extracted from PolicyPacksPage.tsx (antd)
 * so the vNext Settings module shares the exact same lifecycle/action rules and
 * payload builders (extraction pattern, purge Phase 2). PolicyPacksPage
 * re-exports everything here; its public API is unchanged.
 */
import type { TenantRole } from '@capiro/shared';

export type PolicyPackStatus =
  | 'draft'
  | 'pending_review'
  | 'reviewed'
  | 'published'
  | 'retired'
  | 'disabled_example';

export type PolicyOutcome = 'PASS' | 'WARN' | 'BLOCK';
export type PolicyJurisdiction =
  | 'all'
  | 'federal'
  | 'state'
  | 'local'
  | 'regulatory'
  | 'procurement'
  | 'grants';

export interface PolicyAuthority {
  type: 'approved_product_policy' | 'legal_authority' | 'client_policy' | 'example_only';
  title: string;
  sourceRef?: string;
  sourceVersion?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  outcome: PolicyOutcome;
  code?: string;
  tier?: 'low' | 'moderate' | 'high' | 'restricted';
  enabled: boolean;
  match: {
    tools?: string[];
    jurisdictions?: Exclude<PolicyJurisdiction, 'all'>[];
    actorRoles?: TenantRole[];
    channels?: Array<'internal' | 'email' | 'document' | 'filing' | 'automation' | 'crm'>;
    recipientTypes?: Array<'internal' | 'government' | 'client' | 'public' | 'unknown'>;
    clientIds?: string[];
    contextFlags?: Record<string, string | number | boolean>;
  };
  reason: string;
  authorityRef: string;
  tests: string[];
}

export interface PolicyPackRow {
  id: string;
  packKey: string;
  version: string;
  jurisdiction: PolicyJurisdiction;
  status: PolicyPackStatus;
  legalReviewStatus: 'not_required_product_policy' | 'pending' | 'approved' | 'rejected';
  authority: PolicyAuthority;
  effectiveFrom: string;
  effectiveUntil: string | null;
  ownerUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: string | null;
  publishedByUserId: string | null;
  publishedAt: string | null;
  fourEyesRequired: boolean;
  rules: PolicyRule[];
  fallback: PolicyOutcome;
  nonProduction: boolean;
  rulesHash: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PolicyPackEvent {
  id: string;
  fromStatus: string | null;
  toStatus: string | null;
  action: string;
  actorUserId: string;
  actorRole: string;
  reason: string;
  occurredAt: string;
}

export interface PolicyDecisionRow {
  id: string;
  packKey: string | null;
  packVersion: string | null;
  ruleId: string | null;
  outcome: PolicyOutcome;
  code: string | null;
  simulated: boolean;
  policySource: string;
  policyMode: string;
  tool: string;
  channel: string;
  jurisdiction: string;
  reason: string;
  decidedAt: string;
}

export interface PolicyRuleFormValue {
  id: string;
  description: string;
  outcome: PolicyOutcome;
  code?: string;
  tier?: 'low' | 'moderate' | 'high' | 'restricted';
  enabled?: boolean;
  tools?: string[];
  tests?: string[];
  authorityRef: string;
  reason: string;
  additionalMatchJson?: string;
}

export interface PolicyPackFormValues {
  packKey: string;
  version: string;
  jurisdiction: PolicyJurisdiction;
  legalReviewStatus: PolicyPackRow['legalReviewStatus'];
  authorityType: PolicyAuthority['type'];
  authorityTitle: string;
  authoritySourceRef?: string;
  authoritySourceVersion?: string;
  effectiveFrom: string;
  effectiveUntil?: string;
  fourEyesRequired?: boolean;
  fallback: PolicyOutcome;
  nonProduction?: boolean;
  rules: PolicyRuleFormValue[];
}

export interface SimulationFormValues {
  tool: string;
  inputJson: string;
  jurisdiction?: Exclude<PolicyJurisdiction, 'all'>;
  clientId?: string;
}

export interface PolicyPackActionState {
  canEdit: boolean;
  canSubmitReview: boolean;
  canReview: boolean;
  canSecondApprove: boolean;
  canPublish: boolean;
  canRetire: boolean;
  canRollback: boolean;
  canSimulate: boolean;
  reviewBlockedReason?: string;
  secondApprovalBlockedReason?: string;
}

export function policyPackActionState(
  pack: PolicyPackRow,
  currentUserId: string,
  retiredVersions: PolicyPackRow[] = [],
): PolicyPackActionState {
  const reviewBlockedReason =
    pack.ownerUserId === currentUserId
      ? 'The draft owner cannot review their own policy pack.'
      : pack.reviewedByUserId
        ? 'A first review is already recorded.'
        : undefined;
  const secondApprovalBlockedReason =
    pack.ownerUserId === currentUserId || pack.reviewedByUserId === currentUserId
      ? 'The second approver must be independent of the owner and first reviewer.'
      : undefined;
  return {
    canEdit: pack.status === 'draft',
    canSubmitReview: pack.status === 'draft',
    canReview:
      pack.status === 'pending_review' &&
      !pack.reviewedByUserId &&
      reviewBlockedReason === undefined,
    canSecondApprove:
      pack.status === 'pending_review' &&
      pack.fourEyesRequired &&
      Boolean(pack.reviewedByUserId) &&
      secondApprovalBlockedReason === undefined,
    canPublish: pack.status === 'reviewed' && !pack.nonProduction,
    canRetire: pack.status === 'published',
    canRollback:
      pack.status === 'published' &&
      retiredVersions.some(
        (candidate) => candidate.packKey === pack.packKey && !candidate.nonProduction,
      ),
    canSimulate: pack.status !== 'disabled_example',
    ...(reviewBlockedReason ? { reviewBlockedReason } : {}),
    ...(secondApprovalBlockedReason ? { secondApprovalBlockedReason } : {}),
  };
}

function parseObject(value: string | undefined, label: string): Record<string, unknown> {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function iso(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.valueOf())) throw new Error(`${label} must be a valid date and time.`);
  return date.toISOString();
}

export function buildPolicyPackPayload(
  values: PolicyPackFormValues,
  revision = false,
): Record<string, unknown> {
  const effectiveFrom = iso(values.effectiveFrom, 'Effective from');
  if (!effectiveFrom) throw new Error('Effective from is required.');
  const effectiveUntil = iso(values.effectiveUntil, 'Effective until');
  const rules = (values.rules ?? []).map((rule, index): PolicyRule => {
    const extra = parseObject(rule.additionalMatchJson, `Rule ${index + 1} additional match`);
    const tools = (rule.tools ?? []).map((item) => item.trim()).filter(Boolean);
    const tests = (rule.tests ?? []).map((item) => item.trim()).filter(Boolean);
    if (!rule.id?.trim()) throw new Error(`Rule ${index + 1} needs an ID.`);
    if (!tests.length) throw new Error(`Rule ${rule.id} needs at least one regression test ID.`);
    return {
      id: rule.id.trim(),
      description: rule.description.trim(),
      outcome: rule.outcome,
      ...(rule.code?.trim() ? { code: rule.code.trim() } : {}),
      ...(rule.tier ? { tier: rule.tier } : {}),
      enabled: rule.enabled !== false,
      match: {
        ...extra,
        ...(tools.length ? { tools } : {}),
      },
      reason: rule.reason.trim(),
      authorityRef: rule.authorityRef.trim(),
      tests,
    };
  });
  const common = {
    jurisdiction: values.jurisdiction,
    legalReviewStatus: values.legalReviewStatus,
    authority: {
      type: values.authorityType,
      title: values.authorityTitle.trim(),
      ...(values.authoritySourceRef?.trim() ? { sourceRef: values.authoritySourceRef.trim() } : {}),
      ...(values.authoritySourceVersion?.trim()
        ? { sourceVersion: values.authoritySourceVersion.trim() }
        : {}),
    },
    effectiveFrom,
    ...(effectiveUntil ? { effectiveUntil } : { effectiveUntil: null }),
    fourEyesRequired: values.fourEyesRequired !== false,
    rules,
    fallback: values.fallback,
    nonProduction: values.nonProduction !== false,
  };
  return revision
    ? common
    : {
        packKey: values.packKey.trim(),
        version: values.version.trim(),
        ...common,
      };
}

export function buildSimulationPayload(values: SimulationFormValues): Record<string, unknown> {
  return {
    tool: values.tool.trim(),
    input: parseObject(values.inputJson, 'Simulation input'),
    ...(values.jurisdiction ? { jurisdiction: values.jurisdiction } : {}),
    ...(values.clientId?.trim() ? { clientId: values.clientId.trim() } : {}),
  };
}

export function policyPackFormValuesFor(pack: PolicyPackRow): PolicyPackFormValues {
  return {
    packKey: pack.packKey,
    version: pack.version,
    jurisdiction: pack.jurisdiction,
    legalReviewStatus: pack.legalReviewStatus,
    authorityType: pack.authority.type,
    authorityTitle: pack.authority.title,
    authoritySourceRef: pack.authority.sourceRef,
    authoritySourceVersion: pack.authority.sourceVersion,
    effectiveFrom: pack.effectiveFrom,
    effectiveUntil: pack.effectiveUntil ?? undefined,
    fourEyesRequired: pack.fourEyesRequired,
    fallback: pack.fallback,
    nonProduction: pack.nonProduction,
    rules: pack.rules.map((rule) => {
      const { tools, ...additionalMatch } = rule.match;
      return {
        id: rule.id,
        description: rule.description,
        outcome: rule.outcome,
        code: rule.code,
        tier: rule.tier,
        enabled: rule.enabled,
        tools: tools ?? [],
        tests: rule.tests,
        authorityRef: rule.authorityRef,
        reason: rule.reason,
        additionalMatchJson:
          Object.keys(additionalMatch).length > 0 ? JSON.stringify(additionalMatch, null, 2) : '',
      };
    }),
  };
}

export function policyPackStatusLabel(status: PolicyPackStatus): string {
  return {
    draft: 'Draft',
    pending_review: 'Pending review',
    reviewed: 'Reviewed',
    published: 'Published',
    retired: 'Retired',
    disabled_example: 'Disabled example',
  }[status];
}

export function policyPackErrorMessage(error: unknown): string {
  const axiosError = error as {
    response?: { data?: { message?: string | string[] } };
    message?: string;
  };
  const message = axiosError.response?.data?.message;
  if (Array.isArray(message)) return message.join(' ');
  return message ?? axiosError.message ?? 'The policy-pack operation failed.';
}
