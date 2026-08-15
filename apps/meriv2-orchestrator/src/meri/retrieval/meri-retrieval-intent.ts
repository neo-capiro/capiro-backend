export const MERI_SUBJECT_SCOPES = [
  'client',
  'portfolio',
  'external_entity',
  'general',
] as const;
export type MeriSubjectScope = (typeof MERI_SUBJECT_SCOPES)[number];

export const MERI_QUERY_CLASSES = [
  'lookup',
  'semantic_recall',
  'entity_history',
  'relationship_history',
  'temporal_state',
  'change_detection',
  'portfolio_scan',
  'exhaustive_search',
  'comparison',
  'federal_market_analysis',
] as const;
export type MeriQueryClass = (typeof MERI_QUERY_CLASSES)[number];

export interface MeriRetrievalIntent {
  subjectScope: MeriSubjectScope;
  queryClass: MeriQueryClass;
  requireCompleteCoverage: boolean;
  includeFocusedClientContext: boolean;
  targetHint: string | null;
  reasonCodes: string[];
}

const PORTFOLIO_PATTERNS = [
  /\b(?:across|among)\s+(?:all\s+)?(?:(?:my|our|the\s+firm(?:'s)?)\s+)?clients?\b/i,
  /\b(?:all|every|entire)\s+(?:of\s+)?(?:(?:my|our)\s+)?(?:clients?|portfolio)\b/i,
  /\bportfolio(?:-wide|\s+(?:scan|brief|check|changes?|updates?))?\b/i,
  /\bsearch\s+across\s+clients?\b/i,
  /\bclient\s+book\b/i,
];

const CHANGE_PATTERNS = [
  /\bwhat(?:'s|\s+has)?\s+changed\b/i,
  /\bchanges?\s+(?:this|last)\s+(?:week|month|quarter)\b/i,
  /\banything\s+(?:important\s+)?(?:happen|happened|move|moved)\b/i,
  /\bwhat\s+happened\s+(?:this|last)\s+(?:week|month|quarter)\b/i,
  /\bsince\s+(?:monday|tuesday|wednesday|thursday|friday|last\s+week|yesterday)\b/i,
  /\bweek(?:ly)?\s+(?:change|update|brief|scan)\b/i,
  /\bnothing\s+(?:changed|happened|moved)\b/i,
];

const RELATIONSHIP_PATTERNS = [
  /\beverything\s+(?:i|we)\s+should\s+know\s+about\b/i,
  /\bcatch\s+me\s+up\s+(?:on|about)\b/i,
  /\bwhat\s+do\s+we\s+know\s+about\b/i,
  /\brelationship\s+(?:with|history)\b/i,
  /\blook\s+in\s+my\s+inbox\b/i,
  /\b(?:summary|summarize)\s+(?:of\s+)?(?:my\s+)?emails?\b/i,
  /\bemails?\s+(?:from|with|about)\b/i,
  /\bhave\s+we\s+ever\s+(?:spoken|talked|emailed|met|corresponded)\b/i,
  /\bhistory\s+(?:with|of)\b/i,
];

const FEDERAL_MARKET_PATTERNS = [
  /\bfederal\s+market\b/i,
  /\bpursuit\s+strategy\b/i,
  /\bwhat\s+should\s+.+\s+pursue\b/i,
  /\bprogram\s+elements?\b/i,
  /\bgovernment\s+contracts?\b/i,
  /\bfederal\s+contracts?\b/i,
  /\bfederal\s+grants?\b/i,
  /\b(?:sam\.gov|usa\s*spending|usaspending|naics|psc|uei|cage)\b/i,
  /\bcapabilit(?:y|ies)\b.*\b(?:contracts?|grants?|programs?|federal)\b/i,
];

const COMPARISON_PATTERNS = [
  /\bcompare\b/i,
  /\bversus\b/i,
  /\bvs\.?\b/i,
  /\brelative\s+to\b/i,
];

const EXHAUSTIVE_PATTERNS = [
  /\beverything\b/i,
  /\bcomprehensive\b/i,
  /\bcomplete\b/i,
  /\bexhaustive\b/i,
  /\ball\s+(?:of\s+)?(?:the\s+)?(?:relevant|available|matching)?\s*(?:data|records|messages|emails|changes|clients)?\b/i,
  /\banything\s+(?:i|we)\s+should\s+know\b/i,
  /\bnothing\s+(?:changed|happened|moved)\b/i,
];

const EXTERNAL_DISCOVERY_PATTERNS = [
  /\b(?:search|research|look\s+on|check)\s+(?:the\s+)?(?:internet|web|public\s+web)\b/i,
  /\bpublic\s+(?:company|organization|entity|sources?|research)\b/i,
  /\bnon[-\s]?client\b/i,
  /\bexternal\s+(?:company|organization|entity)\b/i,
  /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,}(?:\/\S*)?\b/i,
];

const TEMPORAL_PATTERNS = [
  /\b(?:today|yesterday|this\s+week|last\s+week|this\s+month|last\s+month)\b/i,
  /\b(?:as\s+of|on|before|after|between)\s+\w+/i,
  /\bcurrent(?:ly)?\b/i,
  /\blatest\b/i,
  /\brecent\b/i,
];

const GENERIC_TARGET_WORDS = new Set([
  'a',
  'all',
  'an',
  'any',
  'client',
  'clients',
  'current',
  'every',
  'it',
  'me',
  'my',
  'our',
  'portfolio',
  'the',
  'them',
  'this',
  'us',
  'you',
  'your',
]);

const TARGET_STOP_WORDS = new Set([
  'and',
  'but',
  'could',
  'find',
  'give',
  'has',
  'have',
  'is',
  'look',
  'research',
  'search',
  'should',
  'tell',
  'then',
  'that',
  'their',
  'they',
  'what',
  'which',
  'who',
  'would',
]);

const EXPLICIT_NAMED_SUBJECT_RE =
  /\b(?:tell\s+me\s+about|research|profile|brief\s+(?:on|about)|look\s+up)\b/i;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function cleanTargetCandidate(value: string): string | null {
  const words = value
    .replace(/[?!.;,]+$/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length > 0 && TARGET_STOP_WORDS.has(word.toLowerCase())) break;
    kept.push(word);
    if (kept.length >= 6) break;
  }
  const candidate = kept.join(' ').trim();
  if (!candidate) return null;
  const first = candidate.toLowerCase().split(/\s+/)[0] ?? '';
  return first && !GENERIC_TARGET_WORDS.has(first) ? candidate : null;
}

function looksLikeExplicitEntityName(target: string | null): boolean {
  if (!target) return false;
  return (
    /\d/.test(target) ||
    /(?:^|\s)[A-Z][A-Za-z0-9&.'-]*/.test(target) ||
    /\b(?:inc|llc|corp|corporation|company|co|ltd|limited|group|holdings?|advisors?|systems?|technologies?)\b/i.test(
      target,
    ) ||
    /\.[a-z]{2,}$/i.test(target)
  );
}

export function meriRetrievalTargetHint(text: string): string | null {
  const domain = text.match(
    /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,})(?:\/\S*)?\b/i,
  )?.[1];
  if (domain) return domain.replace(/[),.;!?]+$/g, '');

  const patterns = [
    /\b(?:strategy|research|profile|brief)\s+(?:on|for|about)\s+([a-z0-9][a-z0-9&.'-]*(?:\s+[a-z0-9][a-z0-9&.'-]*){0,7})/gi,
    /\b(?:about|from|with|at|for|on)\s+([a-z0-9][a-z0-9&.'-]*(?:\s+[a-z0-9][a-z0-9&.'-]*){0,7})/gi,
    /\b(?:compare|versus|vs\.?)\b.*?\b(?:to|with|against)\s+([a-z0-9][a-z0-9&.'-]*(?:\s+[a-z0-9][a-z0-9&.'-]*){0,7})/gi,
  ];
  let candidate: string | null = null;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      candidate = cleanTargetCandidate(match[1] ?? '') ?? candidate;
    }
  }
  return candidate;
}

