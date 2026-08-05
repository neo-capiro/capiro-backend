/**
 * Deterministic Phase 3 parser route and escalation planner.
 */
import { z } from 'zod';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import {
  DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
} from './parser-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import type { ParserPolicyV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { PageProfileV1 } from './page-profiler.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

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

const DEFAULT_DIGITAL_LADDER: readonly ExtractionMethodV1[] = [
  'deterministic_pdfplumber',
  'camelot',
  'docling',
  'llamaparse',
];
const IMAGE_ONLY_LADDER: readonly ExtractionMethodV1[] = ['paddleocr', 'docling', 'llamaparse'];
const MIXED_LAYOUT_LADDER: readonly ExtractionMethodV1[] = ['docling', 'camelot', 'llamaparse'];

function ladderForEngineClass(
  engineClass: 'table' | 'layout' | 'ocr' | 'complex',
): readonly ExtractionMethodV1[] {
  if (engineClass === 'ocr') return IMAGE_ONLY_LADDER;
  if (engineClass === 'layout' || engineClass === 'complex') return MIXED_LAYOUT_LADDER;
  return DEFAULT_DIGITAL_LADDER;
}

function initialEngineForPolicy(
  policy: ParserPolicyV1,
  profile: PageProfileV1,
): ExtractionMethodV1 {
  if (policy === 'native_structured') {
    throw new Error(
      'native_structured requires an explicitly supplied structured companion and must not fall back to PDF parsing',
    );
  }
  if (profile.likelyImageOnly) return 'paddleocr';
  if (policy === 'deterministic_table') return 'deterministic_pdfplumber';
  if (policy === 'mixed_layout') return 'docling';
  if (policy === 'ocr') {
    return profile.hasEmbeddedTextLayer ? 'deterministic_pdfplumber' : 'paddleocr';
  }
  return profile.likelyTablePage ? 'deterministic_pdfplumber' : 'docling';
}

export const DEFAULT_MAX_ESCALATION_ROUNDS = 4;

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
  if (input.pageProfiles.length === 0) throw new Error('initial plan requires page profiles');
  const groups = new Map<ExtractionMethodV1, number[]>();
  for (const profile of input.pageProfiles) {
    const engine = initialEngineForPolicy(input.parserPolicy, profile);
    const pages = groups.get(engine) ?? [];
    pages.push(profile.page);
    groups.set(engine, pages);
  }
  const steps: ParserPlanStepV1[] = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([engine, pages], ordinal) => ({
      stepId: `step-${ordinal}`,
      ordinal,
      engine,
      pages: [...pages].sort((a, b) => a - b),
      reasonCodes: ['initial_plan'],
      dependsOnStepIds: [],
      paid: false,
      terminalIfSuccessful: false,
    }));
  return sealPlan({
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
  });
}

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
  if (input.currentRound >= maxRounds) {
    return terminalPlan(input, 'max_escalation_rounds_reached');
  }
  if (input.correctableFindings.length === 0) {
    return terminalPlan(input, 'no_correctable_findings');
  }

  const nextEngineByPage = new Map<number, ExtractionMethodV1>();
  const reasonsByPage = new Map<number, Set<string>>();
  for (const finding of input.correctableFindings) {
    for (const page of finding.pages) {
      const attempted = input.attemptedEnginesByPage.get(page) ?? [];
      const next = ladderForEngineClass(finding.recommendedEngineClass).find(
        (engine) => !attempted.includes(engine),
      );
      if (!next) continue;
      const existing = nextEngineByPage.get(page);
      // Prefer a local route over a paid route when multiple findings target
      // the same page in the same round.
      if (!existing || (existing === 'llamaparse' && next !== 'llamaparse')) {
        nextEngineByPage.set(page, next);
      }
      const reasons = reasonsByPage.get(page) ?? new Set<string>();
      reasons.add(finding.findingCode);
      reasonsByPage.set(page, reasons);
    }
  }

  if (nextEngineByPage.size === 0) {
    return terminalPlan(input, 'all_permitted_engines_exhausted');
  }
  const paidPages = [...nextEngineByPage.entries()]
    .filter(([, engine]) => engine === 'llamaparse')
    .map(([page]) => page)
    .sort((a, b) => a - b);
  if (paidPages.length > 0 && !input.allowPaidParse) {
    return terminalPlan(input, 'paid_not_authorized', paidPages);
  }
  if (paidPages.length > input.maxPaidPages) {
    return terminalPlan(input, 'paid_page_cap_exceeded', paidPages);
  }

  const groups = new Map<ExtractionMethodV1, number[]>();
  for (const [page, engine] of nextEngineByPage) {
    const pages = groups.get(engine) ?? [];
    pages.push(page);
    groups.set(engine, pages);
  }
  const sortedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const steps: ParserPlanStepV1[] = sortedGroups.map(([engine, pages], ordinal) => ({
    stepId: `step-${ordinal}`,
    ordinal,
    engine,
    pages: [...pages].sort((a, b) => a - b),
    reasonCodes: [
      ...new Set(pages.flatMap((page) => [...(reasonsByPage.get(page) ?? [])])),
    ].sort(),
    dependsOnStepIds: [],
    paid: engine === 'llamaparse',
    terminalIfSuccessful: engine === 'llamaparse',
  }));
  return {
    plan: sealPlan({
      schemaVersion: DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
      executionId: input.executionId,
      cycleId: input.cycleId,
      manifestDocumentKey: input.manifestDocumentKey,
      sourceSha256: input.sourceSha256,
      parserPolicy: input.parserPolicy,
      steps,
      paidAuthorizationRequired: paidPages.length > 0,
      plannedPaidPages: paidPages,
      unresolvedPages: [],
    }),
    terminal: false,
  };
}

function terminalPlan(
  input: Pick<
    Parameters<typeof buildEscalationPlan>[0],
    'executionId' | 'cycleId' | 'manifestDocumentKey' | 'sourceSha256' | 'parserPolicy'
  >,
  reason: string,
  unresolvedPages: number[] = [],
) {
  return {
    plan: sealPlan({
      schemaVersion: DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
      executionId: input.executionId,
      cycleId: input.cycleId,
      manifestDocumentKey: input.manifestDocumentKey,
      sourceSha256: input.sourceSha256,
      parserPolicy: input.parserPolicy,
      steps: [],
      paidAuthorizationRequired: reason.includes('paid'),
      plannedPaidPages: reason.includes('paid') ? unresolvedPages : [],
      unresolvedPages,
    }),
    terminal: true,
    terminalReason: reason,
  };
}

function sealPlan(
  value: Omit<DefenseBudgetParsePlanV1, 'planSha256'>,
): DefenseBudgetParsePlanV1 {
  return defenseBudgetParsePlanV1Schema.parse({
    ...value,
    planSha256: sha256CanonicalJson(value as unknown as JsonValue),
  });
}

export const PARSER_CORRECTABLE_FINDING_CODES = new Set([
  'missing_required_source_fact',
  'blocking_omission',
  'missing_evidence',
  'parser_run_proof_missing',
  'arithmetic_reconciliation_failed',
  'required_comparison_not_run',
  'page_only_money_requires_reconciliation',
  'parser_warning_requires_review',
]);

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
  'verification_policy_not_implemented',
]);

export function isParserCorrectable(code: string): boolean {
  return PARSER_CORRECTABLE_FINDING_CODES.has(code);
}

export function parseDefenseBudgetParsePlanV1(input: unknown): DefenseBudgetParsePlanV1 {
  return defenseBudgetParsePlanV1Schema.parse(input);
}
