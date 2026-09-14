/** Public, deterministic evidence contracts. Citation identity is never numeric. */
export type LegalReference = {
  jurisdiction: string;
  code: 'statute' | 'constitution' | 'administrative_rule';
  kind: 'chapter' | 'section' | 'subsection' | 'article' | 'rule';
  chapter: string | null;
  section: string | null;
  subdivisions: string[];
};
export function legalReferenceKey(ref: LegalReference): string {
  if (
    !/^[A-Z]{2}$/.test(ref.jurisdiction) ||
    !['statute', 'constitution', 'administrative_rule'].includes(ref.code)
  )
    throw Error('INVALID_LEGAL_REFERENCE');
  if (
    !['chapter', 'section', 'subsection', 'article', 'rule'].includes(ref.kind) ||
    !Array.isArray(ref.subdivisions) ||
    ref.subdivisions.length > 10
  )
    throw Error('INVALID_LEGAL_REFERENCE');
  if (
    ref.code === 'statute' &&
    (!ref.chapter ||
      !/^\d+$/.test(ref.chapter) ||
      !['chapter', 'section', 'subsection'].includes(ref.kind) ||
      (ref.kind === 'chapter' && (ref.section !== null || ref.subdivisions.length > 0)) ||
      (ref.kind !== 'chapter' && (!ref.section || !ref.section.startsWith(ref.chapter + '.'))) ||
      (ref.kind === 'section' && ref.subdivisions.length > 0) ||
      (ref.kind === 'subsection' && !ref.subdivisions.length))
  )
    throw Error('INVALID_STATUTE_HIERARCHY');
  const pieces = [ref.chapter, ref.section, ...ref.subdivisions];
  if (pieces.some((p) => p !== null && (typeof p !== 'string' || !/^[A-Za-z0-9.-]{1,60}$/.test(p))))
    throw Error('INVALID_CITATION_STRING');
  return [
    ref.jurisdiction,
    ref.code,
    ref.kind,
    ref.chapter ?? '',
    ref.section ?? '',
    ...ref.subdivisions,
  ].join(':');
}
export function parseFloridaCitation(raw: string): LegalReference | null {
  if (typeof raw !== 'string' || raw.length > 180) return null;
  const chapter = raw.trim().match(/^(?:ch(?:apter)?\.?)\s+(\d+)$/i);
  if (chapter && chapter[1] !== '0')
    return {
      jurisdiction: 'FL',
      code: 'statute',
      kind: 'chapter',
      chapter: chapter[1]!,
      section: null,
      subdivisions: [],
    };
  const section = raw
    .trim()
    .match(
      /^(?:(?:sec(?:tion)?|s|F\.S)\.?\s*)?(\d+)\.(\d+)((?:\([a-zA-Z0-9]+\))*)(?:,?\s*(?:F\.S\.|Florida Statutes))?$/i,
    );
  if (!section || section[1] === '0') return null;
  const subdivisions = [...section[3]!.matchAll(/\(([a-zA-Z0-9]+)\)/g)].map((m) => m[1]!);
  return {
    jurisdiction: 'FL',
    code: 'statute',
    kind: subdivisions.length ? 'subsection' : 'section',
    chapter: section[1]!,
    section: `${section[1]}.${section[2]}`,
    subdivisions,
  };
}
export function parseFloridaConstitutionCitation(raw: string): LegalReference | null {
  if (raw.length > 180) return null;
  const match = raw
    .trim()
    .match(
      /^(?:Art(?:icle)?\.?\s+)([IVX]+)(?:\s*,?\s*(?:s(?:ection)?\.?|§)\s*(\d+))?(?:\s*,?\s*(?:Fla\.? Const\.?|Florida Constitution))?$/i,
    );
  if (
    !match ||
    !['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'].includes(
      match[1]!.toUpperCase(),
    )
  )
    return null;
  return {
    jurisdiction: 'FL',
    code: 'constitution',
    kind: match[2] ? 'section' : 'article',
    chapter: match[1]!.toUpperCase(),
    section: match[2] ?? null,
    subdivisions: [],
  };
}
export function legalTargetMatches(
  target: LegalReference,
  occurrence: LegalReference,
  descendants: boolean,
): boolean {
  if (target.jurisdiction !== occurrence.jurisdiction || target.code !== occurrence.code)
    return false;
  if (legalReferenceKey(target) === legalReferenceKey(occurrence)) return true;
  if (!descendants) return false;
  if (target.kind === 'chapter' || target.kind === 'article')
    return target.chapter === occurrence.chapter;
  return (
    target.chapter === occurrence.chapter &&
    target.section === occurrence.section &&
    target.subdivisions.length <= occurrence.subdivisions.length &&
    target.subdivisions.every((s, i) => s === occurrence.subdivisions[i])
  );
}
export type LegalRelation =
  | 'cites'
  | 'proposes_amend'
  | 'proposes_repeal'
  | 'proposes_create'
  | 'proposes_renumber'
  | 'reenacts'
  | 'unresolved';
