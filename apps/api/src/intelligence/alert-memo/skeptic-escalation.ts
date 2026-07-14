/**
 * LLM-skeptic escalation for the two genuinely-blocking deliverable surfaces
 * (alert-memo, district-brief). Neutral LEAF module — imports only from
 * @capiro/meriv2-core, never a service, so it can never re-create the
 * reviews↔alert-memo DI cycle that once crashed api boot.
 *
 * Dark by default: `MERI_SKEPTIC_MODE` env — off (default) | shadow (run + log,
 * verdict untouched) | enforce (confident refutations merge into the verdict
 * via the SAME per-surface decision policy the deterministic auditor used).
 * `MERI_SKEPTIC_MODEL` optionally pins a cheaper model than the memo's own.
 * Fail-open at the transport layer: any escalation failure returns the
 * deterministic verdict unchanged (loud log) — an LLM outage must never turn
 * into a memo outage.
 */
import {
  AnthropicLlmClient,
  createLlmSkepticJudge,
  mergeSkepticFindings,
  resolveSkepticMode,
  runSkepticAudit,
  type AuditVerdict,
  type ToolResultLedger,
} from '@capiro/meriv2-core';

export async function applySkepticEscalation(opts: {
  verdict: AuditVerdict;
  output: string;
  ledger: ToolResultLedger;
  cred: { apiKey: string; model: string };
  logger: { warn(message: string): void };
}): Promise<AuditVerdict> {
  const mode = resolveSkepticMode(process.env.MERI_SKEPTIC_MODE);
  if (mode === 'off') return opts.verdict;
  try {
    const judge = createLlmSkepticJudge(
      new AnthropicLlmClient({
        apiKey: opts.cred.apiKey,
        model: process.env.MERI_SKEPTIC_MODEL || opts.cred.model,
      }),
    );
    const res = await runSkepticAudit(
      {
        output: opts.output,
        ledger: opts.ledger,
        surface: opts.verdict.surface,
        deterministicFindings: opts.verdict.findings,
      },
      judge,
    );
    if (res.residuals.length === 0) return opts.verdict;
    opts.logger.warn(
      `[meri-skeptic:${mode}] ${opts.verdict.surface} — ${res.residuals.length} residual claim(s) ` +
        `escalated, ${res.findings.length} refuted (${res.lowConfidenceRefutations} low-confidence demoted): ` +
        res.verdicts.map((v) => `${v.refuted ? 'refute' : 'pass'}/${v.confidence}`).join(', '),
    );
    // Shadow observes only — the verdict (and therefore hold/banner/persist)
    // stays purely deterministic until enforce is deliberately flipped.
    if (mode === 'shadow') return opts.verdict;
    return mergeSkepticFindings(opts.verdict, res.findings);
  } catch (err) {
    opts.logger.warn(
      `[meri-skeptic] escalation failed (deterministic verdict unaffected): ${(err as Error).message}`,
    );
    return opts.verdict;
  }
}
