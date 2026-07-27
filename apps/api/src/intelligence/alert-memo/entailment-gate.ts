/**
 * §4.7 — the second grounding gate.
 *
 * `verifyGrounded` proves a paragraph CITES an existing claim id. It does not prove the
 * cited claim ENTAILS the paragraph: a paragraph citing c1 while asserting something c1
 * does not support passes it cleanly. This adds a low-temperature entailment check per
 * paragraph, after it.
 *
 * MERI_ENTAILMENT_MODE: off (default) | shadow (log only) | enforce (drop or hold).
 * MERI_ENTAILMENT_MODEL optionally pins a cheaper model than the memo's own.
 *
 * FAIL-OPEN BY CONTRACT: any error, timeout, non-OK response, or unparseable body returns
 * the sections UNCHANGED with held:false. A grounding gate that breaks generation is worse
 * than one that occasionally misses.
 *
 * Neutral LEAF module: imports nothing from a service, mirroring skeptic-escalation.ts, so
 * it can never re-create the reviews↔alert-memo DI cycle that once crashed api boot.
 */

/** Structurally identical to alert-memo.service.ts's GenSection (kept local — leaf module). */
export interface EntailmentSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

export interface EntailmentFinding {
  heading: string;
  text: string;
  verdict: string;
  reason: string;
}

export type EntailmentMode = 'off' | 'shadow' | 'enforce';

export function resolveEntailmentMode(raw: string | undefined): EntailmentMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
}

const ENTAILMENT_TIMEOUT_MS = 20_000;
/** §4 edge case 8: a 40-paragraph memo must not blow max_tokens in one batch. */
const BATCH_SIZE = 10;
const MAX_TOKENS = 1500;

const SYSTEM_PROMPT = `You are a strict entailment judge. For each paragraph you are given the ONLY evidence it is allowed to rest on. Answer entailed=false if ANY assertion in the paragraph is not directly supported by that evidence, including a number, date, name, or causal claim. Default to entailed=false when uncertain. Return ONLY JSON.`;

/**
 * Numbers, currency, percentages and (fiscal) years — the fabrications a citation check
 * structurally cannot catch.
 */
function numericTokens(text: string): string[] {
  return [
    ...(text.match(/\$?[\d,]+(?:\.\d+)?%?/g) ?? []),
    ...(text.match(/\b(?:FY)?\d{4}\b/g) ?? []),
  ];
}

/**
 * Deterministic pre-filter. A paragraph is auto-passed WITHOUT an LLM call when it carries
 * at least one numeric/date token and EVERY one of them appears verbatim in the claims it
 * cites — the cheap, high-confidence case.
 *
 * Deliberate reading of §4.7: a paragraph with NO numeric tokens is NOT auto-passed, it is
 * sent to the judge. §4.7's motivating example is a paragraph asserting something its cited
 * claim does not support, which is usually prose — auto-passing every prose paragraph would
 * leave the gate checking almost nothing. Cost stays bounded anyway because the remaining
 * paragraphs go in ONE batched call (≤ ceil(n/10) calls), not one call each.
 */
function autoPasses(
  paragraph: { text: string; claimIds: string[] },
  claimById: Map<string, string>,
): boolean {
  const tokens = numericTokens(paragraph.text);
  if (!tokens.length) return false;
  const cited = paragraph.claimIds.map((id) => claimById.get(id) ?? '').join(' ');
  return tokens.every((t) => cited.includes(t));
}

