/**
 * Phase 3.1 — Tier-1 claim-level citations for Workspace generation (pure).
 *
 * The model is instructed to append FORM-B tokens ([S:pe:<code>] / [S:ctx:<id>])
 * after factual sentences, each token handed to it verbatim alongside the
 * grounding fact it cites. Post-LLM, validateFormBCitations (the SAME shared
 * validator the auditor's D1 uses) checks every emitted token against the
 * evidence corpus: invalid tokens are STRIPPED (a broken citation must never
 * render), valid tokens become numbered <sup>[n]</sup> markers with a persisted
 * per-section citation map — real claim-level citations in the output, not
 * post-hoc findings (blueprint §6.2).
 */
import { validateFormBCitations } from '@capiro/shared';

export interface CitableContextItem {
  id: string;
  label: string;
  body: string;
}

export interface CitablePe {
  peCode: string;
  title?: string | null;
  groundingText: string;
}

export interface SectionCitation {
  /** Footnote number within the section (first-appearance order). */
  n: number;
  token: string;
  kind: 'pe' | 'ctx';
  refId: string;
  label: string;
}

export interface ApplyCitationsResult {
  /** Content with valid tokens replaced by <sup>[n]</sup>, invalid ones removed. */
  html: string;
  citations: SectionCitation[];
  /** Tokens the model emitted that did not resolve (already stripped). */
  invalidTokens: string[];
}

/** The token a grounding fact is cited by (handed to the model verbatim). */
export function peCitationToken(peCode: string): string {
  return `[S:pe:${peCode.toUpperCase()}]`;
}
export function ctxCitationToken(id: string): string {
  return `[S:ctx:${id}]`;
}

/**
 * The validation corpus: record_ids must appear VERBATIM under their tool key
 * (validateFormBCitations' contract), so each entry leads with its own id.
 */
export function buildCitationCorpus(
  pes: CitablePe[],
  items: CitableContextItem[],
): Record<string, string> {
  return {
    pe: pes.map((p) => `${p.peCode.toUpperCase()}\n${p.groundingText}`).join('\n'),
    ctx: items.map((c) => `${c.id}\n${c.body}`).join('\n'),
  };
}

/**
 * Validate + render the model's citation tokens. Invalid tokens are stripped
 * (via the shared validator's sanitizedText); valid tokens are numbered per
 * DISTINCT token in first-appearance order and every occurrence becomes a
 * <sup>[n]</sup> marker. Pure — safe on any string, returns the input untouched
 * when no tokens are present.
 */
export function applyCitations(
  html: string,
  corpus: Record<string, string>,
  labels: { pe: Map<string, string>; ctx: Map<string, string> },
): ApplyCitationsResult {
  const check = validateFormBCitations(html, corpus);
  if (check.tokens.length === 0) return { html, citations: [], invalidTokens: [] };

  let out = check.sanitizedText;
  const citations: SectionCitation[] = [];
  for (const token of check.valid) {
    const m = /^\[S:([a-z][a-z0-9_]*):([^\]\s]+)\]$/.exec(token);
    if (!m) continue;
    const kind = m[1] === 'pe' ? 'pe' : m[1] === 'ctx' ? 'ctx' : null;
    if (!kind) {
      // A valid-per-corpus token of an unknown kind shouldn't render — strip it.
      out = out.split(token).join('');
      continue;
    }
    const refId = m[2]!;
    const n = citations.length + 1;
    const label =
      (kind === 'pe' ? labels.pe.get(refId.toUpperCase()) : labels.ctx.get(refId)) ?? refId;
    citations.push({ n, token, kind, refId, label });
    // Every occurrence of this token becomes the same footnote marker; a space
    // before the token is absorbed so "fact [S:x] ." doesn't leave a gap.
    out = out.split(` ${token}`).join(`<sup>[${n}]</sup>`);
    out = out.split(token).join(`<sup>[${n}]</sup>`);
  }
  return { html: out, citations, invalidTokens: check.invalid };
}