export type CitationOccurrence = {
  reference: LegalReference;
  start: number;
  end: number;
  quote: string;
  relation: LegalRelation;
  basis: 'citation' | 'explicit_operative_wording';
};
function operativeStatuteHeadings(text: string) {
  const found = new Map<number, LegalRelation>();
  const relations: Record<string, LegalRelation> = {
    amended: 'proposes_amend',
    repealed: 'proposes_repeal',
    created: 'proposes_create',
    reenacted: 'reenacts',
    renumbered: 'proposes_renumber',
  };
  for (const heading of text.matchAll(/^\s*Section[ \t]+\d+\.[ \t]+/gim)) {
    // Native PDF lines carry printed line numbers. Remove only a trailing
    // integer on each bounded heading line, retaining a map to original bytes.
    const window = text
      .slice(heading.index!, heading.index! + 1000)
      .split('\n')
      .slice(0, 6);
    let normalized = '',
      offset = heading.index!;
    const offsets: number[] = [];
    for (const line of window) {
      const clean = line.replace(/[ \t]+\d{1,5}[ \t]*$/, '');
      for (let i = 0; i < clean.length; i++) {
        normalized += clean[i];
        offsets.push(offset + i);
      }
      normalized += ' ';
      offsets.push(offset + line.length);
      offset += line.length + 1;
    }
    const operative = normalized.match(
      /^\s*Section\s+\d+\.\s+(?:(?:subsections?|paragraphs?|subparagraphs?|and|of|the)\s+|\([a-z0-9]+\)[,;\s]*)*(?:Section|s\.)\s+(\d+\.\d+(?:\([A-Za-z0-9]+\))*)\s*,\s*Florida\s+Statutes,\s+(?:is|are)\s+(amended|repealed|created|reenacted|renumbered)\b/i,
    );
    if (operative) {
      const start = offsets[operative[0].indexOf(operative[1]!)];
      if (start !== undefined) found.set(start, relations[operative[2]!.toLowerCase()]!);
    }
  }
  return found;
}
/** Deliberately conservative: a title, analysis, or quoted existing text cannot establish an operative effect. */
export function floridaCitationOccurrences(
  text: string,
  kind: 'bill_text' | 'amendment_text' | 'analysis' | 'title',
): { occurrences: CitationOccurrence[]; unresolved: string[] } {
  if (text.length > 2_000_000) throw Error('CITATION_TEXT_LIMIT');
  const occurrences: CitationOccurrence[] = [];
  const operative =
    kind === 'bill_text' || kind === 'amendment_text'
      ? operativeStatuteHeadings(text)
      : new Map<number, LegalRelation>();
  const pattern =
    /\b(?:s\.|ss\.|section(?:s)?|F\.S\.)\s+(\d+\.\d+(?:\([A-Za-z0-9]+\))*)|\b(\d+\.\d+(?:\([A-Za-z0-9]+\))*)\s*,?\s*(?:F\.S\.|Florida Statutes)/gi;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? match[2]!;
    const reference = parseFloridaCitation(raw);
    if (!reference) continue;
    const start = match.index! + match[0].indexOf(raw),
      end = start + raw.length;
    const relation = operative.get(start);
    occurrences.push({
      reference,
      start,
      end,
      quote: text.slice(start, end),
      relation: relation ?? 'cites',
      basis: relation ? 'explicit_operative_wording' : 'citation',
    });
    if (occurrences.length > 10000) throw Error('CITATION_OCCURRENCE_LIMIT');
  }
  // Enumerated whole citations are retained separately. Shorthand and ranges
  // need the edition-qualified publisher inventory; numeric expansion is unsafe.
  const groups =
    /\bss\.\s+(\d+\.\d+(?:\([A-Za-z0-9]+\))*(?:(?:\s*,\s*|\s+and\s+)\d+\.\d+(?:\([A-Za-z0-9]+\))*)+)/gi;
  for (const group of text.matchAll(groups)) {
    if (group[0].length > 4096) throw Error('GROUPED_CITATION_LIMIT');
    const offset = group.index! + group[0].indexOf(group[1]!);
    for (const item of group[1]!.matchAll(/\d+\.\d+(?:\([A-Za-z0-9]+\))*/g)) {
      const start = offset + item.index!,
        end = start + item[0].length;
      if (!occurrences.some((o) => o.start === start && o.end === end))
        occurrences.push({
          reference: parseFloridaCitation(item[0])!,
          start,
          end,
          quote: item[0],
          relation: 'cites',
          basis: 'citation',
        });
    }
  }
  const constitution =
    /\b(?:Art(?:icle)?\.?)\s+([IVX]+)(?:\s*,?\s*(?:s(?:ection)?\.?|§)\s*(\d+))?\s*,?\s*(?:of\s+the\s+)?(?:Fla\.?\s+Const\.?|Florida Constitution|State Constitution)\b/gi;
  for (const match of text.matchAll(constitution)) {
    const reference = parseFloridaConstitutionCitation(
      'Article ' + match[1] + (match[2] ? ', Section ' + match[2] : ''),
    );
    if (reference)
      occurrences.push({
        reference,
        start: match.index!,
        end: match.index! + match[0].length,
        quote: match[0],
        relation: 'cites',
        basis: 'citation',
      });
  }
  if (occurrences.length > 10000) throw Error('CITATION_OCCURRENCE_LIMIT');
  occurrences.sort((a, b) => a.start - b.start || a.end - b.end);
  const unresolved = /\bss\.\s*\d+\.\d+\s*(?:[-–]|through|,\s*\.)/i.test(text)
    ? ['GROUPED_OR_RANGE_CITATION_REQUIRES_REVIEW']
    : [];
  return { occurrences, unresolved };
}
export type ResearchSection = { locator: string; text: string; hash: string };
export type ResearchVersion = {
  id: string;
  billId: string;
  jurisdiction: string;
  sessionKey: string;
  revision: string;
  contentHash: string;
  extractorVersion: string;
  sourceUrl: string | null;
  kind: string;
  publishedDate: string | null;
  observedAt: string;
  complete: boolean;
  sections: ResearchSection[];
};
export type ComparisonLine = {
  kind: 'unchanged' | 'removed' | 'added';
  text: string;
  left: { locator: string; start: number; end: number } | null;
  right: { locator: string; start: number; end: number } | null;
};
function lines(version: ResearchVersion) {
  return version.sections.flatMap((section) => {
    let offset = 0;
    return section.text.split('\n').map((text) => {
      const line = { text, locator: section.locator, start: offset, end: offset + text.length };
      offset += text.length + 1;
      return line;
    });
  });
}
/** Bounded exact line comparison; original source offsets survive whitespace changes. */
export function compareResearchVersions(
  left: ResearchVersion,
  right: ResearchVersion,
  allowCrossBill = false,
) {
  if (
    !allowCrossBill &&
    (left.billId !== right.billId ||
      left.sessionKey !== right.sessionKey ||
      left.jurisdiction !== right.jurisdiction)
  )
    throw Error('EXPLICIT_CROSS_BILL_SELECTION_REQUIRED');
  if (!left.complete || !right.complete) throw Error('COMPARISON_REQUIRES_COMPLETE_EXTRACTIONS');
  const allA = lines(left),
    allB = lines(right);
  if (
    allA.length + allB.length > 20000 ||
    [...allA, ...allB].reduce((n, l) => n + l.text.length, 0) > 2_000_000
  )
    throw Error('COMPARISON_LIMIT_SELECT_SMALLER_SOURCE_PAIR');
  let prefix = 0,
    suffix = 0;
  while (prefix < allA.length && prefix < allB.length && allA[prefix]!.text === allB[prefix]!.text)
    prefix++;
  while (
    suffix < allA.length - prefix &&
    suffix < allB.length - prefix &&
    allA[allA.length - 1 - suffix]!.text === allB[allB.length - 1 - suffix]!.text
  )
    suffix++;
  const a = allA.slice(prefix, allA.length - suffix),
    b = allB.slice(prefix, allB.length - suffix);
  if (a.length * b.length > 4_000_000) throw Error('COMPARISON_LIMIT_SELECT_SMALLER_SOURCE_PAIR');
  const width = b.length + 1,
    dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * width + j] =
        a[i]!.text === b[j]!.text
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
  const changes: ComparisonLine[] = allA
    .slice(0, prefix)
    .map((line, i) => ({ kind: 'unchanged', text: line.text, left: line, right: allB[i]! }));
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) {
      changes.push({ kind: 'unchanged', text: a[i]!.text, left: a[i]!, right: b[j]! });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)
    ) {
      changes.push({ kind: 'removed', text: a[i]!.text, left: a[i]!, right: null });
      i++;
    } else {
      changes.push({ kind: 'added', text: b[j]!.text, left: null, right: b[j]! });
      j++;
    }
  }
  for (let k = suffix; k > 0; k--) {
    const l = allA[allA.length - k]!,
      r = allB[allB.length - k]!;
    changes.push({ kind: 'unchanged', text: l.text, left: l, right: r });
  }
  const compact = (v: ResearchVersion) => ({ ...v, sections: undefined });
  return {
    version: 'exact-line-lcs-v1',
    left: compact(left),
    right: compact(right),
    changes,
    classification:
      left.contentHash === right.contentHash
        ? left.extractorVersion === right.extractorVersion &&
          a.map((l) => l.text).join('\n') === b.map((l) => l.text).join('\n')
          ? 'identical_bytes'
          : 'reextraction_only'
        : a
              .map((l) => l.text)
              .join('\n')
              .replace(/\s+/g, ' ')
              .trim() ===
            b
              .map((l) => l.text)
              .join('\n')
              .replace(/\s+/g, ' ')
              .trim()
          ? 'layout_only'
          : 'textual_change',
    warning:
      'Text comparison does not establish adoption, enactment or legal effect. Original legislative underline/strike-through may be absent from extracted text.',
  };
}
export function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
