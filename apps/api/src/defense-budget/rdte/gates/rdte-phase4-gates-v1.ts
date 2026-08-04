/**
 * rdte-phase4-gates-v1 — permanent Phase 4 architecture gates (WS N).
 *
 * Fails when Phase 4 production source (apps/api/src/defense-budget/rdte/**
 * plus the rdte scripts):
 *   1.  imports ProgramElementWriterService;
 *   2.  imports direct legacy loader functions (sync-comptroller-jbooks /
 *       sync-jbook-r2 / sync-jbook-performers);
 *   3.  calls Prisma canonical mutations on program_element* models;
 *   4.  invokes ingest-defense-budget-pdf.ts --commit;
 *   5.  accepts approvedSha256 as promotion authority;
 *   6.  labels contextual/outyear values canonical-request eligible;
 *   7.  uses binary floating point for money arithmetic;
 *   8.  invents dates for quarter/year schedule periods;
 *   9.  makes a paid parser call by default;
 *   10. hides omissions or unresolved pages.
 *
 * The scanner strips line/block comments before matching so doc comments
 * ("never calls LlamaParse") never produce false positives. Pure module.
 */

export interface RdteGateViolation {
  gateId: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface RdteGateInput {
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
    description: 'Phase 4 must not import the canonical PE writer service',
    pattern:
      /from\s+['"].*program-element-writer|require\(\s*['"].*program-element-writer|import\s+.*ProgramElementWriterService/,
  },
  {
    gateId: 'legacy_loader_import',
    description: 'Phase 4 must not import direct legacy loader functions',
    pattern:
      /from\s+['"].*(sync-comptroller-jbooks|sync-jbook-r2|sync-jbook-performers)|require\(\s*['"].*(sync-comptroller-jbooks|sync-jbook-r2|sync-jbook-performers)/,
  },
  {
    gateId: 'prisma_canonical_mutation',
    description: 'Phase 4 must not call Prisma canonical mutations',
    pattern:
      /programElement[A-Za-z]*\s*\.\s*(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/,
  },
  {
    gateId: 'ingest_commit',
    description: 'Phase 4 must not invoke the legacy ingest command with a commit flag',
    pattern: /ingest-defense-budget-pdf[^'"]*--commit/,
  },
  {
    gateId: 'approved_sha_promotion',
    description: 'approvedSha256 is not promotion authority',
    pattern: /approvedSha256\s*(=|:)\s*[^;]*(promot|write|canonical)/i,
  },
  {
    gateId: 'contextual_canonical_label',
    description:
      'contextual/outyear values must never be labeled canonical-request eligible',
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
    description: 'quarter/year periods must never be coerced into dates',
    pattern:
      /new\s+Date\s*\(\s*[^)]*(?:fiscal|quarter)[^)]*\)\s*;?[^;]{0,80}(plannedDate|actualDate|exactDate)/i,
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
];

/**
 * Run all gates over the supplied files. Returns every violation; an empty
 * result means all gates hold.
 */
export function runRdtePhase4Gates(input: RdteGateInput): RdteGateViolation[] {
  const violations: RdteGateViolation[] = [];
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

export const RDTE_PHASE4_GATE_RULES = RULES.map((rule) => ({
  gateId: rule.gateId,
  description: rule.description,
}));
