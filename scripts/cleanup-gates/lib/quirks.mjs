/**
 * Documented runner/setup quirks — FULL SCOPE, not passing exclusions.
 *
 * CleanUp1 requires every current runner to be inside the safety foundation.
 * Some packages invoke a runner through a bespoke command that carries no
 * runner token, or require a build/setup step before the runner is meaningful.
 * Those are NOT allowed to silently drop out of scope: each is registered here
 * with its command, why discovery cannot classify it, and how the gate still
 * exercises it. If a package's `test` script contains an unclassified segment
 * that is NOT registered here, the gate fails closed (a new bespoke runner must
 * be triaged, not ignored).
 *
 * This list is deliberately tiny and must stay in sync with source; the guard
 * config test asserts every entry still matches a live package script.
 */

/**
 * A `test` (or `test:*`) segment discovery cannot classify, but which turbo
 * runs. Kept EMPTY on purpose: the former infra/cdk constructs driver is now
 * classified natively by NATIVE_RUNNER_ADAPTERS in lib/discovery.mjs (with a
 * real node:test report adapter), so no bespoke runner is waived as unsupported.
 * If a new bespoke runner appears, the gate fails closed here until it is either
 * natively classified or explicitly triaged.
 */
export const UNCLASSIFIED_RUNNER_QUIRKS = [];

/**
 * Environment / setup facts that change HOW a suite runs. Recorded as explicit
 * scope so nobody later reads a green gate as "these were never conditional".
 * These do not exempt anything — the gate still runs the suites; this is the
 * provenance other reviewers and later phases key off.
 */
export const SETUP_NOTES = [
  {
    subject: '@capiro/defense-api',
    note: 'node:test suite (`tsx --test src/**/*.spec.ts`) spawns scripts/job.mjs which requires apps/defense-api/dist output; the package must be built (turbo `test` dependsOn `^build` and the package build runs `prisma:generate` + nest build) before its suite is meaningful.',
  },
  {
    subject: '@capiro/api / @capiro/workspace',
    note: 'A subset of ESM specs needs `--experimental-vm-modules` on this host (memory-phase2-* contracts, attachment-section-extract, hillday-export .cjs chunk resolver). These are tracked as a baseline repair packet; the gate runs the package’s own jest config unchanged and does not weaken parsing.',
  },
  {
    subject: '@capiro/api / @capiro/intel-api',
    note: 'Postgres-backed specs are guarded by a disposable-Postgres env contract. Without it they FAIL (intel-api is unguarded) rather than skip; the gate preserves the natural failure surface and never adds skip guards.',
  },
  {
    subject: 'apps/defense-budget-parser',
    note: 'pytest collection is collection evidence only (`--collect-only`); execution results come from the real pytest run in the python phase.',
  },
];
