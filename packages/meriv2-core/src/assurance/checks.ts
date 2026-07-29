import type { AuditFinding } from '../grounding/auditor';
import type { AssuredClaim, ClaimLedger } from './claim-ledger';

export type LegislativeStatus =
  | 'introduced'
  | 'committee'
  | 'reported'
  | 'passed_one_chamber'
  | 'passed_both_chambers'
  | 'conference'
  | 'executive_action'
  | 'enacted'
  | 'failed'
  | 'vetoed'
  | 'unknown';

export type StructuredAssuranceFact =
  | {
      kind: 'bill_status';
      evidenceId: string;
      billId: string;
      jurisdiction: 'federal' | 'state' | 'local';
      status: LegislativeStatus;
      statusAt?: string;
      publicLawOrChapter?: string;
      signedAt?: string;
      ruleStatus?: 'adopted' | 'failed' | 'pending' | 'not_applicable';
      companionBillId?: string;
      targetBillId?: string;
    }
  | {
      kind: 'vote';
      evidenceId: string;
      voteId?: string;
      billId?: string;
      memberId?: string;
      voteRecorded: boolean;
      passed?: boolean;
      position?: string;
      voteDate?: string;
    }
  | {
      kind: 'budget_position';
      evidenceId: string;
      subjectId: string;
      identifierKind: 'program_element' | 'procurement_line' | 'budget_line' | 'account';
      fiscalYear?: number;
      stage?: string;
      vehicleClass?: 'request' | 'authorization' | 'appropriation' | 'interim_funding' | 'supplemental' | 'reconciliation';
      scope?: string;
      amount?: number;
      units?: 'dollars' | 'thousands' | 'millions';
      appropriationCategory?: 'rdte' | 'procurement' | 'om' | 'milcon' | 'other';
      reportId?: string;
      reportSubjectId?: string;
    }
  | {
      kind: 'entity_role';
      evidenceId: string;
      entityId?: string;
      label: string;
      canonical: boolean;
      ambiguous: boolean;
      role?: string;
      current?: boolean;
      asOf?: string;
    }
  | {
      kind: 'district_representation';
      evidenceId: string;
      facilityId?: string;
      districtId?: string;
      representativeId?: string;
      deterministicJoin: boolean;
      asOf?: string;
    }
  | {
      kind: 'regulatory_window';
      evidenceId: string;
      docketId: string;
      stage: 'proposed' | 'final' | 'effective' | 'withdrawn' | 'unknown';
      commentDeadline?: string;
      effectiveDate?: string;
      timezone?: string;
      asOf?: string;
    }
  | {
      kind: 'coverage';
      evidenceId: string;
      description: string;
      complete: boolean;
      truncated: boolean;
      failedSources: string[];
      empty: boolean;
    };

export interface GovernmentAffairsCheckInput {
  ledger: ClaimLedger;
  facts: readonly StructuredAssuranceFact[];
  outputText?: string;
  now?: string | Date;
}

export const GOVERNMENT_AFFAIRS_CHECK_IDS = [
  'GA-L1-enactment-proof',
  'GA-L2-stage-ordering',
  'GA-L3-failed-rule',
  'GA-L4-no-recorded-vote',
  'GA-L5-companion-target',
  'GA-B1-authorization-appropriation',
  'GA-B2-budget-dimensions',
  'GA-B3-delta-comparability',
  'GA-B4-pe-procurement-identity',
  'GA-B5-appropriation-category',
  'GA-B6-report-language-attribution',
  'GA-B7-negative-funding-coverage',
  'GA-E1-entity-resolution',
  'GA-E2-current-role-asof',
  'GA-E3-district-determinism',
  'GA-R1-deadline-timezone',
  'GA-R2-regulatory-stage',
  'GA-R3-open-window',
  'GA-A1-negative-coverage',
  'GA-A2-tool-empty-failure',
] as const;

