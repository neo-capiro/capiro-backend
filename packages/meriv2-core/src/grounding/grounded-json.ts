import type { z } from 'zod';
import type { LlmClient } from '../llm/llm-client.js';

/**
 * `GroundedJson` contract (Phase 1 M5.0, agentic doc §5.3) — the shared
 * Tier-1/Tier-2 helper: schema-instructed prompt (Anthropic tool-forcing) +
 * zod validation + ONE bounded re-prompt on failure + a deterministic
 * fallback + a citation check (every claim's cited evidence id must exist,
 * and every quoted substring in the claim's own text must appear verbatim in
 * at least one of its cited evidence entries).
 *
 * This is a NEW, general-purpose version of a pattern already duplicated
 * per-site in apps/api (`alert-memo.service.ts`/`district-brief.service.ts`'s
 * `verifyGrounded` — claimId-existence only, no retry, no schema-forcing).
 * Those existing, already-shipped generators are NOT retrofitted onto this
 * helper (out of scope — a working, tested generator isn't touched for its
 * own sake); this is for the M5.1+ Tier-2 workflows, which have no generator
 * yet to duplicate the pattern into a THIRD time.
 */

/** One piece of retrieved, verbatim source text the model may cite. */
export interface GroundedEvidence {
  id: string;
  text: string;
}

/** One model-asserted claim, citing the evidence ids it draws on. */
export interface GroundedClaim {
  text: string;
  evidenceIds: string[];
}

export type GroundedDropReason =
  | 'unknown_evidence_id'
  | 'quote_not_found_in_evidence'
  | 'no_evidence_cited';

export interface GroundedDroppedClaim {
  claim: GroundedClaim;
  reason: GroundedDropReason;
  /** Present only for quote_not_found_in_evidence — the exact substring that failed to match. */
  quote?: string;
}

export interface GroundedCitationCheckResult {
  kept: GroundedClaim[];
  dropped: GroundedDroppedClaim[];
}

/**
 * Normalize the full common Unicode quotation set to ASCII (W3.2, hardened
 * after the Wave-3 adversarial gate): every double-quote-family mark → ", every
 * single-quote-family mark → '. Applied to BOTH the claim text and the evidence
 * before extraction and the `.includes` check, so a fabricated quotation the
 * model wrote with ANY genuine quote style (curly, guillemets «»/‹›, low-9 „‚,
 * high-reversed-9 ‟‛, prime ″′, or fullwidth ＂＇) is folded to a straight quote
 * the extractor can see and check — closing the "only 4 curly chars were
 * normalized, so a guillemet-wrapped fabrication passed" bypass the gate found.
 * A legitimate quote also survives a straight-vs-typographic mismatch between
 * the model's rendering and the source text.
 *
 * NOTE (honest boundary): this gate checks QUOTED substrings + evidence-id
 * existence. Unquoted paraphrase that cites a real evidence id is NOT
 * entailment-checked here (that would require an LLM judge) — the same boundary
 * the two apps/api memo generators have. Interpretive prose is governed by the
 * caller's own controls (validation + QA hold + dark-by-default), not by this
 * substring gate.
 */
function normalizeQuotes(text: string): string {
  return (
    text
      // double-quote family: straight/curly/low-9/high-reversed-9, guillemets,
      // prime, fullwidth, + CJK corner & prime-quotation & dingbat doubles
      // (the last group is off-domain for English legislative text but folded
      // defensively so the seal holds regardless of the source language).
      .replace(/[“”„‟«»″＂「」『』〝〞〟❝❞]/g, '"')
      // single-quote family + angle quotes + single CJK/dingbat/reversed-prime
      .replace(/[‘’‚‛‹›′＇｢｣❛❜‵]/g, "'")
  );
}

/**
 * Extract double- or single-quoted substrings from a claim's text (the model's
 * own asserted quotes). Input is expected already `normalizeQuotes`d, so only
 * straight quotes are matched (the previous third regex alternative was a
 * byte-identical duplicate of the first — dead — and has been removed).
 */
function extractQuotedSubstrings(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{3,})"|'([^']{3,})'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    const q = m[1] ?? m[2];
    if (q) out.push(q);
  }
  return out;
}

/**
 * Deterministic citation gate (agentic doc §5.4's emit-path contract, scoped
 * to what a claim/evidence pair can check without a DB): drop a claim that
 * (a) cites zero evidence, (b) cites an evidence id that doesn't exist in the
 * supplied set, or (c) asserts a quoted substring that does not appear
 * verbatim in ANY of its cited evidence's text. Never guesses — an
 * unresolvable claim is dropped and logged, never silently kept.
 */
