export type MeriV3VisualIntentLevel = 'explicit' | 'recommended' | 'not_needed';

export interface MeriV3VisualIntent {
  level: MeriV3VisualIntentLevel;
  reason: string;
}

const EXPLICIT_VISUAL_RE =
  /\b(chart|graph|plot|visuali[sz]e|visualization|heat\s*map|waterfall|scatter(?:plot)?|timeline|histogram|box\s*plot|pareto|sparkline)\b/i;

const TEMPORAL_RE =
  /\b(over time|trend|trajectory|year[- ]over[- ]year|yoy|month[- ]over[- ]month|mom|fiscal years?|fy\s*\d{2,4}\s*(?:-|to|through|vs\.?|versus)\s*fy\s*\d{2,4}|rolling|historical movement)\b/i;

const COMPARISON_RE =
  /\b(compare|comparison|versus|vs\.?|rank|ranking|largest|biggest|smallest|top\s+\d+|bottom\s+\d+|portfolio|exposure matrix|distribution|correlation|relationship between|scenario|sensitivity|outliers?|anomal(?:y|ies)|concentration|composition|share of|stage movement|request\s+(?:to|vs\.?|versus)|house\s+(?:to|vs\.?|versus)\s+senate)\b/i;

const ANALYTICAL_NOUN_RE =
  /\b(funding|budget|marks?|awards?|obligations?|filings?|spending|activity|votes?|clients?|program elements?|opportunities|deadlines?|stakeholders?|meetings?|engagements?|response rates?|issues?)\b/i;

const WRITING_ONLY_RE =
  /\b(rewrite|rephrase|proofread|translate|draft (?:an?|the) (?:email|note|paragraph|sentence)|fix (?:the )?grammar|make this sound)\b/i;

/**
 * Cheap, deterministic steering only. It never runs a chart itself and never
 * changes authorization. The frontier model still decides after retrieving
 * evidence whether the rows are complete enough to justify run_analysis.
 */
export function classifyMeriV3VisualIntent(input: unknown): MeriV3VisualIntent {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { level: 'not_needed', reason: 'empty request' };

  if (EXPLICIT_VISUAL_RE.test(text)) {
    return {
      level: 'explicit',
      reason: 'the user explicitly requested a chart, graph, timeline, or visualization',
    };
  }

  if (WRITING_ONLY_RE.test(text) && !TEMPORAL_RE.test(text) && !COMPARISON_RE.test(text)) {
    return { level: 'not_needed', reason: 'the request is writing-only' };
  }

  if ((TEMPORAL_RE.test(text) || COMPARISON_RE.test(text)) && ANALYTICAL_NOUN_RE.test(text)) {
    return {
      level: 'recommended',
      reason: 'the request asks for a substantive quantitative comparison or pattern',
    };
  }

  return {
    level: 'not_needed',
    reason: 'a visual is unlikely to reduce interpretation effort for this request',
  };
}

const VISUAL_PROVENANCE_RULE =
  'Cite the original Capiro or connected-app retrieval sources for every factual conclusion. run_analysis proves the computation, not the provenance of its input rows, and must never replace the original citations.';

export function meriV3VisualIntentPrompt(intent: MeriV3VisualIntent): string {
  switch (intent.level) {
    case 'explicit':
      return [
        '# Visual-analysis decision',
        `The user explicitly requested a visual (${intent.reason}).`,
        'After retrieving complete, source-backed numeric rows, use run_analysis and return one strong visual plus its exact table.',
        'If the evidence is too sparse or incomparable, do not fabricate missing values; explain why a trustworthy chart cannot be produced.',
        VISUAL_PROVENANCE_RULE,
      ].join('\n');
    case 'recommended':
      return [
        '# Visual-analysis decision',
        `A visual may materially improve this answer (${intent.reason}).`,
        'Consider run_analysis after retrieval. Use it only when the available rows support a real trend, comparison, ranking, distribution, relationship, scenario, or timeline.',
        'Prefer one decision-useful visual and its exact table; do not create decorative charts.',
        VISUAL_PROVENANCE_RULE,
      ].join('\n');
    case 'not_needed':
    default:
      return [
        '# Visual-analysis decision',
        `Do not call run_analysis merely to decorate this turn (${intent.reason}).`,
        'Use it only if later tool results reveal a material multi-row quantitative pattern that the user would otherwise struggle to interpret.',
        VISUAL_PROVENANCE_RULE,
      ].join('\n');
  }
}
