/**
 * defense_budget_route_planner_v1 — deterministic route and escalation planner.
 *
 * Converts manifest policy, page profiles, prior parser outcomes, and Phase 2
 * findings into a deterministic parser plan.
 *
 * Same inputs always produce the same plan and IDs. No infinite loop.
 * No repeated parser run. No missing-finding page guess.
 * Paid pages are explicit and bounded.
 */
import { z } from 'zod';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import {
  DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
  pageRangeKey,
  computeParserRunId,
  computeParserConfigSha256,
} from './parser-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import type { ParserPolicyV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { PageProfileV1 } from './page-profiler.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* C1. Parse plan contract                                            */
/* ------------------------------------------------------------------ */

export const parserPlanStepV1Schema = z
  .object({
    stepId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    engine: z.enum([
      'native_structured',
      'deterministic_pdfplumber',
      'camelot',
      'docling',
      'paddleocr',
      'llamaparse',
      'manual',
    ]),
    pages: z.array(z.number().int().positive()),
    reasonCodes: z.array(z.string().min(1)),
    dependsOnStepIds: z.array(z.string().min(1)),
    paid: z.boolean(),
    terminalIfSuccessful: z.boolean(),
  })
  .strict();
export type ParserPlanStepV1 = z.infer<typeof parserPlanStepV1Schema>;

export const defenseBudgetParsePlanV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION),
    executionId: z.string().min(1),
    cycleId: z.string().min(1),
    manifestDocumentKey: z.string().min(1),
    sourceSha256: sha256Schema,
    parserPolicy: z.enum([
      'native_structured',
      'deterministic_table',
      'mixed_layout',
      'ocr',
      'complex',
    ]),
    steps: z.array(parserPlanStepV1Schema),
    paidAuthorizationRequired: z.boolean(),
    plannedPaidPages: z.array(z.number().int().positive()),
    unresolvedPages: z.array(z.number().int().positive()),
    planSha256: sha256Schema,
  })
  .strict();
export type DefenseBudgetParsePlanV1 = z.infer<typeof defenseBudgetParsePlanV1Schema>;

/* ------------------------------------------------------------------ */
/* C2. Parser-correctable finding adapter                             */
/* ------------------------------------------------------------------ */

export const parserCorrectableFindingV1Schema = z
  .object({
    findingCode: z.string().min(1),
    assertionIds: z.array(z.string().min(1)),
    sourceFactIds: z.array(z.string().min(1)),
    evidenceIds: z.array(z.string().min(1)),
    pages: z.array(z.number().int().positive()),
    recommendedEngineClass: z.enum(['table', 'layout', 'ocr', 'complex']),
    blocking: z.boolean(),
  })
  .strict();
export type ParserCorrectableFindingV1 = z.infer<typeof parserCorrectableFindingV1Schema>;

/* ------------------------------------------------------------------ */
/* C3. Escalation ladder                                              */
/* ------------------------------------------------------------------ */

/**
 * Default next-engine order for digital pages:
 *   deterministic_pdfplumber -> camelot -> docling -> llamaparse
 */
const DEFAULT_DIGITAL_LADDER: readonly ExtractionMethodV1[] = [
  'deterministic_pdfplumber',
  'camelot',
  'docling',
  'llamaparse',
];

/**
 * For image-only pages:
 *   paddleocr -> docling -> llamaparse
 */
const IMAGE_ONLY_LADDER: readonly ExtractionMethodV1[] = [
  'paddleocr',
  'docling',
  'llamaparse',
];

/**
 * For mixed layout:
 *   docling -> camelot -> llamaparse
 */
const MIXED_LAYOUT_LADDER: readonly ExtractionMethodV1[] = [
  'docling',
  'camelot',
  'llamaparse',
];

/**
 * Maps a recommended engine class from a finding to the appropriate ladder.
 */