function hasExplicitFocusedClientComparison(text: string): boolean {
  return (
    matchesAny(text, COMPARISON_PATTERNS) &&
    /\b(?:my|our|this|the\s+selected)\s+client\b/i.test(text)
  );
}

/**
 * Deterministic, conservative routing classification for the retrieval layer.
 * It does not resolve the named entity; it only decides whether an existing
 * UI client focus is the subject, a comparison anchor, or unrelated context.
 */
export function classifyMeriRetrievalIntent(
  request: string,
  selectedClientId?: string | null,
): MeriRetrievalIntent {
  const text = request.trim();
  const reasonCodes: string[] = [];
  const portfolio = matchesAny(text, PORTFOLIO_PATTERNS);
  const change = matchesAny(text, CHANGE_PATTERNS);
  const relationship = matchesAny(text, RELATIONSHIP_PATTERNS);
  const federalMarket = matchesAny(text, FEDERAL_MARKET_PATTERNS);
  const comparison = matchesAny(text, COMPARISON_PATTERNS);
  const exhaustive = matchesAny(text, EXHAUSTIVE_PATTERNS);
  const externalDiscovery = matchesAny(text, EXTERNAL_DISCOVERY_PATTERNS);
  const targetHint = meriRetrievalTargetHint(text);
  const namedTarget = Boolean(targetHint);
  const explicitNamedSubject = Boolean(
    namedTarget &&
      (externalDiscovery ||
        relationship ||
        federalMarket ||
        comparison ||
        EXPLICIT_NAMED_SUBJECT_RE.test(text) ||
        looksLikeExplicitEntityName(targetHint)),
  );
  const focusedClientComparison = hasExplicitFocusedClientComparison(text);

  if (portfolio) reasonCodes.push('explicit_portfolio_scope');
  if (change) reasonCodes.push('change_request');
  if (relationship) reasonCodes.push('relationship_request');
  if (federalMarket) reasonCodes.push('federal_market_request');
  if (comparison) reasonCodes.push('comparison_request');
  if (exhaustive) reasonCodes.push('exhaustive_language');
  if (externalDiscovery) reasonCodes.push('external_discovery');
  if (namedTarget) reasonCodes.push('named_target');
  if (explicitNamedSubject) reasonCodes.push('explicit_named_subject');

  let queryClass: MeriQueryClass;
  if (comparison) queryClass = 'comparison';
  else if (change) queryClass = 'change_detection';
  else if (federalMarket) queryClass = 'federal_market_analysis';
  else if (relationship) queryClass = 'relationship_history';
  else if (portfolio) queryClass = 'portfolio_scan';
  else if (exhaustive) queryClass = 'exhaustive_search';
  else if (/\b(?:history|previous|prior|past)\b/i.test(text)) queryClass = 'entity_history';
  else if (matchesAny(text, TEMPORAL_PATTERNS)) queryClass = 'temporal_state';
  else if (/\b(?:find|search|remember|know|discussed)\b/i.test(text)) {
    queryClass = 'semantic_recall';
  } else queryClass = 'lookup';

  let subjectScope: MeriSubjectScope;
  if (portfolio) subjectScope = 'portfolio';
  else if (explicitNamedSubject) subjectScope = 'external_entity';
  else if (selectedClientId) subjectScope = 'client';
  else subjectScope = 'general';

  const includeFocusedClientContext =
    subjectScope === 'client' || Boolean(selectedClientId && focusedClientComparison);
  const requireCompleteCoverage =
    portfolio || change || exhaustive || queryClass === 'relationship_history';

  if (includeFocusedClientContext) reasonCodes.push('focused_client_context_relevant');
  if (requireCompleteCoverage) reasonCodes.push('complete_coverage_required');

  return {
    subjectScope,
    queryClass,
    requireCompleteCoverage,
    includeFocusedClientContext,
    targetHint,
    reasonCodes,
  };
}

