/**
 * Phase 7 Workstream O.8 — the 32 mandatory negative controls.
 *
 * Each control writes a real defect into real production source, requires a
 * *named* detector to fail, restores the exact original bytes, and requires the
 * same detector green afterwards. Nothing here is recorded as passing by
 * assertion: a control that cannot make its detector fail is a SAFETY GAP, and
 * the runner exits non-zero.
 *
 * ---------------------------------------------------------------------------
 * Two kinds of detector
 * ---------------------------------------------------------------------------
 *
 * Most controls are caught by a focused jest spec. Four are caught by the
 * architecture scan instead (`verify-pe-budget-phase-7-safety.ts`), because what
 * they prohibit is a *shape* rather than a behaviour — an API serve file that
 * writes a canonical row is wrong even if every test still passes, and no unit
 * test can observe "this file exists and does this". Those four append a
 * statement to a real file rather than replacing one, since the defect is the
 * presence of the call, not a changed decision.
 *
 * ---------------------------------------------------------------------------
 * On mapping controls to guards
 * ---------------------------------------------------------------------------
 *
 * A few of the plan's control names describe a *consequence* rather than a line
 * of code — "verification pass used without promotion authorization" is a
 * system property, not a branch. For those, `rationale` records which guard
 * actually encodes the property and why breaking it produces the named failure.
 * That note is the difference between a control and a box-tick.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceMutationJournal } from './lib/source-mutation-journal.js';
import {
  PHASE7_NEGATIVE_CONTROL_COUNT,
  PHASE7_NEGATIVE_CONTROL_IDS,
  type Phase7NegativeControlId,
} from '../src/defense-budget/promotion/phase7-closeout-gates-v1.js';

const API_ROOT = path.resolve(__dirname, '..');
const JEST_JS = path.join(API_ROOT, 'node_modules', 'jest', 'bin', 'jest.js');
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const P = 'src/defense-budget/promotion';
const ELIG = `${P}/promotion-eligibility-authorization-v1.spec.ts`;
const PLANNER = `${P}/promotion-planner-v1.spec.ts`;
const MAPPING = `${P}/canonical-mapping-registry-v1.spec.ts`;
const ENGINE = `${P}/canonical-promotion-service-v1.spec.ts`;
const DRAIN = `${P}/promotion-outbox-drain-v1.spec.ts`;
const SHADOW = `${P}/shadow-read-comparison-v1.spec.ts`;
const OVERRIDE = `${P}/manual-override-service-v1.spec.ts`;
const LEGACY = `${P}/legacy-budget-write-gate-v1.spec.ts`;
const GATES = `${P}/phase7-closeout-gates-v1.spec.ts`;

/** `safety` runs the architecture scan; anything else is a jest spec path. */
type Detector = { kind: 'jest'; spec: string } | { kind: 'safety' };

interface Control {
  id: Phase7NegativeControlId;
  file: string;
  /** Exact text to find. For `append`, the text is added at end of file. */
  original: string | null;
  defect: string;
  detector: Detector;
  rationale?: string;
}

const jest = (spec: string): Detector => ({ kind: 'jest', spec });
const safety: Detector = { kind: 'safety' };

const AUTHZ = `${P}/promotion-authorization-v1.ts`;
const ELIGIBILITY = `${P}/promotion-eligibility-v1.ts`;
const PLANNER_SRC = `${P}/promotion-planner-v1.ts`;
const MAPPING_SRC = `${P}/canonical-mapping-registry-v1.ts`;
const ENGINE_SRC = `${P}/canonical-promotion-service-v1.ts`;
const DRAIN_SRC = `${P}/promotion-outbox-drain-v1.ts`;
const SHADOW_SRC = `${P}/shadow-read-comparison-v1.ts`;
const OVERRIDE_SRC = `${P}/manual-override-service-v1.ts`;
const LEGACY_SRC = `${P}/legacy-budget-write-gate-v1.ts`;
const GATES_SRC = `${P}/phase7-closeout-gates-v1.ts`;

const ELIGIBLE_STATUS_BLOCK = `  'VERIFICATION_PASSED',
  'REVIEW_ACCEPTED',
] as const;`;