function ladderForEngineClass(
  engineClass: 'table' | 'layout' | 'ocr' | 'complex',
): readonly ExtractionMethodV1[] {
  switch (engineClass) {
    case 'ocr':
      return IMAGE_ONLY_LADDER;
    case 'layout':
      return MIXED_LAYOUT_LADDER;
    case 'table':
      return DEFAULT_DIGITAL_LADDER;
    case 'complex':
      return MIXED_LAYOUT_LADDER;
  }
}

/**
 * Maps a page profile to the initial engine for a given policy.
 */
function initialEngineForPolicy(
  policy: ParserPolicyV1,
  profile: PageProfileV1,
): ExtractionMethodV1 {
  // Image-only pages always start with OCR unless policy is native_structured
  if (profile.likelyImageOnly) {
    return 'paddleocr';
  }

  switch (policy) {
    case 'native_structured':
      // Should not reach here — native_structured requires companion file
      return 'deterministic_pdfplumber';
    case 'deterministic_table':
      return 'deterministic_pdfplumber';
    case 'mixed_layout':
      return 'docling';
    case 'ocr':
      return 'paddleocr';
    case 'complex':
      // Use Docling for digital, PaddleOCR for image-only (handled above)
      return profile.likelyTablePage ? 'deterministic_pdfplumber' : 'docling';
  }
}

/* ------------------------------------------------------------------ */
/* C4. Initial plan builder                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_MAX_ESCALATION_ROUNDS = 4;

/**
 * Build the initial parse plan from manifest policy and page profiles.
 *
 * No paid calls are planned in the initial plan.
 * The initial plan is local-only.
 */
export function buildInitialParsePlan(input: {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  sourceSha256: string;
  parserPolicy: ParserPolicyV1;
  pageProfiles: readonly PageProfileV1[];
  maxEscalationRounds?: number;
}): DefenseBudgetParsePlanV1 {
  const maxRounds = input.maxEscalationRounds ?? DEFAULT_MAX_ESCALATION_ROUNDS;

  // Group pages by initial engine
  const engineGroups = new Map<ExtractionMethodV1, number[]>();

  for (const profile of input.pageProfiles) {
    const engine = initialEngineForPolicy(input.parserPolicy, profile);
    const pages = engineGroups.get(engine) ?? [];
    pages.push(profile.page);
    engineGroups.set(engine, pages);
  }

  // Build steps
  const steps: ParserPlanStepV1[] = [];
  let ordinal = 0;

  for (const [engine, pages] of engineGroups) {
    const sortedPages = [...pages].sort((a, b) => a - b);
    const stepId = `step-${ordinal}`;
    const configSha = computeParserConfigSha256({
      engine,
      policy: input.parserPolicy,
      maxEscalationRounds: maxRounds,
    });
    steps.push({
      stepId,
      ordinal,
      engine,
      pages: sortedPages,
      reasonCodes: ['initial_plan'],
      dependsOnStepIds: [],
      paid: false,
      terminalIfSuccessful: false,
    });
    ordinal++;
  }

  const planWithoutHash: Omit<DefenseBudgetParsePlanV1, 'planSha256'> = {
    schemaVersion: DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
    executionId: input.executionId,
    cycleId: input.cycleId,
    manifestDocumentKey: input.manifestDocumentKey,
    sourceSha256: input.sourceSha256,
    parserPolicy: input.parserPolicy,
    steps,
    paidAuthorizationRequired: false,
    plannedPaidPages: [],
    unresolvedPages: [],
  };

  const planSha256 = sha256CanonicalJson(planWithoutHash as unknown as JsonValue);

  return { ...planWithoutHash, planSha256 };
}

/* ------------------------------------------------------------------ */
/* C5. Escalation plan builder                                        */
/* ------------------------------------------------------------------ */

/**
 * Build an escalation plan from Phase 2 findings.
 *
 * Only parser-correctable findings may trigger parser escalation.
 * If a finding cannot be mapped to a page, leave it terminal/unresolved.
 */
