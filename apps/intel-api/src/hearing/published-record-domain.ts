import { BadRequestException } from '@nestjs/common';
import { digest, object } from '../tracker/reports/report-domain.js';
export type AssessmentOutcome =
  | 'supported'
  | 'partially_supported'
  | 'contradicted'
  | 'not_addressed'
  | 'pending_records'
  | 'needs_review'
  | 'capiro_analysis';
export type RecordReference = { id: string; hash: string; locator: string };
export type RecordSourceSelection = { identity: string; locators: string[] | null };
export type PublishedRecord = {
  id: string;
  billId: string | null;
  kind: string;
  hash: string;
  identity: string;
  date: string | null;
  observedAt: string;
  evidence: Record<string, unknown>;
  association: 'explicit_event' | 'bill_context_only';
};
export type RecordClaim = {
  id: string;
  text: string;
  kind: 'fact' | 'quote' | 'analysis';
  scope: 'bill_record' | 'hearing_event';
  billId: string | null;
  references: RecordReference[];
  proposition?: {
    field: string;
    expected: string | number | boolean;
    body: string;
    motion: string;
    date: string;
  };
};
export type RecordAssessment = {
  claimId: string;
  claimHash: string;
  outcome: AssessmentOutcome;
  rationale: string;
  supported: string[];
  unresolved: string[];
  references: RecordReference[];
  requiresReview: boolean;
  ruleVersion: string;
};
export function sourcePassage(record: PublishedRecord, locator: string): string | null {
  if (record.evidence.selectedPassages) {
    const value = object(record.evidence.selectedPassages)[locator];
    return typeof value === 'string' ? value : null;
  }
  if (locator === 'record' && ['action', 'amendment', 'vote'].includes(record.kind)) {
    const { members, sections, raw, ...summary } = record.evidence;
    return JSON.stringify(summary);
  }
  if (record.kind === 'vote' && locator.startsWith('member:')) {
    const member = (
      Array.isArray(record.evidence.members) ? record.evidence.members.map(object) : []
    ).find((m) => String(m.providerPersonId) === locator.slice(7));
    return member ? JSON.stringify(member) : null;
  }
  if (record.kind === 'document') {
    const sections = Array.isArray(record.evidence.sections)
      ? record.evidence.sections.map(object)
      : [];
    const [base, range] = locator.split('#characters:'),
      section = sections.find((s) => s.locator === base);
    if (typeof section?.text !== 'string') return null;
    if (range) {
      if (!/^\d+-\d+$/.test(range)) return null;
      const [start, end] = range.split('-').map(Number);
      return start! >= 0 && end! > start! && end! <= section.text.length
        ? section.text.slice(start, end)
        : null;
    }
    return section.text;
  }
  if (record.kind === 'official_transcript' && /^characters:\d+-\d+$/.test(locator)) {
    const [from, to] = locator.slice(11).split('-').map(Number);
    const text = String(record.evidence.text ?? '');
    return from! >= 0 && to! > from! && to! <= text.length ? text.slice(from, to) : null;
  }
  return null;
}
export function validateRecordClaims(
  claims: RecordClaim[],
  records: PublishedRecord[],
  allowUnresolved = false,
) {
  if (
    !claims.length ||
    claims.length > (allowUnresolved ? 500 : 100) ||
    new Set(claims.map((c) => c.id)).size !== claims.length
  )
    throw new BadRequestException('BOUNDED_ATOMIC_CLAIMS_REQUIRED');
  for (const c of claims) {
    if (
      !c.id ||
      !c.text?.trim() ||
      c.text.length > 2500 ||
      !['fact', 'quote', 'analysis'].includes(c.kind) ||
      !['bill_record', 'hearing_event'].includes(c.scope) ||
      !Array.isArray(c.references) ||
      c.references.length > 20
    )
      throw new BadRequestException('INVALID_RECORD_CLAIM');
    if (!allowUnresolved && c.kind !== 'analysis' && !c.references.length)
      throw new BadRequestException('FACT_REQUIRES_RECORD_REFERENCES');
    for (const ref of c.references) {
      const record = records.find((r) => r.id === ref.id && r.hash === ref.hash);
      if (
        !record ||
        (c.billId && record.billId !== c.billId) ||
        sourcePassage(record, ref.locator) === null
      )
        throw new BadRequestException('RECORD_REFERENCE_OR_LOCATOR_MISMATCH');
    }
    if (
      c.kind === 'quote' &&
      !c.references.some((ref) =>
        sourcePassage(records.find((r) => r.id === ref.id)!, ref.locator)?.includes(c.text),
      )
    )
      throw new BadRequestException('QUOTE_MUST_MATCH_SOURCE_RANGE');
  }
}
/** Structured matches are confined to the precisely identified proposition.
 * Semantic text is a review candidate, never a confidence-based fact repair. */