export function checkGroundedCitations(
  claims: readonly GroundedClaim[],
  evidence: readonly GroundedEvidence[],
): GroundedCitationCheckResult {
  // Normalize smart quotes in the evidence up front (W3.2) so the `.includes`
  // check compares like-for-like against the normalized claim quotes below.
  const byId = new Map(evidence.map((e) => [e.id, normalizeQuotes(e.text)]));
  const kept: GroundedClaim[] = [];
  const dropped: GroundedDroppedClaim[] = [];

  for (const claim of claims) {
    if (!claim.evidenceIds.length) {
      dropped.push({ claim, reason: 'no_evidence_cited' });
      continue;
    }
    const unknownId = claim.evidenceIds.find((id) => !byId.has(id));
    if (unknownId !== undefined) {
      dropped.push({ claim, reason: 'unknown_evidence_id' });
      continue;
    }
    const citedTexts = claim.evidenceIds.map((id) => byId.get(id) ?? '');
    const quotes = extractQuotedSubstrings(normalizeQuotes(claim.text));
    const badQuote = quotes.find((q) => !citedTexts.some((t) => t.includes(q)));
    if (badQuote !== undefined) {
      dropped.push({ claim, reason: 'quote_not_found_in_evidence', quote: badQuote });
      continue;
    }
    kept.push(claim);
  }
  return { kept, dropped };
}

export interface GroundedJsonParams<T> {
  llm: LlmClient;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  /** Retrieved source text the model may cite, for the citation check. */
  evidence: GroundedEvidence[];
  /**
   * The citation-check hooks, as ONE optional sub-object (W3.2 / D-10): a
   * dropped claim must be both DETECTED (`extract`) and STRIPPED from the
   * returned data (`remove`) — reporting a drop while leaving the ungrounded
   * content in `data` is the exact silent-leak this shape rules out at
   * compile time. Supplying one without the other is now impossible. Omit the
   * whole object only when the schema has no claim-shaped substructure to
   * check (equivalent to the old `extractClaims` always returning []).
   */
  claims?: {
    /** Pull the claims (each with evidenceIds) out of a validated object, for the citation check. */
    extract: (data: T) => GroundedClaim[];
    /** Return a COPY of `data` with the dropped claims' content removed (a dropped claim is stripped, not just reported). */
    remove: (data: T, dropped: GroundedClaim[]) => T;
  };
  /** Deterministic value (or lazy producer) used when both attempts fail validation. */
  fallback: T | (() => T);
  maxTokens?: number;
}

export interface GroundedJsonResult<T> {
  data: T;
  /** 'passed' when the model's own output validated (on attempt 1 or the retry); 'failed' when the deterministic fallback was used. */
  validationStatus: 'passed' | 'failed';
  usedFallback: boolean;
  /** Present only when validationStatus='passed' — claims dropped by the citation check. */
  droppedClaims: GroundedDroppedClaim[];
  usage: { inputTokens: number; outputTokens: number };
  /** Number of completeWithSchema calls made (1, or 2 if the retry fired). */
  attempts: number;
}

/**
 * Run the full GroundedJson pipeline: schema-forced completion -> zod
 * validate -> ONE bounded re-prompt on failure (told exactly what was
 * wrong) -> deterministic fallback if the retry also fails -> citation
 * check on a successfully-validated result. Never throws on a model/
 * validation failure — the fallback always yields a usable `T`; only a
 * transport-level failure (both `completeWithSchema` calls reject, e.g.
 * network/timeout) propagates, since there is no model output at all to
 * validate or fall back from at the LLM layer (callers already wrap Tier-1/
 * Tier-2 work to keep the underlying deterministic alert/record fail-open,
 * per the agentic doc's "validator failure never blocks the alert" rule).
 */
export async function generateGroundedJson<T>(
  params: GroundedJsonParams<T>,
): Promise<GroundedJsonResult<T>> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const addUsage = (u: { inputTokens: number; outputTokens: number }) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  };

  const attempt = async (extraSystem?: string) => {
    const res = await params.llm.completeWithSchema({
      system: extraSystem ? `${params.system}\n\n${extraSystem}` : params.system,
      prompt: params.prompt,
      toolName: params.toolName,
      toolDescription: params.toolDescription,
      inputSchema: params.inputSchema,
      maxTokens: params.maxTokens,
    });
    addUsage(res.usage);
    return params.schema.safeParse(res.input);
  };

  let attempts = 1;
  let parsed = await attempt();
  if (!parsed.success) {
    attempts = 2;
    const errorSummary = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    parsed = await attempt(
      `Your previous response did not match the required schema (${errorSummary}). Call the tool again with a corrected, fully-valid input.`,
    );
  }

  if (!parsed.success) {
    const data =
      typeof params.fallback === 'function' ? (params.fallback as () => T)() : params.fallback;
    return {
      data,
      validationStatus: 'failed',
      usedFallback: true,
      droppedClaims: [],
      usage,
      attempts,
    };
  }

  const claims = params.claims ? params.claims.extract(parsed.data) : [];
  const { dropped } = claims.length
    ? checkGroundedCitations(claims, params.evidence)
    : { dropped: [] as GroundedDroppedClaim[] };
  const data =
    dropped.length && params.claims
      ? params.claims.remove(
          parsed.data,
          dropped.map((d) => d.claim),
        )
      : parsed.data;

  return {
    data,
    validationStatus: 'passed',
    usedFallback: false,
    droppedClaims: dropped,
    usage,
    attempts,
  };
}
