import { briefClock, type buildBriefEvidence } from './hearing-brief-evidence.js';

type Evidence = ReturnType<typeof buildBriefEvidence>['evidence'];

export const BRIEF_KEY_MOMENT_CHAR_LIMIT = 400;

const normalizeQuote = (text: string) =>
  text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

function verifyQuotes(
  content: string,
  location: { sectionIndex: number } | { momentIndex: number },
  sourceForQuote: (end: number) => { source?: Evidence[number]; referenceId?: string },
) {
  for (const quote of content.matchAll(/[“"]([^“”"\n]{20,})[”"]/g)) {
    const { source, referenceId } = sourceForQuote(quote.index! + quote[0].length);
    if (!source || !normalizeQuote(source.text).includes(normalizeQuote(quote[1]!)))
      throw new Error(`Quotation is not present in its cited transcript passage; ${JSON.stringify({
        ...location,
        // Never log model-authored reference text or the quotation itself.
        referenceId: source ? referenceId : null,
        quoteLength: quote[1]!.length,
        reason: source ? 'text_mismatch' : 'missing_or_unknown_reference',
      })}`);
  }
}

/** The model selects evidence. Only the server supplies time and speaker authority. */
export function briefReferences(evidence: Evidence) {
  return evidence.map((source, index) => ({ ref: `E${String(index + 1).padStart(3, '0')}`, source }));
}

export function resolveBriefReferences(
  sections: Array<{ name: string; content: string }>,
  evidence: Evidence,
  moments: unknown,
) {
  const references = new Map(briefReferences(evidence).map(({ ref, source }) => [ref, source]));
  const resolvedSections = sections.map((section, sectionIndex) => {
    if (/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(section.content))
      throw new Error('Model must select evidence references, not author transcript timestamps');
    if (evidence.length) verifyQuotes(section.content, { sectionIndex }, (end) => {
      const paragraph = section.content.slice(end).split(/\n\s*\n/, 1)[0]!;
      const ref = paragraph.match(/\[(E[^\]\r\n]*)\]/i)?.[1];
      return { source: ref ? references.get(ref) : undefined, referenceId: ref };
    });
    return {
      ...section,
      content: section.content.replace(/\[(E[^\]\r\n]*)\]/gi, (_match, ref: string) => {
        const source = references.get(ref);
        if (!source) throw new Error('Unknown transcript evidence reference');
        return `[${briefClock(source.startMs)}]`;
      }),
    };
  });
  if (!Array.isArray(moments) || moments.length > 12)
    throw new Error('Invalid key moment references');
  const resolvedMoments = moments.map((moment: unknown, momentIndex) => {
    const value = moment as Record<string, unknown> | null;
    const source = value && typeof value.evidenceRef === 'string'
      ? references.get(value.evidenceRef)
      : undefined;
    if (!source || typeof value?.summary !== 'string' || !value.summary.trim())
      throw new Error('Key moment requires a supplied transcript evidence reference');
    const summary = value.summary.trim();
    if (summary.length > BRIEF_KEY_MOMENT_CHAR_LIMIT)
      throw new Error(`Key moment summary exceeds ${BRIEF_KEY_MOMENT_CHAR_LIMIT} characters; draft withheld`);
    if (/\[(?:E[^\]\r\n]*|\d{1,2}:\d{2}(?::\d{2})?)\]/i.test(value.summary))
      throw new Error('Key moment summary must not contain citation tokens');
    verifyQuotes(value.summary, { momentIndex }, () => ({ source, referenceId: value.evidenceRef as string }));
    return {
      startMs: source.startMs,
      speaker: source.speaker,
      summary,
    };
  });
  return { sections: resolvedSections, keyMoments: resolvedMoments };
}