export function runGovernmentAffairsChecks(
  input: GovernmentAffairsCheckInput,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const factsByEvidence = new Map<string, StructuredAssuranceFact[]>();
  for (const fact of input.facts) {
    const bucket = factsByEvidence.get(fact.evidenceId) ?? [];
    bucket.push(fact);
    factsByEvidence.set(fact.evidenceId, bucket);
  }
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());

  for (const claim of input.ledger.claims) {
    const facts = claim.sourceIds.flatMap((id) => factsByEvidence.get(id) ?? []);
    findings.push(...checkLegislativeClaim(claim, facts));
    findings.push(...checkBudgetClaim(claim, facts));
    findings.push(...checkEntityClaim(claim, facts));
    findings.push(...checkRegulatoryClaim(claim, facts, now));
    findings.push(...checkCoverageClaim(claim, facts));
  }

  const output = input.outputText ?? input.ledger.claims.map((claim) => claim.text).join('\n');
  findings.push(...checkAuthorizationAppropriationText(output));
  return dedupe(findings);
}

function checkLegislativeClaim(
  claim: AssuredClaim,
  facts: readonly StructuredAssuranceFact[],
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const bills = facts.filter(isBillFact);
  const votes = facts.filter(isVoteFact);
  const lower = claim.text.toLowerCase();

  if (claim.category === 'enactment' || /\b(?:enacted|became\s+law|signed\s+into\s+law|public\s+law|chaptered)\b/i.test(claim.text)) {
    const proof = bills.some(
      (bill) =>
        bill.status === 'enacted' &&
        Boolean(bill.publicLawOrChapter || bill.signedAt),
    );
    if (!proof) {
      out.push(finding(
        'GA-L1-enactment-proof',
        'critical',
        claim.text,
        'Enactment is asserted without retrieved public-law, chapter, signed, or equivalent enacted proof.',
      ));
    }
  }

  const claimedRank = statusPhraseRank(claim.text);
  if (claimedRank >= 0 && bills.length) {
    const maxRetrieved = Math.max(...bills.map((bill) => statusRank(bill.status)));
    if (claimedRank > maxRetrieved) {
      out.push(finding(
        'GA-L2-stage-ordering',
        'high',
        claim.text,
        `The claim describes a later legislative stage (${claimedRank}) than the retrieved target-bill evidence (${maxRetrieved}).`,
      ));
    }
  }

  if (
    bills.some((bill) => bill.ruleStatus === 'failed') &&
    /\b(?:advanced|cleared\s+the\s+way|moved\s+to\s+the\s+floor|will\s+receive\s+a\s+floor\s+vote|rule\s+adopted)\b/i.test(claim.text)
  ) {
    out.push(finding(
      'GA-L3-failed-rule',
      'critical',
      claim.text,
      'A failed House or state procedural rule cannot be described as operative advancement.',
    ));
  }

  if (/\b(?:passed|failed|approved|rejected)\b.*\b(?:vote|roll\s*call|\d+[-–]\d+)\b/i.test(claim.text)) {
    if (!votes.some((vote) => vote.voteRecorded)) {
      out.push(finding(
        'GA-L4-no-recorded-vote',
        'high',
        claim.text,
        'The claim narrates a vote outcome or tally but the supporting evidence contains no recorded vote.',
      ));
    }
  }

  for (const bill of bills) {
    if (!bill.companionBillId || !bill.targetBillId || bill.companionBillId === bill.targetBillId) continue;
    const namesCompanion = lower.includes(bill.companionBillId.toLowerCase());
    const namesTarget = lower.includes(bill.targetBillId.toLowerCase());
    if (namesTarget && !namesCompanion && claim.sourceIds.includes(bill.evidenceId)) {
      out.push(finding(
        'GA-L5-companion-target',
        'high',
        claim.text,
        `The evidence is for companion ${bill.companionBillId}, not target ${bill.targetBillId}; companion status cannot be transferred to the target bill.`,
      ));
    }
  }
  return out;
}

