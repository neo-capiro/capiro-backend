import { runClaimPlanGate } from './claim-gate';
import {
  compilePeFundingEvidence,
  type ClaimPlan,
  type EvidencePacket,
  type PlannedClaim,
} from './evidence';

const CAPTURED = '2026-07-12T00:00:00Z';

// Evidence: FY27 request 72.1, HAC-D mark 112.9 (a RAISE), and a rule_failed bill.
const fundingPackets = compilePeFundingEvidence({
  peCode: '0603851F',
  identifierKind: 'pe',
  capturedAt: CAPTURED,
  currentCycleFy: 2027,
  years: [{ fy: 2027, request: 72.1, hacDMark: 112.9 }],
});
const procPackets = compilePeFundingEvidence({
  peCode: '1507N2280',
  identifierKind: 'procurement_line_item',
  capturedAt: CAPTURED,
  currentCycleFy: 2027,
  years: [{ fy: 2027, request: 10, hacDMark: 12 }],
});
const billPacket: EvidencePacket = {
  evidenceId: 'hr-8800-119:status',
  source: {
    tool: 'get_bill_status',
    recordId: 'hr-8800-119',
    contentHash: 'x',
    capturedAt: CAPTURED,
  },
  entity: { entityType: 'bill', entityId: 'hr-8800-119', identifierKind: 'bill' },
  semantics: { status: 'rule_failed', asOf: '2026-06-12' },
  provenance: { extractionMethod: 'structured_db', evidenceClass: 'authoritative' },
};
const provisionPacket: EvidencePacket = {
  evidenceId: 'prov-1',
  source: {
    tool: 'get_pe_report_language',
    recordId: 'prov-1',
    contentHash: 'y',
    capturedAt: CAPTURED,
  },
  entity: { entityType: 'program_element', entityId: '0603851F', identifierKind: 'pe' },
  semantics: { matchBasis: 'program_alias', reviewStatus: 'candidate' },
  provenance: { extractionMethod: 'structured_db', evidenceClass: 'candidate' },
};

const allPackets = [...fundingPackets, ...procPackets, billPacket, provisionPacket];
const hacdId = '0603851F:2027:HAC-D';

const claim = (over: Partial<PlannedClaim>): PlannedClaim => ({
  claimId: 'c1',
  subject: { entityType: 'program_element', entityId: '0603851F' },
  predicate: 'funding_direction_vs_request',
  object: {},
  qualifiers: {},
  evidenceIds: [hacdId],
  inference: false,
  importance: 'load_bearing',
  ...over,
});

const plan = (claims: PlannedClaim[]): ClaimPlan => ({
  planId: 'p1',
  surface: 'memo',
  claims,
  recommendations: [],
});

describe('runClaimPlanGate — funding_direction_vs_request', () => {
  it('APPROVES a claim matching the source-derived direction', () => {
    const r = runClaimPlanGate(
      plan([claim({ object: { direction: 'increase', fiscalYear: 2027 } })]),
      allPackets,
    );
    expect(r.approved).toEqual(['c1']);
    expect(r.decision).toBe('approve_all');
  });
  it('REFUTES + BLOCKS a load-bearing reversed direction (the S1-3 class)', () => {
    const r = runClaimPlanGate(
      plan([claim({ object: { direction: 'decrease', fiscalYear: 2027 } })]),
      allPackets,
    );
    expect(r.refuted).toEqual(['c1']);
    expect(r.decision).toBe('block');
  });
  it('marks UNSUPPORTED when no cited packet carries a comparison', () => {
    const r = runClaimPlanGate(
      plan([
        claim({
          evidenceIds: ['0603851F:2027:request'],
          object: { direction: 'increase', fiscalYear: 2027 },
        }),
      ]),
      allPackets,
    );
    expect(r.unsupported).toEqual(['c1']);
  });
});

describe('runClaimPlanGate — bill_status / rule_operative', () => {
  it('REFUTES claiming a rule is operative when the bill is rule_failed', () => {
    const r = runClaimPlanGate(
      plan([
        claim({
          predicate: 'rule_operative',
          evidenceIds: ['hr-8800-119:status'],
          object: { operative: true },
        }),
      ]),
      allPackets,
    );
    expect(r.refuted).toEqual(['c1']);
    expect(r.decision).toBe('block');
  });
  it('APPROVES an honest rule_failed status claim', () => {
    const r = runClaimPlanGate(
      plan([
        claim({
          predicate: 'bill_status',
          evidenceIds: ['hr-8800-119:status'],
          object: { status: 'rule_failed' },
        }),
      ]),
      allPackets,
    );
    expect(r.approved).toEqual(['c1']);
  });
});

describe('runClaimPlanGate — identifier_kind', () => {
  it('REFUTES calling a procurement line item a PE', () => {
    const r = runClaimPlanGate(
      plan([
        claim({
          predicate: 'identifier_kind',
          subject: { entityType: 'program_element', entityId: '1507N2280' },
          evidenceIds: ['1507N2280:2027:HAC-D'],
          object: { kind: 'pe' },
        }),
      ]),
      allPackets,
    );
    expect(r.refuted).toEqual(['c1']);
  });
});

describe('runClaimPlanGate — provision_directs_pe', () => {
  it('REFUTES a "confirmed" attribution over a program-level/candidate link', () => {
    const r = runClaimPlanGate(
      plan([
        claim({
          predicate: 'provision_directs_pe',
          evidenceIds: ['prov-1'],
          object: { peCode: '0603851F', confirmed: true },
          importance: 'supporting',
        }),
      ]),
      allPackets,
    );
    expect(r.refuted).toEqual(['c1']);
    // non-load-bearing refuted → repair, not block
    expect(r.decision).toBe('repair');
  });
});

describe('runClaimPlanGate — inference + skeptic routing + mixed plans', () => {
  it('passes a labeled inference without gating it as a fact', () => {
    const r = runClaimPlanGate(
      plan([claim({ inference: true, object: { direction: 'decrease' } })]),
      allPackets,
    );
    expect(r.approved).toEqual(['c1']);
  });
  it('routes an unmodeled predicate to the skeptic (does not block)', () => {
    const r = runClaimPlanGate(
      plan([
        claim({
          predicate: 'member_represents_district',
          object: { member: 'X', district: 'AL-05' },
        }),
      ]),
      allPackets,
    );
    expect(r.needsSkeptic).toEqual(['c1']);
    expect(r.decision).toBe('approve_all');
  });
  it('a load-bearing refutation anywhere in the plan blocks the whole plan', () => {
    const r = runClaimPlanGate(
      plan([
        claim({ claimId: 'good', object: { direction: 'increase', fiscalYear: 2027 } }),
        claim({ claimId: 'bad', object: { direction: 'decrease', fiscalYear: 2027 } }),
      ]),
      allPackets,
    );
    expect(r.approved).toContain('good');
    expect(r.refuted).toContain('bad');
    expect(r.decision).toBe('block');
  });
});
