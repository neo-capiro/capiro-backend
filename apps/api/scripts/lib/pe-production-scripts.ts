/**
 * Permanent PE production-script catalog (Phase K / closeout Phase 8).
 *
 * typecheck:pe-scripts and lint:pe-scripts must name EXACTLY these files (plus
 * the pure helpers they depend on via the bounded tsconfig include). Adding a
 * new PE dollar/sync/drain script that can write canonical PE data requires
 * registering it here AND covering it in tests — never grow the typecheck set
 * via wildcards.
 */
export const PE_PRODUCTION_SCRIPTS = [
  // Exact-SHA dollar loaders (Phase E contract)
  'scripts/sync-comptroller-jbooks.ts',
  'scripts/sync-jbook-r2.ts',
  'scripts/sync-jbook-performers.ts',
  'scripts/parse-pdoc-army.ts',
  'scripts/load-pdoc-enrichment.ts',
  'scripts/load-om.ts',
  'scripts/load-om-op5.ts',
  'scripts/parse-hasc-sasc-reports.ts',
  'scripts/parse-defense-approps-reports.ts',
  'scripts/parse-ndaa-conference.ts',
  'scripts/parse-defense-approps-public-law.ts',
  'scripts/ingest-defense-budget-pdf.ts',
  'scripts/load-defense-budget-package.ts',
  // PE operational writers / drains / matchers
  'scripts/drain-pe-change-outbox.ts',
  'scripts/backfill-pe-observation-keys.ts',
  'scripts/sync-sam-opportunities.ts',
  'scripts/sam-opportunity-matcher.ts',
  'scripts/send-pe-alert-emails.ts',
  'scripts/run-pe-derive-chain.ts',
  // PE trust gates / diagnostics / accuracy (read-mostly)
  'scripts/diag-program-element-trust-baseline.ts',
  'scripts/measure-accuracy.ts',
  'scripts/verify-pe-phase-a-safety.ts',
  'scripts/verify-pe-phase-e-exact-sha.ts',
  'scripts/verify-pe-phase-k.ts',
  'scripts/lint-pe-scripts.ts',
  'scripts/verify-pe-migration-guards.ts',
  'scripts/verify-pe-phase-9.ts',
  'scripts/verify-pe-phase-10.ts',
] as const;

export type PeProductionScript = (typeof PE_PRODUCTION_SCRIPTS)[number];

/** Pure helpers the PE script typecheck must include so loaders resolve. */
export const PE_PRODUCTION_SCRIPT_HELPERS = [
  'scripts/lib/pe-production-scripts.ts',
  'scripts/lib/pe-exact-sha-loader-contract.ts',
  'scripts/lib/defense-budget-commit.ts',
  'scripts/lib/defense-budget-ingest-mode.ts',
  'scripts/lib/pe-ingestion-mode.spec.ts',
  'scripts/lib/pe-trust-diagnostics.ts',
  'scripts/lib/pe-trust-diagnostics.spec.ts',
  'scripts/lib/pe-migration-guards.ts',
  'scripts/lib/pe-migration-guards.spec.ts',
  'scripts/lib/pe-phase-9-rehearsal-catalog.ts',
  'scripts/lib/pe-phase-9-rehearsal.ts',
  'scripts/lib/pe-phase-9-rehearsal.spec.ts',
  'scripts/lib/pe-phase-10-staging-acceptance-catalog.ts',
  'scripts/lib/pe-phase-10-staging-acceptance.ts',
  'scripts/lib/pe-phase-10-staging-acceptance.spec.ts',
  'scripts/lib/pe-production-scripts.spec.ts',
  'scripts/lib/pe-phase-a-safety.spec.ts',
  'scripts/audit-llamaparse-pe-units.ts',
] as const;

export function peProductionScriptBasenames(): string[] {
  return PE_PRODUCTION_SCRIPTS.map((p) => p.replace(/^scripts\//, ''));
}
