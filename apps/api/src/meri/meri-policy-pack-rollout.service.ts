import { Injectable } from '@nestjs/common';
import {
  CAPIRO_APPROVED_GENERIC_POLICY_PACK,
  evaluatePolicyPack,
  policyDecisionHash,
  policySelectionContextHash,
  proposalPolicyBinding,
  type PolicySelectionContext,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MeriPolicyPackService,
  resolvePersistedPolicyPackMode,
  type AuthoritativePolicyDecision,
  type PersistedPolicyPackMode,
  type PolicyDecisionAudit,
  type ResolvedActionPolicyContext,
} from './meri-policy-pack.service.js';

export const MERI_POLICY_PACK_TENANTS_ENV = 'MERI_POLICY_PACK_TENANTS';

/**
 * Resolve persisted policy authority through two server-owned controls:
 *
 * 1. the global off/shadow/enforce ceiling;
 * 2. an exact tenant allowlist (`MERI_POLICY_PACK_TENANTS`).
 *
 * An unset/malformed allowlist keeps every tenant on the reviewed static
 * baseline, even when somebody accidentally raises the global ceiling. `all`
 * is supported only for an explicitly approved GA step. Tenant values are
 * normalized UUID/text identifiers supplied by deployment configuration—not by
 * a browser request.
 */
export function resolvePersistedPolicyPackModeForTenant(
  tenantId: string,
  rawMode: string | undefined = process.env.MERI_POLICY_PACK_SOURCE,
  rawTenants: string | undefined = process.env[MERI_POLICY_PACK_TENANTS_ENV],
): PersistedPolicyPackMode {
  const mode = resolvePersistedPolicyPackMode(rawMode);
  if (mode === 'off') return 'off';
  const tenant = normalize(tenantId);
  if (!tenant) return 'off';
  const selected = tokens(rawTenants);
  return selected.includes('all') || selected.includes(tenant) ? mode : 'off';
}

export function persistedPolicyPacksEnforcedForTenant(
  tenantId: string,
  rawMode: string | undefined = process.env.MERI_POLICY_PACK_SOURCE,
  rawTenants: string | undefined = process.env[MERI_POLICY_PACK_TENANTS_ENV],
): boolean {
  return resolvePersistedPolicyPackModeForTenant(tenantId, rawMode, rawTenants) === 'enforce';
}

/**
 * Runtime replacement for MeriPolicyPackService under the same Nest token.
 *
 * Selected tenants delegate to the canonical base service unchanged. Unselected
 * tenants receive the reviewed static product baseline with `mode=off`; they do
 * not query persisted policy rows, cannot be blocked by another tenant's canary,
 * and cannot silently enter shadow/enforce. All proposal fingerprinting,
 * selected-version binding, decision auditing, approval revalidation, and
 * execution logic continue to consume the same AuthoritativePolicyDecision
 * contract.
 */
@Injectable()
export class TenantCanariedMeriPolicyPackService extends MeriPolicyPackService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  override async decide(
    tenantId: string,
    context: PolicySelectionContext | ResolvedActionPolicyContext,
    audit?: PolicyDecisionAudit,
  ): Promise<AuthoritativePolicyDecision> {
    const mode = resolvePersistedPolicyPackModeForTenant(tenantId);
    if (mode !== 'off') return super.decide(tenantId, context, audit);
    return staticBaselineDecision(context);
  }
}

export function staticBaselineDecision(
  context: PolicySelectionContext | ResolvedActionPolicyContext,
): AuthoritativePolicyDecision {
  const resolved = ensureResolvedContext(context);
  const decision = evaluatePolicyPack(CAPIRO_APPROVED_GENERIC_POLICY_PACK, resolved);
  const contextHash = policySelectionContextHash(resolved);
  return {
    ...decision,
    mode: 'off',
    source: 'static',
    verified: true,
    bindable: true,
    policyPackRowId: null,
    binding: proposalPolicyBinding(decision),
    contextHash,
    decisionHash: policyDecisionHash(decision, contextHash),
    context: resolved,
  };
}

function ensureResolvedContext(
  context: PolicySelectionContext | ResolvedActionPolicyContext,
): ResolvedActionPolicyContext {
  const effectiveAt = context.at instanceof Date ? context.at : new Date(context.at);
  if (!Number.isFinite(effectiveAt.getTime())) {
    throw new Error('The policy selection context has an invalid effective time.');
  }
  const effectiveUserId =
    (context as ResolvedActionPolicyContext).effectiveUserId ?? context.actorUserId;
  return { ...context, effectiveUserId, effectiveAt, at: effectiveAt };
}

function tokens(raw: string | undefined): string[] {
  return [...new Set(String(raw ?? '').split(/[,\s]+/).map(normalize).filter(Boolean))];
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Type-only compile assertion: the replacement remains assignable to the base token. */
const _serviceTokenCompatibility: new (prisma: PrismaService) => MeriPolicyPackService =
  TenantCanariedMeriPolicyPackService;
void _serviceTokenCompatibility;