export function assessRecordClaim(
  claim: RecordClaim,
  records: PublishedRecord[],
  availability: string,
): RecordAssessment {
  const base: RecordAssessment = {
    claimId: claim.id,
    claimHash: digest(claim),
    outcome: 'needs_review',
    rationale: 'Review the precise statement, source context and evidence scope.',
    supported: [],
    unresolved: [claim.text],
    references: claim.references,
    requiresReview: true,
    ruleVersion: 'published-record-identity-v1',
  };
  if (claim.kind === 'analysis')
    return {
      ...base,
      outcome: 'capiro_analysis',
      rationale: 'Capiro analysis; no legislative fact is established by this interpretation.',
      requiresReview: false,
    };
  if (!claim.references.length)
    return {
      ...base,
      outcome: availability === 'pending' ? 'pending_records' : 'needs_review',
      rationale:
        availability === 'failed'
          ? 'Source retrieval failed; absence is not evidence against the statement.'
          : 'Relevant published evidence remains pending or outside available coverage.',
    };
  const cited = claim.references
    .map((ref) => records.find((r) => r.id === ref.id && r.hash === ref.hash))
    .filter((r): r is PublishedRecord => !!r);
  if (
    cited.length !== claim.references.length ||
    (claim.scope === 'hearing_event' && cited.some((r) => r.association !== 'explicit_event'))
  )
    return {
      ...base,
      rationale:
        'The record is not unambiguously associated with this hearing. A shared bill or agenda is insufficient.',
    };
  const p = claim.proposition;
  if (!p || !['yeas', 'nays', 'nv', 'absent', 'passed', 'adopted', 'motion'].includes(p.field))
    return base;
  const exact = cited.filter(
    (r) =>
      r.billId === claim.billId &&
      r.date === p.date &&
      r.evidence.chamber === p.body &&
      r.evidence.motion === p.motion,
  );
  if (!exact.length || exact.some((r) => r.evidence[p.field] == null))
    return {
      ...base,
      rationale: 'Subject, body, motion, date or the requested source field remains unresolved.',
    };
  if (p.field === 'adopted' && p.expected === true && exact.some((r) => r.evidence.adopted === false))
    return { ...base, rationale: 'Not marked adopted is not rejection or proof of non-adoption. A qualified disposition record is required.' };
  const values = new Set(exact.map((r) => JSON.stringify(r.evidence[p.field])));
  if (values.size > 1)
    return {
      ...base,
      rationale:
        'Cited source versions disagree about this proposition. Source conflict requires review.',
    };
  const supported = exact.every((r) => r.evidence[p.field] === p.expected);
  return {
    ...base,
    outcome: supported ? 'supported' : 'contradicted',
    supported: supported ? [claim.text] : [],
    unresolved: supported ? [] : [claim.text],
    rationale: supported
      ? 'The matched structured record supports this exact field and context.'
      : 'The matched structured record asserts a different value for this field and context.',
    requiresReview: !supported || ['passed', 'adopted', 'motion'].includes(p.field),
  };
}
