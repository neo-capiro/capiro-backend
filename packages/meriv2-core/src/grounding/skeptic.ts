/**
 * LLM SKEPTIC (v3 plan Wave 2 S3 / Wave 4) — adjudicates the residuals the
 * deterministic layer can't decide: `needs_skeptic` claims from the claim gate
 * (predicates with no deterministic checker) and composite/undecidable auditor
 * findings. It is NOT a general "is this good?" judge — it is adversarial by
 * construction: "assume this claim is WRONG; cite the exact supplied evidence
 * that refutes it; if you cannot find refuting OR confirming evidence, it is
 * refuted." Uncertainty defaults to refuted, matching the precision mandate.
 *
 * DI-shaped: the actual model call is injected as a `SkepticJudge`, so this
 * module is pure prompt-construction + verdict-normalization + panel voting —
 * unit-testable with a fake judge, and the caller (apps/api / orchestrator)
 * wires the real schema-forced LLM client. A skeptic anchor is re-validated by
 * the deterministic citation check (D1/D2) before it can support a claim — the
 * skeptic never launders an unsupported assertion into an approval.
 */

import type { LlmClient } from '../llm/llm-client.js';

export type SkepticConfidence = 'high' | 'medium' | 'low';

export interface SkepticInput {
  /** The claim/span under scrutiny (a sentence, or a PlannedClaim rendered to text). */
  claim: string;
  /**
   * The evidence the model may use — serialized tool results / EvidencePackets
   * for this turn. The skeptic may cite ONLY from here; anything else is refuted.
   */
  evidence: string;
  /** Optional predicate + subject context to focus the adversarial prompt. */
  predicate?: string;
  subject?: string;
}

export interface SkepticVerdict {
  /** True = the claim is NOT supported by the supplied evidence (kill it). */
  refuted: boolean;
  confidence: SkepticConfidence;
  reason: string;
}

/**
 * The injected model call: given a fully-formed adversarial prompt, return a
 * structured verdict. Implementations MUST be schema-forced (the model calls a
 * tool / returns strict JSON). A thrown error or malformed return is treated as
 * `refuted` by `runSkeptic` (fail-closed).
 */
export type SkepticJudge = (
  prompt: string,
) => Promise<{ refuted?: unknown; confidence?: unknown; reason?: unknown }>;

/** Build the adversarial prompt. Pure — no I/O. */
export function buildSkepticPrompt(input: SkepticInput): string {
  return [
    'You are a hostile fact-checker. Your job is to REFUTE the claim below, not to be helpful.',
    'Rules:',
    '- The ONLY admissible evidence is the "Evidence" block. Your pre-trained knowledge does not exist here.',
    '- A claim is SUPPORTED only if the evidence LITERALLY states it. Adjacent, plausible, or',
    '  paraphrased-but-not-stated → REFUTED.',
    '- If the evidence neither confirms nor contradicts the claim, the verdict is REFUTED (absence',
    '  of evidence is not support). Default to refuted whenever you are uncertain.',
    '- Do not invent a source, a number, a date, a name, or a status that is not in the evidence.',
    input.predicate ? `\nPredicate under test: ${input.predicate}` : '',
    input.subject ? `Subject: ${input.subject}` : '',
    `\nClaim:\n${input.claim}`,
    `\nEvidence:\n${input.evidence || '(no evidence supplied)'}`,
    '\nReturn a strict verdict: refuted (boolean), confidence ("high"|"medium"|"low"),',
    'reason (one sentence citing the specific evidence, or naming what is missing).',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeConfidence(v: unknown): SkepticConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

/**
 * Run ONE skeptic. Fail-closed: any thrown error, a non-boolean `refuted`, or a
 * missing verdict resolves to `{ refuted: true, confidence: 'low' }` — an
 * un-adjudicable claim is treated as unsupported, never silently approved.
 */
export async function runSkeptic(
  input: SkepticInput,
  judge: SkepticJudge,
): Promise<SkepticVerdict> {
  try {
    const raw = await judge(buildSkepticPrompt(input));
    if (!raw || typeof raw.refuted !== 'boolean') {
      return {
        refuted: true,
        confidence: 'low',
        reason: 'Skeptic returned no usable verdict; treated as unsupported.',
      };
    }
    return {
      refuted: raw.refuted,
      confidence: normalizeConfidence(raw.confidence),
      reason:
        typeof raw.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim()
          : 'No reason given.',
    };
  } catch (err) {
    return {
      refuted: true,
      confidence: 'low',
      reason: `Skeptic call failed (treated as unsupported): ${(err as Error).message}`,
    };
  }
}

export interface SkepticPanelResult {
  refuted: boolean;
  votes: SkepticVerdict[];
  refuteVotes: number;
  /** The threshold used (majority by default). */
  threshold: number;
}

/**
 * Adversarial-verify PANEL: run N independent skeptics and refute when at least
 * `threshold` of them refute (default: majority). Diverse redundancy raises
 * precision on the residuals — a claim survives only if a majority of hostile
 * checkers each fail to refute it. N is clamped to [1, 7]; the panel itself
 * never throws (each skeptic is already fail-closed).
 */
export async function runSkepticPanel(
  input: SkepticInput,
  judge: SkepticJudge,
  n = 3,
  threshold?: number,
): Promise<SkepticPanelResult> {
  const count = Math.max(1, Math.min(7, Math.floor(n)));
  const majority = threshold ?? Math.floor(count / 2) + 1;
  const votes = await Promise.all(Array.from({ length: count }, () => runSkeptic(input, judge)));
  const refuteVotes = votes.filter((v) => v.refuted).length;
  return { refuted: refuteVotes >= majority, votes, refuteVotes, threshold: majority };
}

const SKEPTIC_TOOL_NAME = 'skeptic_verdict';
const SKEPTIC_TOOL_DESCRIPTION =
  'Record your adversarial verdict on whether the claim is supported by the supplied evidence.';
const SKEPTIC_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: {
      type: 'boolean',
      description:
        'true if the claim is NOT supported by the evidence (kill it); false only if the evidence literally states the claim.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: {
      type: 'string',
      description: 'One sentence citing the specific evidence, or naming what is missing.',
    },
  },
  required: ['refuted', 'confidence', 'reason'],
} as const;

/**
 * Build a real, schema-forced `SkepticJudge` from any `LlmClient` (the
 * orchestrator's `RequestScopedLlmClient`, already BYOK-resolved, or a plain
 * `AnthropicLlmClient`) — completes the DI seam `runSkeptic`/`runSkepticPanel`
 * were built against. No new HTTP-calling code: reuses `completeWithSchema`'s
 * existing tool-forcing contract, the same one `GroundedJson` already runs
 * live on (`targeting-brief.service.ts`, `llm-completion.service.ts`).
 * Validation/normalization of the returned shape stays in `runSkeptic` (fail-
 * closed on a thrown error or malformed verdict) — this factory just adapts
 * the transport.
 */
export function createLlmSkepticJudge(llm: LlmClient, opts?: { maxTokens?: number }): SkepticJudge {
  return async (prompt: string) => {
    const res = await llm.completeWithSchema({
      system:
        'You are a hostile fact-checker adjudicating a single claim against a fixed evidence set. Follow the instructions in the prompt exactly and call the tool with your verdict.',
      prompt,
      toolName: SKEPTIC_TOOL_NAME,
      toolDescription: SKEPTIC_TOOL_DESCRIPTION,
      inputSchema: SKEPTIC_INPUT_SCHEMA,
      maxTokens: opts?.maxTokens ?? 512,
    });
    return res.input as { refuted?: unknown; confidence?: unknown; reason?: unknown };
  };
}
