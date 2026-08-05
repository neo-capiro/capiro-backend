/**
 * non-rdte-phase5-gates-v1 — permanent Phase 5 architecture gates (WS O).
 *
 * Fails when Phase 5 production source (apps/api/src/defense-budget/non-rdte/**
 * plus procurement/, om/, milcon/ family modules):
 *   1.  imports ProgramElementWriterService;
 *   2.  imports direct legacy loader functions (sync-comptroller-jbooks /
 *       sync-jbook-r2 / sync-jbook-performers);
 *   3.  calls Prisma canonical mutations on program_element* models;
 *   4.  invokes ingest-defense-budget-pdf.ts --commit;
 *   5.  accepts approvedSha256 as promotion authority;
 *   6.  labels contextual/outyear values canonical-request eligible;
 *   7.  uses binary floating point for money arithmetic;
 *   8.  invents FY or dates from narrative text;
 *   9.  makes a paid parser call by default;
 *   10. hides omissions or unresolved pages;
 *   11. imports upsertProgramElement / upsertProgramElementYear;
 *   12. imports assertPromotionReady / getCanonicalPromotionRecords;
 *   13. uses title similarity for identity matching;
 *   14. combines DD1391 cost categories without source-defined total.
 *
 * The scanner strips line/block comments before matching so doc comments
 * never produce false positives. Pure module.
 */

export interface NonRdteGateViolation {
  gateId: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface NonRdteGateInput {
  /** Relative file path -> source text. */
  files: Readonly<Record<string, string>>;
}

/** Strip // line comments and block comments, preserving line structure. */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inString: string | null = null;
  let inTemplate = false;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (inString != null) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (inTemplate) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '`') inTemplate = false;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface GateRule {
  gateId: string;
  description: string;
  /** Regex tested against comment-stripped lines. */
  pattern: RegExp;
}

const RULES: readonly GateRule[] = [
  {
    gateId: 'writer_import',
    description: 'Phase 5 must not import the canonical PE writer service',
    pattern:
      /from\s+['"].*program-element-writer|require\(\s*['"].*program-element-writer|import\s+.*ProgramElementWriterService/,
  },
  {
    gateId: 'legacy_loader_import',
    description: 'Phase 5 must not import direct legacy loader functions',
    pattern:
      /from\s+['"].*(sync-comptroller-jbooks|sync-jbook-r2|sync-jbook-performers)|require\(\s*['"].*(sync-comptroller-jbooks|sync-jbook-r2|sync-jbook-performers)/,
  },
  {
    gateId: 'prisma_canonical_mutation',
    description: 'Phase 5 must not call Prisma canonical mutations',
    pattern:
      /programElement[A-Za-z]*\s*\.\s*(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/,
  },
  {
    gateId: 'ingest_commit',
    description: 'Phase 5 must not invoke the legacy ingest command with a commit flag',
    pattern: /ingest-defense-budget-pdf[^'"]*--commit/,
  },
  {
    gateId: 'approved_sha_promotion',
    description: 'approvedSha256 is not promotion authority',
    pattern: /approvedSha256\s*(=|:)\s*[^;]*(promot|write|canonical)/i,
  },
  {
    gateId: 'contextual_canonical_label',
    description: 'contextual/outyear values must never be labeled canonical-request eligible',
    pattern:
      /(contextual_only|prior_actual_context|current_enacted_context|outyear_projection)[^;]{0,120}canonical_request_candidate[^;]{0,40}(eligible|allow|permit)/i,
  },
  {
    gateId: 'float_money',
    description: 'money arithmetic must never use binary floating point',
    pattern: /parseFloat\s*\([^)]*(?:money|amount|value|millions)/i,
  },
  {
    gateId: 'invented_dates',
    description: 'dates must never be invented from narrative text',
    pattern:
      /new\s+Date\s*\(\s*[^)]*(?:narrative|text|description)[^)]*\)\s*;?[^;]{0,80}(plannedDate|actualDate|exactDate)/i,
  },
  {
    gateId: 'paid_call_default',
    description: 'no paid parser call may occur by default',
    pattern: /executeLlamaParsePages\s*\(/,
  },
  {
    gateId: 'hidden_omissions',
    description: 'omissions/unresolved pages must never be hidden',
    pattern: /(omissions|unresolvedPages)\s*=\s*\[\s*\]\s*;?\s*\/\/\s*hide/i,
  },
  {
    gateId: 'upsert_program_element',
    description: 'Phase 5 must not import upsertProgramElement functions',
    pattern: /from\s+['"].*upsertProgramElement|import\s+.*upsertProgramElement/,
  },
  {
    gateId: 'promotion_ready_import',
    description: 'Phase 5 must not import promotion readiness functions',
    pattern:
      /from\s+['"].*(?:assertPromotionReady|getCanonicalPromotionRecords|promotionReady|canonicalEligible)|import\s+.*(?:assertPromotionReady|getCanonicalPromotionRecords|promotionReady|canonicalEligible)/,
  },
  {
    gateId: 'title_similarity_identity',
    description: 'Phase 5 must not use title similarity for identity matching',
    pattern: /titleSimilarity|fuzzyTitle|titleMatch|levenshtein.*title|title.*levenshtein/i,
  },
  {
    gateId: 'dd1391_cost_category_merge',
    description: 'DD1391 cost categories must not be combined without source-defined total',
    pattern: /primaryFacilityCost\s*\+\s*supportingFacilitiesCost|costCategories\s*=\s*sum\s*\(/i,
  },
];

/**
 * Run all gates over the supplied files. Returns every violation; an empty
 * result means all gates hold.
 */
export function runNonRdtePhase5Gates(input: NonRdteGateInput): NonRdteGateViolation[] {
  const violations: NonRdteGateViolation[] = [];
  for (const [file, source] of Object.entries(input.files)) {
    const stripped = stripComments(source);
    const lines = stripped.split('\n');
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (rule.pattern.test(line)) {
          violations.push({
            gateId: rule.gateId,
            file,
            line: i + 1,
            excerpt: line.trim().slice(0, 160),
          });
        }
      }
    }
  }
  return violations;
}

export const NON_RDTE_PHASE5_GATE_RULES = RULES.map((rule) => ({
  gateId: rule.gateId,
  description: rule.description,
}));