function checkBudgetClaim(
  claim: AssuredClaim,
  facts: readonly StructuredAssuranceFact[],
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const positions = facts.filter(isBudgetFact);
  const budgetClaim = ['budget_amount', 'budget_delta', 'report_language'].includes(claim.category) || /(?:\$|\b(?:funding|budget|appropriat|authoriz|request|mark|program\s+element|procurement\s+line)\b)/i.test(claim.text);
  if (!budgetClaim) return out;

  for (const position of positions) {
    const missing = [
      position.fiscalYear == null ? 'fiscalYear' : null,
      !position.stage ? 'stage' : null,
      !position.vehicleClass ? 'vehicleClass' : null,
      !position.scope ? 'scope' : null,
      position.amount == null ? 'amount' : null,
      !position.units ? 'units' : null,
    ].filter(Boolean);
    if (missing.length) {
      out.push(finding(
        'GA-B2-budget-dimensions',
        'high',
        claim.text,
        `Budget evidence is missing required dimensions: ${missing.join(', ')}.`,
      ));
    }

    if (
      position.identifierKind === 'procurement_line' &&
      /\b(?:program\s+element|\bPE\b)\b/i.test(claim.text)
    ) {
      out.push(finding(
        'GA-B4-pe-procurement-identity',
        'high',
        claim.text,
        `${position.subjectId} is a procurement line item, not an R-1/R-2 Program Element.`,
      ));
    }
    if (
      position.identifierKind === 'program_element' &&
      /\b(?:procurement\s+line|P-?1\s+line)\b/i.test(claim.text)
    ) {
      out.push(finding(
        'GA-B4-pe-procurement-identity',
        'high',
        claim.text,
        `${position.subjectId} is a Program Element, not a procurement line item.`,
      ));
    }

    if (position.appropriationCategory === 'rdte' && /\b(?:buy|purchase|procure|fielded\s+end\s+items?)\b/i.test(claim.text)) {
      out.push(finding(
        'GA-B5-appropriation-category',
        'high',
        claim.text,
        'The recommendation treats RDT&E funding as end-item procurement. Validate the correct appropriation category and vehicle.',
      ));
    }
    if (
      claim.category === 'report_language' &&
      position.reportSubjectId &&
      position.reportSubjectId !== position.subjectId
    ) {
      out.push(finding(
        'GA-B6-report-language-attribution',
        'high',
        claim.text,
        `The retrieved report language is attributed to ${position.reportSubjectId}, not ${position.subjectId}.`,
      ));
    }
  }

  if (claim.category === 'budget_delta' && positions.length >= 2) {
    const [first, ...rest] = positions;
    const mismatch = rest.some(
      (item) =>
        item.fiscalYear !== first!.fiscalYear ||
        item.scope !== first!.scope ||
        item.units !== first!.units,
    );
    if (mismatch) {
      out.push(finding(
        'GA-B3-delta-comparability',
        'critical',
        claim.text,
        'The asserted budget delta compares different fiscal years, scopes, or units. Those positions cannot be subtracted.',
      ));
    }
  }

  if (/\b(?:no|zero|none|not\s+funded|no\s+funding|no\s+appropriation|no\s+request)\b/i.test(claim.text)) {
    const coverage = facts.filter(isCoverageFact);
    if (!coverage.some(coverageComplete)) {
      out.push(finding(
        'GA-B7-negative-funding-coverage',
        'high',
        claim.text,
        'A negative funding assertion requires coverage of the relevant fiscal years, vehicles, stages, and documents; partial or empty retrieval is insufficient.',
      ));
    }
  }
  return out;
}