export function meriRetrievalIntentPrompt(
  intent: MeriRetrievalIntent,
  selectedClientId?: string | null,
): string {
  const lines = [
    '# Retrieval scope for this turn (authoritative)',
    `Subject scope: ${intent.subjectScope}.`,
    `Query class: ${intent.queryClass}.`,
    `Complete coverage required: ${intent.requireCompleteCoverage ? 'yes' : 'no'}.`,
  ];
  if (intent.targetHint) lines.push(`Named subject hint: ${intent.targetHint}.`);

  if (selectedClientId) {
    if (intent.subjectScope === 'client') {
      lines.push(
        `The selected client id ${selectedClientId} is the subject of this turn. Use it for client-scoped tools and do not cross into another client's private data.`,
      );
    } else if (intent.includeFocusedClientContext) {
      lines.push(
        `The selected client id ${selectedClientId} is a comparison anchor, not the external entity. Keep its authorized context distinct from public or third-party evidence.`,
      );
    } else {
      lines.push(
        `A client was selected in the interface, but it is NOT the subject of this ${intent.subjectScope} request. Do not silently narrow tool calls, mail searches, public research, or portfolio retrieval to that selected client.`,
      );
    }
  }

  if (intent.subjectScope === 'portfolio') {
    lines.push(
      'Enumerate the authorized client roster and cover the relevant domains across the portfolio. A few top search hits are not a portfolio scan.',
    );
  }
  if (intent.subjectScope === 'external_entity') {
    lines.push(
      'Resolve the named organization/person as a canonical entity even when it is not a client. Use deterministic internal identity signals first, then public registries and web research when needed.',
      'Do not create a client record merely to research an external entity.',
    );
  }
  if (intent.requireCompleteCoverage) {
    lines.push(
      'Zero matches are not proof of absence. Paginate when supported, inspect every relevant authorized source required by the query class, and report truncation, unavailable sources, sync failures, and other coverage limits.',
      'Use "none found" only for the sources actually searched; use an exhaustive negative statement only when the retrieval contract establishes complete coverage.',
    );
  }

  lines.push(
    'search_research_sources is broad INTERNAL discovery across authorized clients, meetings, synced mail, notes, and directory notes. It is not an exhaustive enumerator and a zero-result search cannot prove absence.',
    'Use search_public_web and the federal/legislative registries for external or public evidence. Keep public identity facts separate from tenant-private relationship evidence.',
    'This retrieval-scope block is the current routing contract and supersedes any older generic tool-routing sentence that conflicts with it.',
  );

  return lines.join('\n');
}
