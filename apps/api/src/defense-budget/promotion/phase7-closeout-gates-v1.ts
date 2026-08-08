/**
 * Phase 7 Workstream O — permanent architecture gates and the negative-control
 * registry.
 *
 * ---------------------------------------------------------------------------
 * Why the scan is scoped rather than flat
 * ---------------------------------------------------------------------------
 *
 * Phase 6's gate scans one set of files against one rule list, because every
 * Phase 6 rule is of the form "no stage extractor may ever do X". Phase 7's
 * rules are *directional*: the promotion module may not call a paid parser, but
 * the parser module may — it is the parser. The parser may not import promotion,
 * but promotion imports parser vocabulary all the time.
 *
 * A flat scan would therefore either miss the violation that matters (by only
 * checking the promotion tree) or fire on legitimate code (by checking
 * everything). So every rule declares the scope it polices, and the runner feeds
 * each file the rules for its scope.
 *
 * ---------------------------------------------------------------------------
 * Why the money rule bans `.toNumber()` and `parseFloat`, not `Number()`
 * ---------------------------------------------------------------------------
 *
 * The invariant is "no JavaScript floating-point money", not "no floats". The
 * promotion module legitimately calls `Number()` on fiscal years, row counts,
 * and a materiality *score* — none of which are money, and all of which would
 * fire a blanket ban. What actually converts money to a float is
 * `Decimal.toNumber()` (Prisma money column straight to a double) and
 * `parseFloat` on a decimal string. Those two are banned, and both are already
 * absent from production source — `manual-override-repository-prisma-v1.ts`
 * mentions `.toNumber()` only in a comment telling you not to use it, and
 * comments are stripped before the scan.
 *
 * A gate that fires on correct code gets weakened by whoever hits it next. The
 * narrow rule is the durable one.
 */

/**
 * The 32 mandatory negative controls of plan §O.8, in plan order. The runner
 * asserts the count so a control cannot be quietly dropped, and asserts every ID
 * is exercised so one cannot be listed but never run.
 */
export const PHASE7_NEGATIVE_CONTROL_IDS = [
  'verification_pass_used_without_promotion_authorization',
  'review_acceptance_used_without_promotion_authorization',
  'authorizer_equals_reviewer',
  'expired_authorization',
  'reused_authorization',
  'plan_hash_mismatch',
  'mapping_hash_mismatch',
  'stale_expected_active_snapshot',
  'superseded_candidate_included',
  'rejected_assertion_included',
  'cycle_certification_missing',
  'open_blocking_conflict_ignored',
  'field_authority_swapped',
  'native_identity_conflated',
  'title_only_binding_promoted',
  'money_converted_through_javascript_float',
  'unsupported_mapping_silently_dropped',
  'duplicate_natural_key_last_wins',
  'partial_staged_snapshot_exposed',
  'snapshot_activated_before_required_scopes_complete',
  'concurrent_activation_succeeds_twice',
  'api_serve_role_writes_canonical_row',
  'scheduled_ingestion_role_writes_canonical_row',
  'promoter_task_uses_master_db_credentials',
  'alert_emitted_before_activation_commit',
  'outbox_duplicate_emits_twice',
  'baseline_hydration_sends_client_alerts',
  'correction_sends_unsuppressed_alerts',
  'rollback_deletes_historical_snapshot',
  'manual_override_silently_overwritten',
  'legacy_commit_path_still_writes',
  'snapshot_legacy_read_mismatch_ignored',
] as const;
export type Phase7NegativeControlId = (typeof PHASE7_NEGATIVE_CONTROL_IDS)[number];

export const PHASE7_NEGATIVE_CONTROL_COUNT = 32;

/** Which body of source a rule polices. */
export const PHASE7_GATE_SCOPE_V1_VALUES = [
  /** `src/defense-budget/promotion/**` — the promotion engine itself. */
  'promotion',
  /** `src/defense-budget/parser-router/**`, `.../verification/**`. */
  'parser_verifier',
  /** Legacy budget loader scripts that predate the promotion workflow. */
  'legacy_loader',
  /** `src/program-element/**` read services and controllers. */
  'serve_read',
] as const;
export type Phase7GateScopeV1 = (typeof PHASE7_GATE_SCOPE_V1_VALUES)[number];