function checkEntityClaim(
  claim: AssuredClaim,
  facts: readonly StructuredAssuranceFact[],
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const roles = facts.filter(isRoleFact);
  for (const role of roles) {
    if (!role.canonical || role.ambiguous) {
      out.push(finding(
        'GA-E1-entity-resolution',
        'high',
        claim.text,
        `The named entity "${role.label}" is unresolved or ambiguous and must not be guessed.`,
      ));
    }
    if (claim.category === 'current_role' || /\b(?:current|now|today|chair|ranking\s+member)\b/i.test(claim.text)) {
      if (role.current !== true || !role.asOf) {
        out.push(finding(
          'GA-E2-current-role-asof',
          'high',
          claim.text,
          `A current-role claim for "${role.label}" lacks a current roster verdict and as-of date.`,
        ));
      }
    }
  }
  for (const district of facts.filter(isDistrictFact)) {
    if (!district.deterministicJoin || !district.facilityId || !district.districtId || !district.representativeId) {
      out.push(finding(
        'GA-E3-district-determinism',
        'high',
        claim.text,
        'District representation must come from the deterministic facility/geospatial/roster join, not name or location inference.',
      ));
    }
  }
  return out;
}

function checkRegulatoryClaim(
  claim: AssuredClaim,
  facts: readonly StructuredAssuranceFact[],
  now: Date,
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const windows = facts.filter(isRegulatoryFact);
  for (const window of windows) {
    if (claim.category === 'regulatory_deadline' || /\b(?:deadline|due|comment\s+period|effective\s+date)\b/i.test(claim.text)) {
      const date = window.commentDeadline ?? window.effectiveDate;
      if (!date || !window.timezone) {
        out.push(finding(
          'GA-R1-deadline-timezone',
          'high',
          claim.text,
          'The regulatory deadline lacks an authoritative date or timezone normalization.',
        ));
      }
    }
    if (/\bproposed\b/i.test(claim.text) && window.stage !== 'proposed') {
      out.push(finding('GA-R2-regulatory-stage', 'high', claim.text, `The record is ${window.stage}, not proposed.`));
    }
    if (/\bfinal\s+rule\b/i.test(claim.text) && !['final', 'effective'].includes(window.stage)) {
      out.push(finding('GA-R2-regulatory-stage', 'high', claim.text, `The record is ${window.stage}, not a final rule.`));
    }
    if (/\b(?:open|accepting\s+comments|comment\s+period\s+is\s+open)\b/i.test(claim.text)) {
      const deadline = window.commentDeadline ? new Date(window.commentDeadline) : null;
      if (!deadline || Number.isNaN(deadline.getTime()) || deadline.getTime() < now.getTime()) {
        out.push(finding(
          'GA-R3-open-window',
          'high',
          claim.text,
          'The claim says the docket is open, but the authoritative comment window does not include the current as-of time.',
        ));
      }
    }
  }
  return out;
}

function checkCoverageClaim(
  claim: AssuredClaim,
  facts: readonly StructuredAssuranceFact[],
): AuditFinding[] {
  if (
    claim.category !== 'negative_or_exhaustive' &&
    !/\b(?:no|none|only|all|every|never|nothing|nobody|does\s+not\s+exist)\b/i.test(claim.text)
  ) {
    return [];
  }
  const coverage = facts.filter(isCoverageFact);
  const out: AuditFinding[] = [];
  if (!coverage.some(coverageComplete)) {
    out.push(finding(
      'GA-A1-negative-coverage',
      'high',
      claim.text,
      'An absence or exhaustive claim is unsupported because the retrieved source coverage is incomplete, truncated, or failed.',
    ));
  }
  if (coverage.some((item) => item.empty && (item.failedSources.length > 0 || !item.complete))) {
    out.push(finding(
      'GA-A2-tool-empty-failure',
      'high',
      claim.text,
      'An empty or failed query result is not authoritative proof that no record exists.',
    ));
  }
  return out;
}

export function checkAuthorizationAppropriationText(output: string): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const sentence of sentences(output)) {
    if (
      /\b(?:NDAA|HASC|SASC|authoriz\w*)\b[^.;]{0,60}\b(?:appropriat\w*|provided\s+the\s+funding|funded\s+the\s+program)\b/i.test(sentence) ||
      /\b(?:HAC-?D|SAC-?D|appropriat\w*)\b[^.;]{0,60}\b(?:authoriz\w*|set\s+policy|established\s+the\s+requirement)\b/i.test(sentence)
    ) {
      out.push(finding(
        'GA-B1-authorization-appropriation',
        'high',
        sentence,
        'Authorization and appropriation are distinct vehicles and effects; this sentence conflates them.',
      ));
    }
  }
  return out;
}