export async function applyEntailmentGate(input: {
  sections: EntailmentSection[];
  claims: Array<{ id: string; text: string }>;
  cred: { apiKey: string; model: string };
  logger: { warn(message: string): void };
  /**
   * Gate I (MP-12): force a specific mode regardless of MERI_ENTAILMENT_MODE.
   * district-brief.service.ts clamps to 'shadow' — it has no saveEdited
   * equivalent to guard a hold (I_GOVERNANCE.md phase d-3), so it must never
   * enforce even if the env var is later set to 'enforce' for alert-memo.
   * Omitted (alert-memo's call site) preserves the existing env-driven behavior.
   */
  modeOverride?: EntailmentMode;
}): Promise<{
  sections: EntailmentSection[];
  findings: EntailmentFinding[];
  held: boolean;
  /** Raw provider response(s) so the caller can meter this call separately (§4.9). */
  usage: unknown[];
}> {
  const mode = input.modeOverride ?? resolveEntailmentMode(process.env.MERI_ENTAILMENT_MODE);
  // The default-off lock: not one byte of network traffic unless deliberately enabled.
  if (mode === 'off') return { sections: input.sections, findings: [], held: false, usage: [] };

  const claimById = new Map(input.claims.map((c) => [c.id, c.text]));
  // Flatten to a stable index space so a batched verdict maps back unambiguously.
  const flat: Array<{ s: number; p: number; text: string; claimIds: string[]; heading: string }> = [];
  input.sections.forEach((s, si) =>
    s.paragraphs.forEach((p, pi) =>
      flat.push({ s: si, p: pi, text: p.text, claimIds: p.claimIds, heading: s.heading }),
    ),
  );
  const pending = flat.filter((f) => !autoPasses(f, claimById));
  if (!pending.length) {
    return { sections: input.sections, findings: [], held: false, usage: [] };
  }

  const usage: unknown[] = [];
  const verdicts = new Map<number, { entailed: boolean; reason: string }>();
  try {
    const batches: typeof pending[] = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));
    if (batches.length > 1) {
      input.logger.warn(
        `[meri-entailment:${mode}] ${pending.length} paragraph(s) exceed one batch — ` +
          `splitting into ${batches.length} chunk(s) of up to ${BATCH_SIZE}`,
      );
    }
    let offset = 0;
    for (const batch of batches) {
      const prompt = [
        'Judge each paragraph against ONLY the evidence listed with it.',
        '',
        ...batch.map((f, i) =>
          [
            `PARAGRAPH ${i}:`,
            f.text,
            'EVIDENCE it may rest on:',
            f.claimIds.length
              ? f.claimIds.map((id) => `- ${id}: ${claimById.get(id) ?? '(unknown claim)'}`).join('\n')
              : '- (none)',
            '',
          ].join('\n'),
        ),
        'Return ONLY JSON: {"verdicts":[{"i":0,"entailed":true,"reason":"..."}]}',
      ].join('\n');

      const { json } = await callJudge(input.cred, prompt);
      usage.push(json);
      const parsed = parseVerdicts(json);
      for (const v of parsed) {
        const target = batch[v.i];
        if (!target) continue; // an out-of-range index is ignored, never mis-assigned
        verdicts.set(flat.indexOf(target), { entailed: v.entailed, reason: v.reason });
      }
      offset += batch.length;
      void offset;
    }
  } catch (err) {
    input.logger.warn(
      `[meri-entailment] gate failed (sections unaffected): ${(err as Error).message}`,
    );
    return { sections: input.sections, findings: [], held: false, usage };
  }

  const findings: EntailmentFinding[] = [];
  const dropped = new Set<number>();
  flat.forEach((f, i) => {
    const v = verdicts.get(i);
    if (!v || v.entailed) return;
    findings.push({ heading: f.heading, text: f.text, verdict: 'not_entailed', reason: v.reason });
    dropped.add(i);
  });

  if (!findings.length) return { sections: input.sections, findings: [], held: false, usage };

  // Shadow observes only — output stays byte-identical until enforce is deliberately
  // flipped. This is how the gate is evaluated before it is trusted to remove text.
  if (mode === 'shadow') return { sections: input.sections, findings, held: false, usage };

  // Enforce: DROP a non-entailed paragraph. Never rewrite one — repairing is a generation
  // task, not a gate's job.
  const kept: EntailmentSection[] = [];
  let flatIdx = 0;
  for (const s of input.sections) {
    const paragraphs = s.paragraphs.filter(() => !dropped.has(flatIdx++));
    if (paragraphs.length) kept.push({ heading: s.heading, paragraphs });
  }
  return { sections: kept, findings, held: kept.length === 0, usage };
}

/** Direct-fetch Anthropic call, same shape as alert-memo.service.ts's callAnthropic. */
async function callJudge(
  cred: { apiKey: string; model: string },
  prompt: string,
): Promise<{ json: Record<string, unknown> }> {
  const controller = new AbortController();
  // Its OWN timeout — deliberately not MEMO_TIMEOUT_MS (§4 edge case 15).
  const timer = setTimeout(() => controller.abort(), ENTAILMENT_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cred.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.MERI_ENTAILMENT_MODEL || cred.model,
        max_tokens: MAX_TOKENS,
        // A judge must be deterministic.
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`entailment judge HTTP failure: ${JSON.stringify(json).slice(0, 200)}`);
    return { json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tolerates prose-wrapped JSON and returns [] rather than throwing — the same contract
 * parseSections follows. An unparseable body therefore means "no verdicts", which the
 * caller treats as everything passing (fail-open).
 */
function parseVerdicts(
  json: Record<string, unknown>,
): Array<{ i: number; entailed: boolean; reason: string }> {
  const content = Array.isArray(json.content) ? json.content : [];
  const text = content
    .map((part) => {
      const r = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
      return r.type === 'text' && typeof r.text === 'string' ? r.text : '';
    })
    .join('\n')
    .trim();
  if (!text) return [];
  let parsed: { verdicts?: unknown };
  try {
    parsed = JSON.parse(text) as { verdicts?: unknown };
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]) as { verdicts?: unknown };
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed.verdicts)) return [];
  const out: Array<{ i: number; entailed: boolean; reason: string }> = [];
  for (const raw of parsed.verdicts) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.i !== 'number') continue;
    // Default to NOT entailed when the judge omits or fuzzes the field — a permissive
    // judge is worse than none.
    const entailed = r.entailed === true;
    out.push({
      i: r.i,
      entailed,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 500) : '',
    });
  }
  return out;
}