const CONTROLS: Control[] = [
  {
    id: 'verification_pass_used_without_promotion_authorization',
    file: AUTHZ,
    original: 'authorized: refusals.length === 0,',
    defect: 'authorized: true,',
    detector: jest(ELIG),
    rationale:
      'the property is "eligibility never authorizes"; the guard that encodes it is the redemption decision, so forcing it to authorize is exactly a verification pass promoting on its own',
  },
  {
    id: 'review_acceptance_used_without_promotion_authorization',
    file: ELIGIBILITY,
    original: "if (value.status === 'REVIEW_ACCEPTED' && value.reviewDecisionId == null) {",
    defect: 'if (false) {',
    detector: jest(ELIG),
    rationale:
      'a REVIEW_ACCEPTED candidate that names no review decision is a bare flag; admitting it lets review acceptance flow into promotion unrecorded',
  },
  {
    id: 'authorizer_equals_reviewer',
    file: AUTHZ,
    // Two independent enforcements of this property exist: the schema's own
    // `superRefine` (construction time — this one) and `evaluatePromotionAuthorizationV1`
    // (redemption time). The chosen detector (`ELIG` spec, "refuses when the
    // authorizer reviewed the same scope") calls `.parse()` directly, so it
    // exercises the schema, not the redemption function — the injection has to
    // land in the same guard the test actually runs.
    original: 'if (value.segregation.reviewerActorIds.includes(value.authorizerActorId)) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
  },
  {
    id: 'expired_authorization',
    file: AUTHZ,
    original: 'if (context.now.getTime() > Date.parse(authorization.expiresAt)) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
  },
  {
    id: 'reused_authorization',
    file: AUTHZ,
    original: 'if (context.alreadyUsed) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
  },
  {
    id: 'plan_hash_mismatch',
    file: AUTHZ,
    original: 'if (authorization.planHash !== context.planHash) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
  },
  {
    id: 'mapping_hash_mismatch',
    file: AUTHZ,
    original: 'if (authorization.eligibilityHash !== context.eligibilityHash) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
    rationale:
      'the mapping-registry version and hash are eligibility facts, so the eligibility-hash binding is the guard a changed mapping registry trips',
  },
  {
    id: 'stale_expected_active_snapshot',
    file: AUTHZ,
    original: 'if (authorization.expectedActiveSnapshotId !== context.actualActiveSnapshotId) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
  },
  {
    id: 'superseded_candidate_included',
    file: ELIGIBILITY,
    original: ELIGIBLE_STATUS_BLOCK,
    defect: `  'VERIFICATION_PASSED',
  'REVIEW_ACCEPTED',
  'SUPERSEDED',
] as const;`,
    detector: jest(ELIG),
  },
  {
    id: 'rejected_assertion_included',
    file: ELIGIBILITY,
    original: ELIGIBLE_STATUS_BLOCK,
    defect: `  'VERIFICATION_PASSED',
  'REVIEW_ACCEPTED',
  'REJECTED',
] as const;`,
    detector: jest(ELIG),
  },
  {
    id: 'cycle_certification_missing',
    file: ELIGIBILITY,
    // The chosen detector ("blocks when the cycle certification is missing")
    // calls `defenseBudgetPromotionEligibilityV1Schema.parse(...)` directly, so
    // it exercises the field's own `idSetMin1` combinator, not the `if` inside
    // `evaluatePromotionEligibilityV1` (that one is a ZodEffects and can't be
    // re-chained per-field, so the injection widens the shared helper instead —
    // real defect, since it does make an empty `cycleCertificationIds` parse).
    original: `const idSetMin1 = z
  .array(nonBlank)
  .min(1)
  .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b)));`,
    defect: `const idSetMin1 = z
  .array(nonBlank)
  .min(0)
  .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b)));`,
    detector: jest(ELIG),
  },
  {
    id: 'open_blocking_conflict_ignored',
    file: ELIGIBILITY,
    original: 'if (value.openConflictCount > 0) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
  },
  {
    id: 'field_authority_swapped',
    file: MAPPING_SRC,
    original: 'if (derived !== field) {',
    defect: 'if (false) {',
    detector: jest(MAPPING),
  },
  {
    id: 'native_identity_conflated',
    file: MAPPING_SRC,
    original: "naturalKeyFields: ['component', 'account', 'lineCode', 'advanceProcurement'],",
    defect: "naturalKeyFields: ['lineCode'],",
    detector: jest(MAPPING),
    rationale:
      'dropping the account namespace and the base/advance axis makes the same short line number under two accounts one canonical line',
  },
  {
    id: 'title_only_binding_promoted',
    file: MAPPING_SRC,
    original: "naturalKeyFields: ['component', 'account', 'lineCode', 'advanceProcurement'],",
    defect: "naturalKeyFields: ['component', 'account', 'title', 'advanceProcurement'],",
    detector: jest(MAPPING),
    rationale:
      'admitting a title into a natural key is how a title-only match becomes a canonical identity',
  },
  {
    id: 'money_converted_through_javascript_float',
    file: OVERRIDE_SRC,
    original: 'if (!isCanonicalDecimalString(value)) {',
    defect: 'if (false) {',
    detector: jest(OVERRIDE),
  },
  {
    id: 'unsupported_mapping_silently_dropped',
    file: ELIGIBILITY,
    original: 'if (value.unsupportedItemCount > 0) {',
    defect: 'if (false) {',
    detector: jest(ELIG),
  },
  {
    id: 'duplicate_natural_key_last_wins',
    file: PLANNER_SRC,
    original: 'if (bucket.length < 2) continue;',
    defect: 'if (bucket.length < 99) continue;',
    detector: jest(PLANNER),
    rationale:
      'never entering the duplicate branch is precisely last-wins: the final write for a key silently survives',
  },
  {
    id: 'partial_staged_snapshot_exposed',
    file: ENGINE_SRC,
    original: "if (request.executionMode === 'dry_run') {",
    defect: 'if (false) {',
    detector: jest(ENGINE),
    rationale:
      'a dry run that activates publishes rows an operator believed were staged-only — the exact shape of exposing a partial snapshot',
  },
  {
    id: 'snapshot_activated_before_required_scopes_complete',
    file: ENGINE_SRC,
    original: 'const missingScopes = requiredScopes.filter((scope) => !coveredScopes.has(scope));',
    defect: 'const missingScopes: string[] = [];',
    detector: jest(ENGINE),
  },
  {
    id: 'concurrent_activation_succeeds_twice',
    file: ENGINE_SRC,
    original: 'const priorActivation = await this.repository.findActivationByKey(activationKey);',
    defect: 'const priorActivation = null;',
    detector: jest(ENGINE),
    rationale:
      'the exactly-once property is the ledger lookup; without it a second run activates the same key again',
  },
  {
    id: 'api_serve_role_writes_canonical_row',
    file: 'src/program-element/program-element-read.service.ts',
    original: null,
    defect:
      '\nexport const __nc22Probe = (p: { defenseBudgetCanonicalRow: { createMany: (a: unknown) => unknown } }) =>\n  p.defenseBudgetCanonicalRow.createMany({ data: [] });\n',
    detector: safety,
  },
  {
    id: 'scheduled_ingestion_role_writes_canonical_row',
    file: 'scripts/sync-comptroller-jbooks.ts',
    original: null,
    defect:
      '\nexport const __nc23Probe = (p: { defenseBudgetCanonicalRow: { upsert: (a: unknown) => unknown } }) =>\n  p.defenseBudgetCanonicalRow.upsert({ where: {}, create: {}, update: {} });\n',
    detector: safety,
  },
  {
    id: 'promoter_task_uses_master_db_credentials',
    file: GATES_SRC,
    original: 'const MASTER_CREDENTIAL_PATTERN = /master|postgres|root|capiro_app\\b/i;',
    defect: 'const MASTER_CREDENTIAL_PATTERN = /^(?!)/;',
    detector: jest(GATES),
  },
  {
    id: 'alert_emitted_before_activation_commit',
    file: `${P}/snapshot-row-grouping-v1.ts`,
    original: null,
    defect:
      '\nexport const __nc25Probe = async (to: string, body: string) => {\n  await sendEmail(to, body);\n};\ndeclare function sendEmail(to: string, body: string): Promise<void>;\n',
    detector: safety,
    rationale:
      'an inline alert call anywhere in the promotion module means a canonical commit can depend on downstream availability',
  },
  {
    id: 'outbox_duplicate_emits_twice',
    file: DRAIN_SRC,
    original: "if (input.status === 'DONE' || input.status === 'POISON') return false;",
    defect: "if (input.status === 'POISON') return false;",
    detector: jest(DRAIN),
    rationale:
      'a DONE row that becomes claimable again is published a second time — the duplicate emit the dedupe key exists to prevent',
  },
  {
    id: 'baseline_hydration_sends_client_alerts',
    file: PLANNER_SRC,
    original: "if (input.mode === 'baseline_hydration') return 'suppressed_hydration';",
    defect: "if (false) return 'suppressed_hydration';",
    detector: jest(PLANNER),
  },
  {
    id: 'correction_sends_unsuppressed_alerts',
    file: PLANNER_SRC,
    original: "if (input.mode === 'correction') return 'suppressed_correction';",
    defect: "if (false) return 'suppressed_correction';",
    detector: jest(PLANNER),
  },
  {
    id: 'rollback_deletes_historical_snapshot',
    file: `${P}/canonical-delta-engine-v1.ts`,
    original: null,
    defect:
      '\nexport const __nc29Probe = async (c: { query: (sql: string) => Promise<unknown> }) =>\n  c.query(`DELETE FROM defense_budget_canonical_snapshot WHERE id = $1`);\n',
    detector: safety,
    rationale:
      'rollback is a forward pointer transition; any DELETE against snapshot history is the destructive rollback the gate bans',
  },
  {
    id: 'manual_override_silently_overwritten',
    file: PLANNER_SRC,
    original: "(operation === 'SUPERSEDE' || operation === 'CORRECTION') &&",
    defect: 'false &&',
    detector: jest(PLANNER),
  },
  {
    id: 'legacy_commit_path_still_writes',
    file: LEGACY_SRC,
    original: 'if (legacyWritesUnsafeInModeV1(readMode)) {',
    defect: 'if (false) {',
    detector: jest(LEGACY),
  },
  {
    id: 'snapshot_legacy_read_mismatch_ignored',
    file: SHADOW_SRC,
    original: "return severity === 'p0' || severity === 'p1';",
    defect: 'return false;',
    detector: jest(SHADOW),
  },
];

