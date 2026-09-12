import type {
  PublicHearingContext,
  PublicHearingEntity,
  PublicHearingInsightDraft,
  PublicTranscriptSegmentInput,
} from './public-hearing-intelligence.types.js';

const BILL_PATTERN =
  /\b(H\.?\s*R\.?|S\.?|H\.?\s*J\.?\s*Res\.?|S\.?\s*J\.?\s*Res\.?|H\.?\s*Con\.?\s*Res\.?|S\.?\s*Con\.?\s*Res\.?|H\.?\s*Res\.?|S\.?\s*Res\.?)\s*(\d+)\b/gi;
const PROGRAM_ELEMENT_PATTERN = /\b0\d{6}[A-Z]\b/g;
const AMOUNT_PATTERN =
  /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|trillion|thousand|[KMBT]))?\b/gi;
const DEADLINE_PATTERN =
  /\b(?:by|before|no later than|within|on or before)\s+(?:(?:\d{1,3})\s+(?:business\s+)?(?:days?|weeks?|months?)|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/gi;
const COMMITMENT_PATTERN =
  /\b(?:I|we|the department|the agency|the administration|the service)\s+(?:will|commit to|intend to|plan to|expect to)\s+\b/i;
const POLICY_POSITION_PATTERN =
  /\b(?:support|oppose|object to|urge|recommend|strongly encourage|remain concerned|have concerns|cannot support)\b/i;
const QUESTION_START_PATTERN =
  /^(?:what|why|how|when|where|who|which|will|would|can|could|do|does|did|is|are|should|has|have)\b/i;

const AGENCIES: ReadonlyArray<{ label: string; aliases: readonly string[] }> = [
  { label: 'Department of Defense', aliases: ['department of defense', 'dod', 'pentagon'] },
  { label: 'Department of the Army', aliases: ['department of the army', 'the army', 'u.s. army'] },
  { label: 'Department of the Navy', aliases: ['department of the navy', 'the navy', 'u.s. navy'] },
  {
    label: 'Department of the Air Force',
    aliases: ['department of the air force', 'the air force', 'u.s. air force'],
  },
  { label: 'Marine Corps', aliases: ['marine corps', 'u.s. marine corps'] },
  { label: 'Space Force', aliases: ['space force', 'u.s. space force'] },
  { label: 'Department of Energy', aliases: ['department of energy', 'doe'] },
  { label: 'Department of Homeland Security', aliases: ['department of homeland security', 'dhs'] },
  { label: 'Department of State', aliases: ['department of state', 'state department'] },
  { label: 'Department of Justice', aliases: ['department of justice', 'doj'] },
  {
    label: 'Department of Veterans Affairs',
    aliases: ['department of veterans affairs', 'veterans affairs', 'va'],
  },
  { label: 'National Science Foundation', aliases: ['national science foundation', 'nsf'] },
  { label: 'National Aeronautics and Space Administration', aliases: ['nasa'] },
  { label: 'Office of Management and Budget', aliases: ['office of management and budget', 'omb'] },
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function confidence(segment: PublicTranscriptSegmentInput, multiplier = 1): number {
  const base =
    typeof segment.confidence === 'number' && Number.isFinite(segment.confidence)
      ? segment.confidence
      : 0.72;
  return Math.max(0, Math.min(1, base * multiplier));
}

function sentences(text: string): string[] {
  const compact = normalizeWhitespace(text);
  if (!compact) return [];
  return compact
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function distinctMatches(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  const seen = new Set<string>();
  const output: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = normalizeWhitespace(match[0] ?? '');
    const key = value.toLowerCase().replace(/[\s.]/g, '');
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  pattern.lastIndex = 0;
  return output;
}

export function normalizeBillReference(value: string): string {
  const compact = value.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const match = compact.match(/^(HR|S|H J RES|S J RES|H CON RES|S CON RES|H RES|S RES)\s*(\d+)$/);
  if (!match) return compact;
  const type = (match[1] ?? '').replace(/\s+/g, '');
  return `${type}-${match[2]}`;
}

function billEntities(text: string, context?: PublicHearingContext): PublicHearingEntity[] {
  if (context?.geographicJurisdiction && context.geographicJurisdiction !== 'US') {
    if (context.geographicJurisdiction !== 'FL') return [];
    return distinctMatches(text, /\b(H\.?\s*B\.?|S\.?\s*B\.?)\s*0*(\d+)\b/gi).map((label) => {
      const number = label
        .replace(/[.\s]/g, '')
        .toUpperCase()
        .replace(/^(HB|SB)0+(?=\d)/, '$1');
      const resolved = context.legislativeSession
        ? (context.resolvedBills?.filter((bill) => bill.number === number) ?? [])
        : [];
      return {
        entityType: 'BILL',
        label,
        ...(resolved.length === 1 ? { canonicalId: resolved[0]!.id } : {}),
      };
    });
  }
  return distinctMatches(text, BILL_PATTERN).map((label) => ({
    entityType: 'BILL',
    label,
    canonicalId: normalizeBillReference(label),
  }));
}

function programElementEntities(text: string): PublicHearingEntity[] {
  return distinctMatches(text, PROGRAM_ELEMENT_PATTERN).map((label) => ({
    entityType: 'PROGRAM_ELEMENT',
    label,
    canonicalId: label.toUpperCase(),
  }));
}

function amountEntities(text: string): PublicHearingEntity[] {
  return distinctMatches(text, AMOUNT_PATTERN).map((label) => ({
    entityType: 'AMOUNT',
    label,
  }));
}

function deadlineEntities(text: string): PublicHearingEntity[] {
  return distinctMatches(text, DEADLINE_PATTERN).map((label) => ({
    entityType: 'DATE',
    label,
  }));
}

function agencyEntities(text: string): PublicHearingEntity[] {
  const lower = text.toLowerCase();
  return AGENCIES.filter((agency) =>
    agency.aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`, 'i').test(lower);
    }),
  ).map((agency) => ({
    entityType: 'AGENCY',
    label: agency.label,
    canonicalId: agency.label,
  }));
}

function uniqueEntities(entities: PublicHearingEntity[]): PublicHearingEntity[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    const key = `${entity.entityType}:${entity.canonicalId ?? entity.label}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function segmentEntities(text: string, context?: PublicHearingContext): PublicHearingEntity[] {
  return uniqueEntities([
    ...billEntities(text, context),
    ...programElementEntities(text),
    ...amountEntities(text),
    ...deadlineEntities(text),
    ...agencyEntities(text),
  ]);
}

function questionDraft(
  sentence: string,
  segment: PublicTranscriptSegmentInput,
  entities: PublicHearingEntity[],
): PublicHearingInsightDraft | null {
  if (!sentence.endsWith('?') && !QUESTION_START_PATTERN.test(sentence)) return null;
  return {
    insightType: 'QUESTION',
    title: segment.speakerName
      ? `Question from ${segment.speakerName}`
      : 'Question raised during the hearing',
    summary: sentence,
    evidenceText: sentence,
    speakerName: segment.speakerName,
    confidence: confidence(segment, sentence.endsWith('?') ? 1 : 0.88),
    preliminary: !segment.isFinal,
    entities,
  };
}

function commitmentDraft(
  sentence: string,
  segment: PublicTranscriptSegmentInput,
  entities: PublicHearingEntity[],
): PublicHearingInsightDraft | null {
  if (!COMMITMENT_PATTERN.test(sentence)) return null;
  return {
    insightType: 'COMMITMENT',
    title: 'Commitment or expected action stated',
    summary: sentence,
    evidenceText: sentence,
    speakerName: segment.speakerName,
    confidence: confidence(segment, 0.94),
    preliminary: !segment.isFinal,
    entities,
  };
}

function deadlineDraft(
  sentence: string,
  segment: PublicTranscriptSegmentInput,
  entities: PublicHearingEntity[],
): PublicHearingInsightDraft | null {
  const dates = deadlineEntities(sentence);
  if (!dates.length) return null;
  return {
    insightType: 'DEADLINE',
    title: `Deadline referenced: ${dates[0]?.label ?? 'timing commitment'}`,
    summary: sentence,
    evidenceText: sentence,
    speakerName: segment.speakerName,
    confidence: confidence(segment, 0.92),
    preliminary: !segment.isFinal,
    entities: uniqueEntities([...entities, ...dates]),
  };
}

function policyDraft(
  sentence: string,
  segment: PublicTranscriptSegmentInput,
  entities: PublicHearingEntity[],
): PublicHearingInsightDraft | null {
  if (!POLICY_POSITION_PATTERN.test(sentence)) return null;
  return {
    insightType: 'POLICY_POSITION',
    title: 'Policy position stated',
    summary: sentence,
    evidenceText: sentence,
    speakerName: segment.speakerName,
    confidence: confidence(segment, 0.86),
    preliminary: !segment.isFinal,
    entities,
  };
}

/**
 * Deterministic public-fact extraction that always runs before optional model
 * extractors. It produces no tenant/client relevance and can be replayed over the
 * canonical transcript without consulting private context.
 */
export function extractDeterministicPublicHearingInsights(input: {
  segment: PublicTranscriptSegmentInput;
  context: PublicHearingContext;
}): PublicHearingInsightDraft[] {
  const text = normalizeWhitespace(input.segment.text);
  if (!text) return [];
  const drafts: PublicHearingInsightDraft[] = [];
  const allEntities = segmentEntities(text, input.context);
  const sentenceList = sentences(text);

  for (const sentence of sentenceList) {
    const entities = segmentEntities(sentence, input.context);
    const question = questionDraft(sentence, input.segment, entities);
    const commitment = commitmentDraft(sentence, input.segment, entities);
    const deadline = deadlineDraft(sentence, input.segment, entities);
    const policy = policyDraft(sentence, input.segment, entities);
    if (question) drafts.push(question);
    if (commitment) drafts.push(commitment);
    if (deadline) drafts.push(deadline);
    if (policy) drafts.push(policy);
  }

  const bills = billEntities(text, input.context);
  for (const bill of bills) {
    drafts.push({
      insightType: 'BILL_REFERENCE',
      title: `${bill.label} referenced`,
      summary: `${bill.label} was referenced during the proceeding.`,
      evidenceText: text,
      speakerName: input.segment.speakerName,
      confidence: confidence(input.segment, 0.98),
      preliminary: !input.segment.isFinal,
      entities: [bill],
    });
  }

  const programElements = programElementEntities(text);
  for (const programElement of programElements) {
    drafts.push({
      insightType: 'PROGRAM_ELEMENT_REFERENCE',
      title: `Program Element ${programElement.label} referenced`,
      summary: `${programElement.label} was referenced during the proceeding.`,
      evidenceText: text,
      speakerName: input.segment.speakerName,
      confidence: confidence(input.segment, 0.99),
      preliminary: !input.segment.isFinal,
      entities: [programElement],
    });
  }

  const amounts = amountEntities(text);
  for (const amount of amounts) {
    drafts.push({
      insightType: 'FUNDING_AMOUNT',
      title: `${amount.label} funding amount referenced`,
      summary: text,
      evidenceText: text,
      speakerName: input.segment.speakerName,
      confidence: confidence(input.segment, 0.96),
      preliminary: !input.segment.isFinal,
      entities: uniqueEntities([amount, ...allEntities]),
    });
  }

  const agencies = agencyEntities(text);
  for (const agency of agencies) {
    drafts.push({
      insightType: 'AGENCY_REFERENCE',
      title: `${agency.label} referenced`,
      summary: text,
      evidenceText: text,
      speakerName: input.segment.speakerName,
      confidence: confidence(input.segment, 0.9),
      preliminary: !input.segment.isFinal,
      entities: uniqueEntities([agency, ...allEntities]),
    });
  }

  const material =
    bills.length > 0 ||
    programElements.length > 0 ||
    amounts.length > 0 ||
    agencies.length > 0 ||
    drafts.some((draft) =>
      ['COMMITMENT', 'DEADLINE', 'POLICY_POSITION'].includes(draft.insightType),
    );
  if (material && text.length >= 40) {
    drafts.push({
      insightType: 'KEY_QUOTE',
      title: input.segment.speakerName
        ? `Material statement from ${input.segment.speakerName}`
        : 'Material statement',
      summary: text,
      evidenceText: text,
      speakerName: input.segment.speakerName,
      confidence: confidence(input.segment, 0.84),
      preliminary: !input.segment.isFinal,
      entities: allEntities,
    });
  }

  return drafts;
}
