// ---------------------------------------------------------------------------
// LIVE RUNTIME STATE — verified 2026-09-18, read-only (aws ecs describe-services
// + describe-task-definition on cluster capiro-dev). The Part-3 plan text said
// "V3 dark in prod" — that was WRONG; the MeriV3 canary is LIVE.
//
//   MERIV3_ENABLED             = 'true' on the live api task definition
//                                (capiro-dev-api:384; present since at least :382)
//                                and on capiro-dev-meriv2-orchestrator:65.
//   MERIV3_CANARY_TENANT_SLUGS = all 9 tenants: c2-strategies, capiro-internal,
//                                dualsight, maven, prospering-solutions, revere,
//                                victory-six-advisors, rubin-turnbull, abramoff
//                                (abramoff appended 2026-09-18 on api:383/orch:65).
//   meriv3.fullChat (DB flag)  = true for all 9 tenants (flag parity 2026-09-18).
//   => meriV3ChatActive / isMeriV3ChatEnabled resolve TRUE for every live tenant.
//      The code defaults below (env off, cohort = capiro-internal, flag false)
//      describe a FRESH environment, not production.
//
// CDK DRIFT WARNING: MERIV3_ENABLED (and MERIV3_CANARY_TENANT_SLUGS) are ABSENT
// from infra/cdk/lib/compute-stack.ts — both were applied OUT-OF-BAND on the task
// definitions. The live TD env is the source of truth; a `cdk deploy` would
// silently DROP them and turn the V3 canary OFF fleet-wide. The Capiro-dev-Compute
// stack has been wedged since 2026-05-27 — described as UPDATE_ROLLBACK_FAILED in
// compute-stack.ts and infra/cdk/DRIFT-FINDINGS.md; CloudFormation reported
// UPDATE_ROLLBACK_COMPLETE (last updated 2026-07-25) when re-read on 2026-09-18.
// Either way: do not `cdk deploy` this stack until these keys are codified there.
//
// Three-key truth table pinned in apps/api/src/meri/meri-feature-flags.matrix.spec.ts.
// ---------------------------------------------------------------------------
export const MERIV3_CHAT_FLAG = 'meriv3.fullChat' as const;

export function meriV3EnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIV3_ENABLED === 'true';
}

export function meriV3CanaryTenantSlugs(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.MERIV3_CANARY_TENANT_SLUGS?.trim() || 'capiro-internal';
  return new Set(
    raw
      .split(',')
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function meriV3TenantFlagEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const flags = (settings as Record<string, unknown>).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  return (flags as Record<string, unknown>)[MERIV3_CHAT_FLAG] === true;
}

/**
 * MeriV3 is a three-key canary: global switch, server-resolved tenant slug
 * allowlist, and an explicit per-tenant flag. Every key defaults closed.
 */
export function meriV3ChatActive(
  settings: unknown,
  tenantSlug: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!meriV3EnvironmentEnabled(env)) return false;
  const slug = tenantSlug?.trim().toLowerCase();
  if (!slug || !meriV3CanaryTenantSlugs(env).has(slug)) return false;
  return meriV3TenantFlagEnabled(settings);
}