interface RunOutcome {
  passed: boolean;
  output: string;
}

function runDetector(detector: Detector): RunOutcome {
  const result =
    detector.kind === 'jest'
      ? spawnSync(
          process.execPath,
          [JEST_JS, '--runInBand', '--forceExit', '--silent', detector.spec],
          { cwd: API_ROOT, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
        )
      : spawnSync(
          process.execPath,
          [
            path.join(API_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
            'scripts/verify-pe-budget-phase-7-safety.ts',
          ],
          { cwd: API_ROOT, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
        );
  return {
    passed: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** Map an LF needle onto the file's actual newline style (CRLF checkouts). */
function withFileNewlines(source: string, needle: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return needle.replace(/\r\n/g, '\n').split('\n').join(eol);
}

interface Result {
  id: string;
  detected: boolean;
  restoredGreen: boolean;
  detail: string;
}

const journal = new SourceMutationJournal({ root: API_ROOT, directoryName: '.p7-nc-restore' });
journal.recoverAbandoned();

const results: Result[] = [];

for (const control of CONTROLS) {
  const absolute = path.join(API_ROOT, control.file);
  if (!fs.existsSync(absolute)) {
    results.push({
      id: control.id,
      detected: false,
      restoredGreen: false,
      detail: `target file missing: ${control.file}`,
    });
    continue;
  }
  const originalBytes = fs.readFileSync(absolute);
  try {
    journal.record(control.id, control.file, originalBytes);
    const source = originalBytes.toString('utf8');

    let mutated: string;
    if (control.original == null) {
      mutated = source + withFileNewlines(source, control.defect);
    } else {
      const needle = withFileNewlines(source, control.original);
      if (!source.includes(needle)) {
        results.push({
          id: control.id,
          detected: false,
          restoredGreen: false,
          detail: `SAFETY GAP: injection point missing in ${control.file}`,
        });
        continue;
      }
      mutated = source.replace(needle, withFileNewlines(source, control.defect));
    }
    fs.writeFileSync(absolute, mutated, 'utf8');

    const injected = runDetector(control.detector);
    fs.writeFileSync(absolute, originalBytes);
    const restored = runDetector(control.detector);

    results.push({
      id: control.id,
      detected: !injected.passed,
      restoredGreen: restored.passed,
      detail: !injected.passed
        ? restored.passed
          ? `defect failed ${control.detector.kind === 'jest' ? control.detector.spec : 'the architecture scan'}; exact bytes restored and it returned green`
          : `defect detected, but the restored detector failed: ${restored.output.slice(-800)}`
        : `SAFETY GAP: injected defect passed: ${injected.output.slice(-800)}`,
    });
  } finally {
    fs.writeFileSync(absolute, originalBytes);
    if (!fs.readFileSync(absolute).equals(originalBytes)) {
      throw new Error(`${control.id}: byte-for-byte restore of ${control.file} failed`);
    }
    // Only after the restore is verified byte-for-byte.
    journal.clear();
  }
}

/* ---- Reporting ---- */

console.log('Phase 7 — 32 mandatory negative controls');
console.log('========================================');
let allPassed = true;
for (const result of results) {
  const passed = result.detected && result.restoredGreen;
  allPassed &&= passed;
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${result.id}`);
  console.log(`       ${result.detail}`);
}

const passedCount = results.filter((r) => r.detected && r.restoredGreen).length;
console.log(`\n${passedCount}/${CONTROLS.length} controls passed`);

const covered = new Set(CONTROLS.map((control) => control.id));
const uncovered = PHASE7_NEGATIVE_CONTROL_IDS.filter((id) => !covered.has(id));
if (uncovered.length > 0) {
  console.error(`\nregistry IDs with no control: ${uncovered.join(', ')}`);
  allPassed = false;
}
if (CONTROLS.length !== PHASE7_NEGATIVE_CONTROL_COUNT) {
  console.error(`\ncontrol count is ${CONTROLS.length}, expected ${PHASE7_NEGATIVE_CONTROL_COUNT}`);
  allPassed = false;
}

if (!allPassed || results.length !== CONTROLS.length) {
  console.error('\nPhase 7 negative controls FAILED');
  process.exit(1);
}
console.log('\nAll Phase 7 negative controls passed');
process.exit(0);
