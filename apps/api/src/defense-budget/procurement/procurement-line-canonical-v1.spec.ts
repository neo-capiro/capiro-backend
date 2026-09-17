import {
  compareProcurementProofPackSources,
  mapComposerDecisionV1,
  planProcurementLineCanonicalWrites,
  procurementCanonicalWritesEnabled,
  splitAppropriationAccount,
} from './procurement-line-canonical-v1.js';
import { composeLine68, line68Artifacts, LINE68 } from './procurement-line-canonical-v1.fixtures.js';

describe('procurement-line-canonical-v1 (pure planner)', () => {
  test('gate helper is exact-match on "1"', () => {
    expect(procurementCanonicalWritesEnabled({})).toBe(false);
    expect(procurementCanonicalWritesEnabled({ DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES: 'true' })).toBe(false);
    expect(procurementCanonicalWritesEnabled({ DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES: '1' })).toBe(true);
  });

  test('splits a printed appropriation account into code + title', () => {
    expect(splitAppropriationAccount('0300D: Procurement, Defense-Wide')).toEqual({
      code: '0300D',
      title: 'Procurement, Defense-Wide',
    });
    expect(splitAppropriationAccount(' 2031a ')).toEqual({ code: '2031A', title: null });
  });

  test('maps composer decisions onto the V1 PASS/REVIEW/REJECT vocabulary', () => {
    expect(mapComposerDecisionV1('VERIFICATION_PASSED')).toBe('PASS');
    expect(mapComposerDecisionV1('NEEDS_REVIEW')).toBe('REVIEW');
    expect(mapComposerDecisionV1('REJECTED')).toBe('REJECT');
  });

  test('PASS family: plans Line 68 with exact $M values and one citation per exhibit per FY', () => {
    const artifacts = line68Artifacts();
    const report = composeLine68(artifacts);
    expect(report.verification.decision).toBe('VERIFICATION_PASSED');

    const plan = planProcurementLineCanonicalWrites({ artifacts, report });
    expect(plan.decision).toBe('PASS');
    expect(plan.decisionSource).toBe('composer');
    expect(plan.lines).toHaveLength(1);
    const line = plan.lines[0]!;
    expect(line.appropriationCode).toBe('0300D');
    expect(line.appropriationTitle).toBe('Procurement, Defense-Wide');
    expect(line.lineItemNumber).toBe('0204WARSYS');
    expect(line.title).toBe(LINE68.title);
    expect(line.component).toBe('SOCOM');
    expect(line.p1LineNumber).toBe(68);
    expect(line.budgetActivity).toBe(LINE68.budgetActivity);
    // P-40 enriched the gaps the P-1 catalog row left empty.
    expect(line.budgetSubActivity).toBe(LINE68.budgetSubActivity);
    // Reference ONLY — never a PE row.
    expect(line.relatedPeCode).toBe('1160431BB');

    expect(plan.years.map((y) => [y.fy, y.sublineKey, y.values.request])).toEqual([
      [2025, '', '406.637'],
      [2026, '', '499.582'],
      [2027, '', '511.016'],
    ]);
    // Every year value has a P-1 AND a P-40 citation; both are kept (values agree).
    expect(plan.sources).toHaveLength(6);
    const fy27 = plan.sources.filter((s) => s.fy === 2027);
    expect(fy27.map((s) => s.exhibitType).sort()).toEqual(['P-1', 'P-40']);
    const p1 = fy27.find((s) => s.exhibitType === 'P-1')!;
    expect(p1.pageNumber).toBe(12);
    expect(p1.publisher).toBe('DoD Comptroller');
    expect(p1.sourceDocumentId).toBe('11111111-1111-4111-8111-111111111111');
    expect(p1.extractorVersion).toBe('deterministic_pdfplumber:1.2.3');
    expect(p1.metadata.valueMillions).toBe('511.016');
    expect(p1.metadata.originalUnit).toBe('thousands');
    expect(p1.sourceSpanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.counts).toMatchObject({ lines: 1, years: 3, yearValues: 3, sources: 6, pass: 6, review: 0, reject: 0 });
    expect(plan.skipped).toEqual([]);
  });

  test('P-40a subline lands on its own (fy, sublineKey) row; quantity is an integer column', () => {
    const artifacts = line68Artifacts({ withSubline: true, quantityFy2027: '0' });
    const report = composeLine68(artifacts);
    // The subline uses a distinct funding stage, so the composer has nothing to reconcile it against.
    expect(report.verification.decision).toBe('NEEDS_REVIEW');
    const clean = { ...report, verification: { decision: 'VERIFICATION_PASSED' as const, findings: [], blocking: false } };

    const plan = planProcurementLineCanonicalWrites({ artifacts, report: clean });
    const subline = plan.years.find((y) => y.sublineKey === 'P1');
    expect(subline).toMatchObject({ fy: 2027, sublineTitle: 'Satellite Deployable Node (SDN)', values: { request: '101.841' } });
    const total = plan.years.find((y) => y.fy === 2027 && y.sublineKey === '');
    expect(total?.quantity).toBe(0);
    const sublineSource = plan.sources.find((s) => s.yearKey === subline!.key);
    expect(sublineSource?.exhibitType).toBe('P-40A');
    expect(sublineSource?.pageNumber).toBe(206);
  });

  test('family REVIEW with scope=family plans nothing and says why', () => {
    const artifacts = line68Artifacts({ p40Fy2026: '372.991' });
    const report = composeLine68(artifacts);
    expect(report.verification.decision).toBe('NEEDS_REVIEW');

    const plan = planProcurementLineCanonicalWrites({ artifacts, report });
    expect(plan.lines).toEqual([]);
    expect(plan.years).toEqual([]);
    expect(plan.sources).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ scope: 'family', decision: 'REVIEW', reason: expect.stringContaining('scope=family') }),
    ]);
    expect(plan.counts.review).toBe(6);
    expect(plan.counts.pass).toBe(0);
  });

  test('scope=identity: a line named by a blocking finding is REJECT-skipped, a clean line still passes', () => {
    const artifacts = line68Artifacts({ p40Fy2026: '372.991', withLine69: true });
    const report = composeLine68(artifacts);
    expect(report.verification.decision).toBe('NEEDS_REVIEW');

    const plan = planProcurementLineCanonicalWrites({ artifacts, report, scope: 'identity' });
    expect(plan.lines.map((l) => l.lineItemNumber)).toEqual(['0206CMR']);
    expect(plan.years).toHaveLength(1);
    expect(plan.years[0]!.values.request).toBe('4.988');
    const rejected = plan.skipped.filter((s) => s.decision === 'REJECT');
    expect(rejected).toHaveLength(6); // 3 P-1 + 3 P-40 Line 68 funding assertions
    expect(rejected[0]!.reason).toContain('p1_p40_funding_mismatch');
    expect(rejected.every((s) => s.identityNaturalKey?.includes('0204WARSYS'))).toBe(true);
  });

  test('REJECT family (no P-1) plans nothing', () => {
    const artifacts = line68Artifacts({ omitP1: true });
    const report = composeLine68(artifacts);
    expect(report.verification.decision).toBe('REJECTED');

    const plan = planProcurementLineCanonicalWrites({ artifacts, report, scope: 'identity' });
    expect(plan.lines).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ scope: 'family', decision: 'REJECT' })]);
    expect(plan.counts.reject).toBe(3);
  });

  test('a value without page provenance is not planned; the FY still gets the other exhibit', () => {
    const artifacts = line68Artifacts({ missingPageFy: 2026 });
    const report = composeLine68(artifacts);
    expect(report.verification.decision).toBe('VERIFICATION_PASSED');

    const plan = planProcurementLineCanonicalWrites({ artifacts, report });
    const fy26 = plan.years.find((y) => y.fy === 2026)!;
    expect(fy26.values.request).toBe('499.582'); // from the P-40 citation
    expect(plan.sources.filter((s) => s.fy === 2026).map((s) => s.exhibitType)).toEqual(['P-40']);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ assertionId: 'p1_req_2026', decision: 'REVIEW', reason: expect.stringContaining('no page provenance') }),
    ]);
  });

  test('never reclassifies: an RDTE_PE identity inside a P-doc and an advance-procurement identity are skipped, not written', () => {
    const artifacts = line68Artifacts({ withRdtePeAssertion: true, withAdvanceProcurement: true });
    const report = composeLine68(artifacts);
    const clean = { ...report, verification: { decision: 'VERIFICATION_PASSED' as const, findings: [], blocking: false } };

    const plan = planProcurementLineCanonicalWrites({ artifacts, report: clean });
    expect(plan.lines.map((l) => l.lineItemNumber)).toEqual(['0204WARSYS']);
    expect(plan.years.every((y) => y.sublineKey === '')).toBe(true);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionId: 'p40_pe_leak', decision: 'UNSUPPORTED', reason: expect.stringContaining('RDTE_PE') }),
        expect.objectContaining({ assertionId: 'p40_ap_2027', decision: 'UNSUPPORTED', reason: expect.stringContaining('advance-procurement') }),
      ]),
    );
    expect(plan.counts.unsupported).toBe(2);
  });

  test('conflicting PASS values for one (year, field) are held back as REVIEW rather than picking a winner', () => {
    const artifacts = line68Artifacts({ p40Fy2026: '372.991' });
    const report = composeLine68(artifacts);
    // Pretend the family gate passed anyway — the planner must still refuse to choose.
    const clean = { ...report, verification: { decision: 'VERIFICATION_PASSED' as const, findings: [], blocking: false } };

    const plan = planProcurementLineCanonicalWrites({ artifacts, report: clean });
    expect(plan.years.map((y) => y.fy)).toEqual([2025, 2027]);
    const conflicts = plan.skipped.filter((s) => s.reason.startsWith('conflicting PASS values'));
    expect(conflicts.map((s) => s.assertionId).sort()).toEqual(['p1_req_2026', 'p40_req_2026']);
  });

  test('trusted gate overrides the composer decision and acceptedAssertionIds narrows eligibility', () => {
    const artifacts = line68Artifacts();
    const report = composeLine68(artifacts);

    const rejected = planProcurementLineCanonicalWrites({ artifacts, report, gate: { decision: 'REJECT' } });
    expect(rejected.decisionSource).toBe('gate');
    expect(rejected.lines).toEqual([]);

    const narrowed = planProcurementLineCanonicalWrites({
      artifacts,
      report,
      gate: { decision: 'PASS', acceptedAssertionIds: ['p1_req_2027', 'p40_req_2027'] },
    });
    expect(narrowed.years.map((y) => y.fy)).toEqual([2027]);
    expect(narrowed.skipped.filter((s) => s.reason.includes('acceptedAssertionIds'))).toHaveLength(4);
  });

  test('proof-pack comparator: exhibit order, then FY desc, then page asc', () => {
    const rows = [
      { exhibitType: 'P-5', fy: 2027, pageNumber: 3 },
      { exhibitType: 'P-40A', fy: 2027, pageNumber: 206 },
      { exhibitType: 'P-1', fy: 2026, pageNumber: 12 },
      { exhibitType: 'P-40', fy: 2027, pageNumber: 205 },
      { exhibitType: 'P-1', fy: 2027, pageNumber: 40 },
      { exhibitType: 'P-1', fy: 2027, pageNumber: 12 },
      { exhibitType: 'unknown', fy: null, pageNumber: null },
    ];
    const sorted = [...rows].sort(compareProcurementProofPackSources);
    expect(sorted.map((r) => `${r.exhibitType}:${r.fy}:${r.pageNumber}`)).toEqual([
      'P-1:2027:12',
      'P-1:2027:40',
      'P-1:2026:12',
      'P-40:2027:205',
      'P-40A:2027:206',
      'P-5:2027:3',
      'unknown:null:null',
    ]);
  });
});