export function buildEscalationPlan(input: {
  executionId: string;
  cycleId: string;
  manifestDocumentKey: string;
  sourceSha256: string;
  parserPolicy: ParserPolicyV1;
  pageProfiles: readonly PageProfileV1[];
  correctableFindings: readonly ParserCorrectableFindingV1[];
  attemptedEnginesByPage: ReadonlyMap<number, readonly ExtractionMethodV1[]>;
  allowPaidParse: boolean;
  maxPaidPages: number;
  maxEscalationRounds?: number;
  currentRound: number;
}): {
  plan: DefenseBudgetParsePlanV1;
  terminal: boolean;
  terminalReason?: string;
} {
  const maxRounds = input.maxEscalationRounds ?? DEFAULT_MAX_ESCALATION_ROUNDS;

  // Check terminal conditions
  if (input.currentRound >= maxRounds) {
    return {
      plan: buildTerminalPlan(input, 'max_escalation_rounds_reached'),
      terminal: true,
      terminalReason: 'max_escalation_rounds_reached',
    };
  }

  if (input.correctableFindings.length === 0) {
    return {
      plan: buildTerminalPlan(input, 'no_correctable_findings'),
      terminal: true,
      terminalReason: 'no_correctable_findings',
    };
  }

  // Map findings to pages and determine next engine for each page
  const pageToNextEngine = new Map<number, ExtractionMethodV1>();
  const pageToReasons = new Map<number, string[]>();

  for (const finding of input.correctableFindings) {
    const ladder = ladderForEngineClass(finding.recommendedEngineClass);

    for (const page of finding.pages) {
      const attempted = input.attemptedEnginesByPage.get(page) ?? [];

      // Find next untried engine on the ladder
      const nextEngine = ladder.find((e) => !attempted.includes(e));

      if (nextEngine) {
        // Don't repeat the same engine
        if (!pageToNextEngine.has(page)) {
          pageToNextEngine.set(page, nextEngine);
          pageToReasons.set(page, [finding.findingCode]);
        } else {
          // Append reason
          const reasons = pageToReasons.get(page) ?? [];
          if (!reasons.includes(finding.findingCode)) {
            reasons.push(finding.findingCode);
          }
        }
      }
      // If no next engine on this ladder, leave terminal/unresolved
    }
  }

  // Split into paid and local steps
  const localGroups = new Map<ExtractionMethodV1, { pages: number[]; reasons: string[] }>();
  const paidPages: number[] = [];

  for (const [page, engine] of pageToNextEngine) {
    const reasons = pageToReasons.get(page) ?? [];
    if (engine === 'llamaparse') {
      paidPages.push(page);
    } else {
      const group = localGroups.get(engine) ?? { pages: [], reasons: [] };
      group.pages.push(page);
      group.reasons.push(...reasons);
      localGroups.set(engine, group);
    }
  }

  // Check paid authorization
  const sortedPaidPages = [...paidPages].sort((a, b) => a - b);
  const paidAuthorized = input.allowPaidParse && sortedPaidPages.length <= input.maxPaidPages;

  if (sortedPaidPages.length > 0 && !paidAuthorized) {
    // Terminal: paid needed but not authorized
    return {
      plan: buildTerminalPlan(input, 'paid_not_authorized', sortedPaidPages),
      terminal: true,
      terminalReason: 'paid_not_authorized',
    };
  }

  // Build steps
  const steps: ParserPlanStepV1[] = [];
  let ordinal = 0;

  // Local steps
  for (const [engine, group] of localGroups) {
    const sortedPages = [...group.pages].sort((a, b) => a - b);
    steps.push({
      stepId: `step-${ordinal}`,
      ordinal,
      engine,
      pages: sortedPages,
      reasonCodes: [...new Set(group.reasons)],
      dependsOnStepIds: [],
      paid: false,
      terminalIfSuccessful: false,
    });
    ordinal++;
  }

  // Paid step
  if (sortedPaidPages.length > 0 && paidAuthorized) {
    steps.push({
      stepId: `step-${ordinal}`,
      ordinal,
      engine: 'llamaparse',
      pages: sortedPaidPages,
      reasonCodes: ['escalation_paid'],
      dependsOnStepIds: steps.filter((s) => !s.paid).map((s) => s.stepId),
      paid: true,
      terminalIfSuccessful: true,
    });
    ordinal++;
  }

  const unresolvedPages = [...pageToNextEngine.keys()]
    .filter((p) => !pageToNextEngine.get(p) || pageToNextEngine.get(p) === 'llamaparse')
    .filter((p) => !paidAuthorized)
    .sort((a, b) => a - b);

  const planWithoutHash: Omit<DefenseBudgetParsePlanV1, 'planSha256'> = {
    schemaVersion: DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
    executionId: input.executionId,
    cycleId: input.cycleId,
    manifestDocumentKey: input.manifestDocumentKey,
    sourceSha256: input.sourceSha256,
    parserPolicy: input.parserPolicy,
    steps,
    paidAuthorizationRequired: sortedPaidPages.length > 0,
    plannedPaidPages: sortedPaidPages,
    unresolvedPages,
  };

  const planSha256 = sha256CanonicalJson(planWithoutHash as unknown as JsonValue);

  return {
    plan: { ...planWithoutHash, planSha256 },
    terminal: false,
  };
}