export interface Phase7ArchitectureViolationV1 {
  code: string;
  message: string;
}

export interface Phase7ScanInputV1 {
  scope: Phase7GateScopeV1;
  /** Package-relative path, POSIX separators. Used by file-allowlisted rules. */
  relativePath: string;
  source: string;
}

/**
 * The activation pointer has exactly one writer. Any other file issuing DML
 * against `defense_budget_active_snapshot` is bypassing the transaction that
 * checks the expected previous snapshot — which is the entire safety property of
 * activation.
 */
const ACTIVE_SNAPSHOT_WRITER_ALLOWLIST = new Set([
  'src/defense-budget/promotion/canonical-promotion-repository-prisma-v1.ts',
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

interface Phase7RuleV1 {
  code: string;
  scopes: readonly Phase7GateScopeV1[];
  pattern: RegExp;
  message: string;
  /** Files exempt from this rule, by package-relative POSIX path. */
  allowlist?: ReadonlySet<string>;
}

const RULES: readonly Phase7RuleV1[] = [
  {
    code: 'parser_verifier_imports_promotion',
    scopes: ['parser_verifier'],
    pattern: /from\s+['"][^'"]*defense-budget\/promotion\/|require\(['"][^'"]*promotion\//,
    message:
      'the parser and verifier may not import the promotion module — verification is not promotion, and an import is how that separation erodes',
  },
  {
    code: 'serve_instantiates_promoter_repository',
    scopes: ['serve_read', 'legacy_loader'],
    pattern:
      /\bnew\s+(?:Prisma)?CanonicalPromotionRepository\w*\s*\(|\bPROMOTER_DATABASE_URL\b|\bcapiro_pe_promoter\b/,
    message:
      'the general API serve path may not construct the promoter repository or read the promoter credential; promotion runs only as a dedicated one-off task',
  },
  {
    code: 'legacy_loader_writes_canonical_snapshot',
    scopes: ['legacy_loader', 'serve_read'],
    pattern:
      /\bdefenseBudgetCanonical(?:Row|Snapshot|Delta)\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|INSERT\s+INTO\s+["'`]?defense_budget_canonical|UPDATE\s+["'`]?defense_budget_canonical/i,
    message:
      'a legacy budget loader may not write canonical snapshot tables; canonical rows enter only through the promotion workflow',
  },
  {
    code: 'promotion_calls_paid_parser_or_llm',
    scopes: ['promotion'],
    // `llamaparse` as a *string value* is legitimate — `promotion-eligibility-v1.ts`
    // names it as a high-risk extraction method. What is banned is a client or a
    // call, so the rule matches identifiers and member access, never bare words.
    pattern:
      /\b(?:LlamaParseClient|llamaParseClient|AnthropicClient|OpenAIClient|BedrockRuntimeClient)\b|\b(?:paidParser|paidPageVerifier|llamaparseAdapter)\s*\.|from\s+['"][^'"]*(?:@anthropic-ai|openai|@aws-sdk\/client-bedrock)/i,
    message:
      'the promotion path may not call a paid parser or an LLM; it promotes already-verified projections and makes no source-semantic decision',
  },
  {
    code: 'promotion_float_money',
    scopes: ['promotion'],
    pattern: /\.\s*toNumber\s*\(\s*\)|\bparseFloat\s*\(/,
    message:
      'money may not pass through a JavaScript float in promotion, mapping, or planning; keep exact decimal strings',
  },
  {
    code: 'promotion_inline_alert_emission',
    scopes: ['promotion'],
    pattern:
      /\bintelligenceChange\s*\.\s*(?:create|createMany|upsert)\s*\(|\b(?:sendEmail|emitAlert|notifyWatchers|fanOutAlerts)\s*\(/i,
    message:
      'promotion may not emit an alert inline; downstream effects go through the promotion outbox so a commit never depends on their availability',
  },
  {
    code: 'promotion_destructive_rollback',
    scopes: ['promotion'],
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+["'`]?defense_budget_(?:canonical|promotion_activation|rollback_record|active_snapshot)|\bdefenseBudget(?:CanonicalSnapshot|CanonicalRow|PromotionActivation|RollbackRecord)\s*\.\s*(?:delete|deleteMany)\s*\(/i,
    message:
      'rollback is a forward pointer transition; it may not delete a snapshot, a canonical row, or a ledger entry',
  },
  {
    code: 'active_snapshot_mutation_outside_activation',
    scopes: ['promotion', 'serve_read', 'legacy_loader'],
    pattern:
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["'`]?defense_budget_active_snapshot|\bdefenseBudgetActiveSnapshot\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/i,
    message:
      'only the activation repository may move the active-snapshot pointer; any other writer bypasses the expected-previous-snapshot check',
    allowlist: ACTIVE_SNAPSHOT_WRITER_ALLOWLIST,
  },
];

export function scanPhase7ArchitectureSourceV1(
  input: Phase7ScanInputV1,
): Phase7ArchitectureViolationV1[] {
  const code = stripComments(input.source);
  const relativePath = input.relativePath.replace(/\\/g, '/');
  const violations: Phase7ArchitectureViolationV1[] = [];
  for (const rule of RULES) {
    if (!rule.scopes.includes(input.scope)) continue;
    if (rule.allowlist?.has(relativePath)) continue;
    if (rule.pattern.test(code)) {
      violations.push({ code: rule.code, message: rule.message });
    }
  }
  return violations;
}

/** Every rule code, for tests that assert the registry is fully exercised. */
export function phase7GateRuleCodesV1(): string[] {
  return RULES.map((rule) => rule.code);
}

/**
 * A promoter task definition, reduced to the properties Workstream N requires.
 * Checked as data because the CDK synth output is what an operator actually
 * deploys — asserting on the TypeScript that produced it would pass while the
 * deployed task was wrong.
 */
export interface Phase7PromoterTaskDescriptorV1 {
  taskDefinitionName: string;
  databaseSecretName: string;
  /** True when the task is attached to any EventBridge or ECS schedule. */
  scheduled: boolean;
  /** Secret names other than the database secret. */
  attachedSecretNames: readonly string[];
  hasPublicListener: boolean;
  logGroupName: string | null;
}

const MASTER_CREDENTIAL_PATTERN = /master|postgres|root|capiro_app\b/i;
const VENDOR_SECRET_PATTERN = /llamaparse|anthropic|openai|bedrock|parser|llm/i;

export function validatePhase7PromoterTaskV1(
  descriptor: Phase7PromoterTaskDescriptorV1,
): Phase7ArchitectureViolationV1[] {
  const violations: Phase7ArchitectureViolationV1[] = [];
  if (MASTER_CREDENTIAL_PATTERN.test(descriptor.databaseSecretName)) {
    violations.push({
      code: 'promoter_uses_master_credentials',
      message: `promoter database secret ${descriptor.databaseSecretName} looks like a master or serve credential; it must be the dedicated promoter secret`,
    });
  }
  if (descriptor.scheduled) {
    violations.push({
      code: 'promoter_is_scheduled',
      message: 'promotion is never scheduled automatically in V1',
    });
  }
  const vendorSecrets = descriptor.attachedSecretNames.filter((name) =>
    VENDOR_SECRET_PATTERN.test(name),
  );
  if (vendorSecrets.length > 0) {
    violations.push({
      code: 'promoter_carries_vendor_secrets',
      message: `promoter task carries vendor/parser secrets: ${vendorSecrets.join(', ')}`,
    });
  }
  if (descriptor.hasPublicListener) {
    violations.push({
      code: 'promoter_has_public_listener',
      message: 'the promoter task runs in private subnets with no public listener',
    });
  }
  if (descriptor.logGroupName == null || descriptor.logGroupName.length === 0) {
    violations.push({
      code: 'promoter_missing_log_group',
      message: 'the promoter task requires a dedicated log group',
    });
  }
  return violations;
}

export function assertPhase7PromoterTaskV1(descriptor: Phase7PromoterTaskDescriptorV1): void {
  const violations = validatePhase7PromoterTaskV1(descriptor);
  if (violations.length > 0) {
    throw new Error(
      violations.map((violation) => `${violation.code}: ${violation.message}`).join('; '),
    );
  }
}