function statusPhraseRank(text: string): number {
  const phrases: Array<[RegExp, LegislativeStatus]> = [
    [/\b(?:enacted|became\s+law|signed\s+into\s+law|public\s+law|chaptered)\b/i, 'enacted'],
    [/\b(?:sent\s+to\s+the\s+(?:president|governor)|presented\s+for\s+signature)\b/i, 'executive_action'],
    [/\b(?:conference\s+report|resolved\s+differences|conference\s+agreement)\b/i, 'conference'],
    [/\b(?:passed\s+both\s+chambers|cleared\s+congress|enrolled)\b/i, 'passed_both_chambers'],
    [/\b(?:passed\s+the\s+(?:house|senate|assembly)|passed\s+one\s+chamber)\b/i, 'passed_one_chamber'],
    [/\b(?:reported\s+by|ordered\s+reported)\b/i, 'reported'],
    [/\b(?:referred\s+to|in\s+committee|committee\s+consideration)\b/i, 'committee'],
    [/\bintroduced\b/i, 'introduced'],
  ];
  return Math.max(-1, ...phrases.filter(([re]) => re.test(text)).map(([, status]) => statusRank(status)));
}

function statusRank(status: LegislativeStatus): number {
  const rank: Record<LegislativeStatus, number> = {
    unknown: 0,
    introduced: 1,
    committee: 2,
    reported: 3,
    passed_one_chamber: 4,
    passed_both_chambers: 5,
    conference: 6,
    executive_action: 7,
    enacted: 8,
    failed: 0,
    vetoed: 7,
  };
  return rank[status];
}

function coverageComplete(item: Extract<StructuredAssuranceFact, { kind: 'coverage' }>): boolean {
  return item.complete && !item.truncated && item.failedSources.length === 0;
}

function finding(
  check: string,
  severity: AuditFinding['severity'],
  span: string,
  detail: string,
): AuditFinding {
  return { check, severity, span: span.trim().slice(0, 500), detail };
}

function dedupe(findings: readonly AuditFinding[]): AuditFinding[] {
  const rank: Record<AuditFinding['severity'], number> = { critical: 3, high: 2, medium: 1, low: 0 };
  const seen = new Set<string>();
  return findings
    .filter((item) => {
      const key = `${item.check}:${item.span}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => rank[b.severity] - rank[a.severity] || a.check.localeCompare(b.check));
}

function sentences(text: string): string[] {
  return String(text ?? '').split(/(?<=[.!?])\s+|\n+/).map((value) => value.trim()).filter(Boolean);
}

function isBillFact(value: StructuredAssuranceFact): value is Extract<StructuredAssuranceFact, { kind: 'bill_status' }> {
  return value.kind === 'bill_status';
}
function isVoteFact(value: StructuredAssuranceFact): value is Extract<StructuredAssuranceFact, { kind: 'vote' }> {
  return value.kind === 'vote';
}
function isBudgetFact(value: StructuredAssuranceFact): value is Extract<StructuredAssuranceFact, { kind: 'budget_position' }> {
  return value.kind === 'budget_position';
}
function isRoleFact(value: StructuredAssuranceFact): value is Extract<StructuredAssuranceFact, { kind: 'entity_role' }> {
  return value.kind === 'entity_role';
}
function isDistrictFact(value: StructuredAssuranceFact): value is Extract<StructuredAssuranceFact, { kind: 'district_representation' }> {
  return value.kind === 'district_representation';
}
function isRegulatoryFact(value: StructuredAssuranceFact): value is Extract<StructuredAssuranceFact, { kind: 'regulatory_window' }> {
  return value.kind === 'regulatory_window';
}
function isCoverageFact(value: StructuredAssuranceFact): value is Extract<StructuredAssuranceFact, { kind: 'coverage' }> {
  return value.kind === 'coverage';
}
