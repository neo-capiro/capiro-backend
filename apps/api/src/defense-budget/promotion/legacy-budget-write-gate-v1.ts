/**
 * Phase 7 Workstream M — the legacy canonical-write kill switch.
 *
 * Plan §M.12: a runtime kill switch defaulting legacy budget writes **off**.
 * Plan §M.14: the dispatcher's budget verbs keep their inspect behaviour and
 * refuse a canonical `--commit`.
 *
 * ---------------------------------------------------------------------------
 * Why the switch lives at the operational entry points
 * ---------------------------------------------------------------------------
 *
 * The obvious place is inside `ProgramElementWriterService`, and that is the
 * wrong place. That service is the shared write path for ordinary product
 * behaviour, not only for budget loading — putting a default-off gate inside it
 * would refuse writes the product still legitimately makes, and would do it
 * during Workstream M rather than at the rollout's freeze step.
 *
 * "Direct legacy canonical writes" are a set of *operator actions*: twelve
 * dispatcher verbs that load, rebuild, or repair canonical budget rows with no
 * verification binding. Those are what the plan freezes, and the entry point is
 * where a refusal can also say what to do instead. So this module is the policy,
 * the dispatcher is one enforcement point, and a script that wants the same
 * check can call `legacyBudgetCommitDecisionV1` directly.
 *
 * ---------------------------------------------------------------------------
 * The read mode can veto, and cannot be vetoed
 * ---------------------------------------------------------------------------
 *
 * `PE_LEGACY_BUDGET_WRITES=allow` is the deliberate operator override. It is not
 * absolute: once any tenant is served from a snapshot, a legacy writer mutating
 * the compatibility tables underneath produces a divergence indistinguishable
 * from a promotion defect, and the shadow dashboard an operator is using to
 * decide whether to proceed becomes untrustworthy. So a snapshot or canary read
 * mode refuses the write regardless of the override, and says which of the two
 * reasons applied.
 */
import { legacyWritesUnsafeInModeV1, type SnapshotReadModeV1 } from './snapshot-read-mode-v1.js';

export const LEGACY_BUDGET_WRITE_MODE_V1_VALUES = ['off', 'allow'] as const;
export type LegacyBudgetWriteModeV1 = (typeof LEGACY_BUDGET_WRITE_MODE_V1_VALUES)[number];

/** Off. A legacy canonical budget write is an exception now, not the default. */
export const DEFAULT_LEGACY_BUDGET_WRITE_MODE_V1: LegacyBudgetWriteModeV1 = 'off';

export const LEGACY_BUDGET_WRITE_ENV_VAR_V1 = 'PE_LEGACY_BUDGET_WRITES';

/**
 * The dispatcher verbs that write canonical budget rows directly.
 *
 * Taken from the Workstream M containment inventory in
 * `docs/defense-budget/PHASE-7-PRE-IMPLEMENTATION-DEPENDENCY-MAP.md` §3, filtered
 * to those the dispatcher actually exposes. `rebuild-program-element-years` is
 * in that inventory and deliberately absent here: it has no dispatcher verb, so
 * it is reachable only as a direct `tsx` invocation and the database grant is its
 * containment rather than this list.
 *
 * The alert emitters — `emit-changes`, `emit-bill-alerts`,
 * `emit-committee-changes`, `send-pe-alert-emails` — are also absent. They
 * publish rather than write canonical rows, and they are frozen by the rollout's
 * own final step ("enable approved alert fan-out") rather than by this switch.
 */
export const LEGACY_BUDGET_DISPATCHER_VERBS_V1 = [
  'backfill-appropriation-type',
  'derive-budget-actions',
  'ingest-defense-budget',
  'load-om',
  'load-om-op5',
  'load-pdoc-enrichment',
  'match-pe-mentions',
  'reconcile-stale-pes',
  'repair-pe-thousands-as-millions',
  'seed-demo-client',
  'sync-jbook-r2',
  'watch-budget-docs',
] as const;
export type LegacyBudgetDispatcherVerbV1 = (typeof LEGACY_BUDGET_DISPATCHER_VERBS_V1)[number];

export type LegacyBudgetCommitDecisionV1 =
  | { allowed: true; reason: 'inspect_only' | 'operator_override' }
  | {
      allowed: false;
      reason: 'kill_switch_off' | 'snapshot_reads_active';
      message: string;
    };

/** The refusal an operator reads. Says what to do instead, not just no. */
function refusalMessage(verb: string, reason: 'kill_switch_off' | 'snapshot_reads_active'): string {
  const why =
    reason === 'snapshot_reads_active'
      ? 'product reads are being served from a canonical snapshot, so a legacy write here would diverge from what clients see'
      : `the Phase 7 legacy-write kill switch is off (${LEGACY_BUDGET_WRITE_ENV_VAR_V1})`;
  const override =
    reason === 'snapshot_reads_active'
      ? 'This cannot be overridden while snapshot reads are active; move the read mode back to legacy or shadow first.'
      : `Set ${LEGACY_BUDGET_WRITE_ENV_VAR_V1}=allow to override deliberately.`;
  return [
    `REFUSED: '${verb} --commit' writes canonical budget data directly, and ${why}.`,
    'Canonical budget data now enters through the promotion workflow, which binds every row to a verified projection, a plan hash, and an independent authorization:',
    '  plan-defense-budget-promotion-v1 → validate → authorize → execute',
    `Re-run without --commit to inspect. ${override}`,
  ].join('\n');
}

/**
 * Whether this invocation may commit.
 *
 * An invocation with no `--commit` is always allowed: plan §M.14 keeps inspect
 * and extract behaviour, and taking that away would leave an operator no way to
 * see what a loader *would* do — which is the first thing anyone asks when a
 * promotion and a legacy loader disagree.
 */
export function legacyBudgetCommitDecisionV1(input: {
  verb: string;
  argv: readonly string[];
  writeMode?: LegacyBudgetWriteModeV1;
  readMode?: SnapshotReadModeV1;
}): LegacyBudgetCommitDecisionV1 {
  const wantsCommit = input.argv.includes('--commit');
  if (!wantsCommit) return { allowed: true, reason: 'inspect_only' };

  const readMode = input.readMode ?? 'legacy';
  if (legacyWritesUnsafeInModeV1(readMode)) {
    return {
      allowed: false,
      reason: 'snapshot_reads_active',
      message: refusalMessage(input.verb, 'snapshot_reads_active'),
    };
  }

  const writeMode = input.writeMode ?? DEFAULT_LEGACY_BUDGET_WRITE_MODE_V1;
  if (writeMode !== 'allow') {
    return {
      allowed: false,
      reason: 'kill_switch_off',
      message: refusalMessage(input.verb, 'kill_switch_off'),
    };
  }

  return { allowed: true, reason: 'operator_override' };
}

/** Parse the env var, treating anything unrecognized as off. */
export function legacyBudgetWriteModeFromEnvV1(value: string | undefined): LegacyBudgetWriteModeV1 {
  // Fails closed on a typo. `PE_LEGACY_BUDGET_WRITES=allowed` must not enable
  // canonical writes because it looked close enough.
  return value === 'allow' ? 'allow' : 'off';
}