/* ------------------------------------------------------------------ */
/* C6. Terminal plan helper                                           */
/* ------------------------------------------------------------------ */

function buildTerminalPlan(
  input: {
    executionId: string;
    cycleId: string;
    manifestDocumentKey: string;
    sourceSha256: string;
    parserPolicy: ParserPolicyV1;
  },
  reason: string,
  unresolvedPages: number[] = [],
): DefenseBudgetParsePlanV1 {
  const planWithoutHash: Omit<DefenseBudgetParsePlanV1, 'planSha256'> = {
    schemaVersion: DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
    executionId: input.executionId,
    cycleId: input.cycleId,
    manifestDocumentKey: input.manifestDocumentKey,
    sourceSha256: input.sourceSha256,
    parserPolicy: input.parserPolicy,
    steps: [],
    paidAuthorizationRequired: false,
    plannedPaidPages: [],
    unresolvedPages,
  };

  const planSha256 = sha256CanonicalJson(planWithoutHash as unknown as JsonValue);

  return { ...planWithoutHash, planSha256 };
}

/* ------------------------------------------------------------------ */
/* C7. Helper: determine if a finding is parser-correctable            */
/* ------------------------------------------------------------------ */

/**
 * Finding codes that are parser-correctable and may trigger escalation.
 */
export const PARSER_CORRECTABLE_FINDING_CODES = new Set([
  'missing_required_source_fact',
  'blocking_omission',
  'missing_evidence',
  'parser_run_proof_missing',
  'arithmetic_reconciliation_failed',
  'required_comparison_not_run',
  'page_only_money_requires_reconciliation',
  'parser_warning_requires_review',
  'verification_policy_not_implemented',
]);

/**
 * Finding codes that are NOT parser-correctable and must remain terminal.
 */
export const NON_PARSER_CORRECTABLE_FINDING_CODES = new Set([
  'wrong_manifest_requirements',
  'source_sha_mismatch',
  'artifact_corruption',
  'field_ownership_violation',
  'duplicate_conflicting_assertion',
  'unsupported_canonical_schema',
  'missing_independent_reference_document',
  'review_only_policy',
  'unimplemented_family_extraction',
]);

/**
 * Returns true if a finding code is parser-correctable.
 */
export function isParserCorrectable(code: string): boolean {
  return PARSER_CORRECTABLE_FINDING_CODES.has(code);
}

/* ------------------------------------------------------------------ */
/* C8. Helper: validate plan                                         */
/* ------------------------------------------------------------------ */

export function parseDefenseBudgetParsePlanV1(input: unknown): DefenseBudgetParsePlanV1 {
  return defenseBudgetParsePlanV1Schema.parse(input);
}