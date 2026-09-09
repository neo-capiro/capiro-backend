/**
 * A routing hint, not an entity resolver. Only the object of an explicit
 * research, relationship or comparison request may replace the UI subject.
 * Capitalization elsewhere (formats, quoted output, attachment text, acronyms)
 * is not evidence that the user chose a different subject.
 */
export function explicitMeriSubjectHint(
  request: string,
  hasSelectedClient = false,
): string | null {
  const clientCue = /\bfor\s+(?:this|our|my|the\s+(?:currently\s+)?selected)\s+client\b/i.exec(request);
  if (hasSelectedClient && clientCue && !/\b(?:not|except)\s*$/i.test(request.slice(0, clientCue.index))) return null;

  // These match the operation of a request clause, never an instruction quoted
  // inside output text, an attachment title, or the object of a rewrite request.
  const frames = [
    /^what\s+does\s+(.+?)\s+(?:do|make|build|provide|sell|offer)\b/i,
    /^(?:research|look\s+up|investigate)\s+(?:(?:on|about|into)\s+)?(.+)/i,
    /^(?:(?:look\s+in|check|search)\s+(?:my|our|the)\s+(?:inbox|mail|emails?)\s+and\s+)?(?:tell\s+me\s+(?:(?:everything|what)\s+)?(?:(?:we|you)\s+(?:know|remember)\s+|(?:I|we)\s+should\s+know\s+)?about|(?:what|everything)\s+(?:do|did)\s+(?:we|you)\s+(?:know|remember)\s+about|everything\s+(?:I|we)\s+should\s+know\s+about|catch\s+me\s+up\s+(?:on|about))\s+(.+)/i,
    /^(?:(?:(?:give|show)\s+me|prepare|develop|draft|create)\s+(?:(?:a|an|the)\s+)?(?:(?:comprehensive|federal|growth|market|capture|pursuit|company|executive|detailed|short)\s+)*)?(?:strategy|research|profile)\s+(?:on|for|about)\s+(.+)/i,
    /^(?:(?:(?:give|show)\s+me|prepare|draft|create)\s+(?:(?:a|an|the)\s+)?(?:short\s+|executive\s+)?)?brief\s+(?:on|about)\s+(.+)/i,
    /^(?:(?:(?:give|show|tell)\s+me|summarize|what\s+(?:is|was))\s+)?(?:a\s+summary\s+of\s+)?(?:(?:my|our|the)\s+)?(?:(?:email|engagement|relationship|communications|and)\s+)*(?:emails?|history|relationship|relationships|communications|correspondence|interactions)\s+(?:from|with|about|of)\s+(.+)/i,
    /^compare\s+(?:my|our|this|the\s+selected)\s+client\s+(?:with|to|against)\s+(.+)/i,
    /^compare\s+(.+?)(?:\s+(?:and|with|to|against|versus|vs\.?)\s+.+)$/i,
  ];
  for (const clause of subjectRequestClauses(request)) {
    const operation = clause.trim().replace(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?/i, '');
    for (const frame of frames) {
      const match = frame.exec(operation);
      const raw = match?.[1];
      if (!raw) continue;
      const quoted = /^["“]([^"”]{2,100})["”]/.exec(raw)?.[1];
      const candidate = (quoted ?? raw
        .split(/[!?;,\n]|\.(?=\s+[A-Z])|\s+(?:and|but|instead\s+of|rather\s+than|not\s+for|for\s+(?:this|our|my)|versus|vs\.?|with|against|then|that|they|their|should|could|would)\b/i)[0]!)
        .trim().replace(/[.:'"”]+$/g, '').trim();
      if (!candidate || candidate.length > 100) continue;
      // Deictic/possessive references point at existing context, not a new entity.
      if (/^(?:a|an|all|any|every|the|this|that|these|those|my|our|your|me|us|it|them|client|clients|attached|uploaded|following)\b/i.test(candidate)) continue;
      if (isGovernmentReference(candidate)) continue;
      const domain = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,})(?:\/\S*)?$/i.exec(candidate)?.[1];
      if (domain) return domain;
      // A name-like object is necessary but never sufficient without a frame.
      if (/\d|(?:^|\s)[A-Z][A-Za-z0-9&.'-]*|\b(?:inc|llc|corp|corporation|company|ltd|limited|holdings?|advisors?|systems?|technologies?)\b/.test(candidate)
        || /^what\s+does\b/i.test(match?.[0] ?? '')) return candidate;
    }
  }
  return null;
}

/** Only top-level sentences can introduce another request. Quoted material
 * stays with its operation; a colon binds the following literal/explanation to
 * that operation instead of promoting its contents into new requests. */
function subjectRequestClauses(request: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let index = 0; index < request.length; index += 1) {
    const character = request[index]!;
    if (quote) {
      if (character === quote && request[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === '“' || character === '`'
      || (character === "'" && !/[A-Za-z0-9]/.test(request[index - 1] ?? ''))) {
      quote = character === '“' ? '”' : character;
      continue;
    }
    if (character === ':' && request.slice(index + 1, index + 3) !== '//') break;
    if (/[.!?;]/.test(character) && /^\s+[A-Za-z]/.test(request.slice(index + 1))) {
      clauses.push(request.slice(start, index + 1));
      start = index + 1;
    }
  }
  clauses.push(request.slice(start));
  return clauses;
}

function isGovernmentReference(value: string): boolean {
  return /^FY\s*\d{2,4}(?:\b|$)/i.test(value)
    || /^PE(?:\s*\d+[A-Z]?)?$/i.test(value)
    || /^(?:HASC|SASC|HAC(?:-D)?|SAC(?:-D)?|NDAA|RDTE|RDT&E|USD)(?:$|\s+(?:staff|funding|appropriations|budget|mark|implementation|provisions|hearing)\b)/i.test(value)
    || /^(?:H\.?\s*R\.?|S\.?|H\.?\s*J\.?\s*Res\.?|S\.?\s*J\.?\s*Res\.?)\s*\d+/i.test(value);
}


/** Explicit portfolio requests share one contract across both Meri runtimes. */
export function hasExplicitMeriPortfolioScope(request: string): boolean {
  // A quoted output/title or colon-bound rewrite is not a scope directive.
  const directive = request.replace(/"[^"]*(?:"|$)|“[^”]*(?:”|$)|`[^`]*(?:`|$)|(?<![A-Za-z0-9])'[^']*(?:'|$)/g, '')
    .split(/:(?!\/\/)/, 1)[0]!;
  return [
    /\b(?:across|among)\s+(?:all\s+)?(?:(?:my|our|the\s+firm(?:'s)?)\s+)?clients?\b/i,
    /\b(?:all|every|entire)\s+(?:of\s+)?(?:(?:my|our)\s+)?(?:clients?|portfolio)\b/i,
    /\bportfolio\b/i,
    /\bclient\s+book\b/i,
    /\bbook\s+of\s+business\b/i,
  ].some((pattern) => pattern.test(directive));
}
