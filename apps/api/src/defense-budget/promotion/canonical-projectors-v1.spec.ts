/**
 * Phase 7 Workstreams F, G, H — the family projectors preserve native identity
 * and refuse rather than default.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OM_PROJECTOR_TARGETS_V1,
  PROCUREMENT_PROJECTOR_TARGETS_V1,
  RDTE_PROJECTOR_TARGETS_V1,
  projectOmCandidatesV1,
  projectProcurementCandidatesV1,
  projectRdteCandidatesV1,
  sumPositionMillionsV1,
  type ProjectionCandidateInputV1,
} from './canonical-projectors-v1.js';
import { lookupCanonicalMappingV1 } from './canonical-mapping-registry-v1.js';

const SHA = (c: string) => c.repeat(64);

function candidate(o: Partial<ProjectionCandidateInputV1> = {}): ProjectionCandidateInputV1 {
  return {
    candidateId: 'cand-1',
    target: 'ProgramElement',
    naturalKey: '0601101A',
    operation: 'insert',
    reason: 'test',
    artifactId: 'artifact-1',
    artifactContentSha256: SHA('a'),
    verificationCandidateId: 'vc-1',
    verificationRunId: 'vr-1',
    verificationDecisionId: 'vd-1',
    sourceDocumentKey: 'doc-1',
    sourcePdfSha256: SHA('b'),
    assertionIds: ['assert-1'],
    evidenceIds: ['ev-2', 'ev-1'],
    values: { peCode: '0601101A', title: 'A program' },
    ...o,
  };
}

const MONEY = { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' };

/* ------------------------------------------------------------------ */
/* F — RDT&E                                                           */
/* ------------------------------------------------------------------ */

describe('Phase 7 WS F — RDT&E projector', () => {
  it('projects PE identity to the RDT&E canonical entity', () => {
    const { projections, refusals } = projectRdteCandidatesV1([candidate()]);
    expect(refusals).toEqual([]);
    expect(projections).toHaveLength(1);
    expect(projections[0]?.projectionKind).toBe('rdte:ProgramElement');
    const lookup = lookupCanonicalMappingV1(projections[0]!.projectionKind);
    expect(lookup.supported && lookup.entry.canonicalEntity).toBe('canonical_rdte_program_element');
  });

  it('projects a PE-year position with exact money and a request field', () => {
    const { projections, refusals } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-year',
        target: 'ProgramElementYear',
        naturalKey: '0601101A|2027',
        values: { peCode: '0601101A', fiscalYear: 2027, ...MONEY },
      }),
    ]);
    expect(refusals).toEqual([]);
    const projection = projections[0];
    expect(projection?.fundingField).toBe('request');
    expect(projection?.fiscalYear).toBe(2027);
    expect(projection?.values.money).toEqual(MONEY);
  });

  it('scopes a project code to its parent PE', () => {
    const { projections } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-proj',
        target: 'ProgramElementProject',
        naturalKey: '0601101A|P123',
        values: { peCode: '0601101A', projectCode: 'P123', title: 'Project' },
      }),
    ]);
    expect(projections[0]?.parentNaturalKey).toBe('0601101A');
  });

  it('hangs a project-year position from the project, not the PE', () => {
    const { projections } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-ppos',
        target: 'ProgramElementProjectBudgetPosition',
        naturalKey: '0601101A|P123|pb_fy2027|2027|request',
        values: { peCode: '0601101A', projectCode: 'P123', fiscalYear: 2027, ...MONEY },
      }),
    ]);
    expect(projections[0]?.parentNaturalKey).toBe('0601101A|P123');
  });

  it('preserves performer role rather than relabelling it', () => {
    const { projections } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-perf',
        target: 'ProgramElementPerformer',
        naturalKey: '0601101A|P123|Acme|performing_activity',
        values: {
          peCode: '0601101A',
          projectCode: 'P123',
          performerName: 'Acme',
          performerRole: 'performing_activity',
        },
      }),
    ]);
    expect(projections[0]?.values.attributes?.performerRole).toBe('performing_activity');
    // Nothing in the projector rewrites a role to prime contractor.
    expect(projections[0]?.values.attributes?.performerRole).not.toBe('prime_contractor');
  });

  it('preserves milestone planned and actual dates', () => {
    const { projections } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-ms',
        target: 'ProgramElementMilestone',
        naturalKey: '0601101A|MS-B',
        values: {
          peCode: '0601101A',
          milestoneType: 'MS-B',
          plannedDate: '2027-03-01',
          actualDate: '2027-04-15',
        },
      }),
    ]);
    expect(projections[0]?.values.dateValue).toBe('2027-03-01');
    expect(projections[0]?.values.attributes?.actualDate).toBe('2027-04-15');
  });

  it('never routes an RDT&E candidate to a non-RDT&E entity', () => {
    for (const target of RDTE_PROJECTOR_TARGETS_V1) {
      const lookup = lookupCanonicalMappingV1(`rdte:${target}`);
      expect(lookup.supported).toBe(true);
      if (lookup.supported) {
        expect(
          lookup.entry.canonicalEntity.startsWith('canonical_procurement_') ||
            lookup.entry.canonicalEntity.startsWith('canonical_om_') ||
            lookup.entry.canonicalEntity.startsWith('canonical_milcon_'),
        ).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* G — Procurement                                                     */
/* ------------------------------------------------------------------ */

describe('Phase 7 WS G — procurement projector', () => {
  const blin = (o: Partial<ProjectionCandidateInputV1> = {}) =>
    candidate({
      candidateId: 'c-blin',
      target: 'ProcurementBudgetLine',
      naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:001:base',
      values: {
        naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:001:base',
        component: 'ARMY',
        account: '2031A',
        printedCode: '001',
        advanceProcurement: false,
        description: 'A line',
      },
      ...o,
    });

  it('projects a BLIN to the procurement canonical entity, never an RDT&E one', () => {
    const { projections, refusals } = projectProcurementCandidatesV1([blin()]);
    expect(refusals).toEqual([]);
    const lookup = lookupCanonicalMappingV1(projections[0]!.projectionKind);
    expect(lookup.supported && lookup.entry.canonicalEntity).toBe(
      'canonical_procurement_budget_line',
    );
  });

  it('keeps base and advance procurement as separate rows', () => {
    const { projections } = projectProcurementCandidatesV1([
      blin(),
      blin({
        candidateId: 'c-ap',
        naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:001:ap',
        values: {
          naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:001:ap',
          component: 'ARMY',
          account: '2031A',
          printedCode: '001',
          advanceProcurement: true,
        },
      }),
    ]);
    expect(projections).toHaveLength(2);
    expect(new Set(projections.map((p) => p.naturalKey)).size).toBe(2);
    expect(projections.map((p) => p.values.attributes?.advanceProcurement).sort()).toEqual([
      false,
      true,
    ]);
  });

  it('keeps the same short line number under two accounts distinct', () => {
    const { projections } = projectProcurementCandidatesV1([
      blin(),
      blin({
        candidateId: 'c-navy',
        naturalKey: 'PROCUREMENT_BLIN:NAVY:1506N:001:base',
        values: {
          naturalKey: 'PROCUREMENT_BLIN:NAVY:1506N:001:base',
          component: 'NAVY',
          account: '1506N',
          printedCode: '001',
          advanceProcurement: false,
        },
      }),
    ]);
    expect(new Set(projections.map((p) => p.naturalKey)).size).toBe(2);
  });

  it('keeps quantity and unit cost on axes separate from money', () => {
    const { projections, refusals } = projectProcurementCandidatesV1([
      candidate({
        candidateId: 'c-dist',
        target: 'ProcurementDistributionLine',
        naturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:001:base|2027|q',
        values: {
          identityNaturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:001:base',
          fy: 2027,
          quantity: 12,
          unitCostDollars: '104166.666667',
          ...MONEY,
        },
      }),
    ]);
    expect(refusals).toEqual([]);
    const values = projections[0]?.values;
    expect(values?.quantity).toBe('12');
    expect(values?.unitCostDollars).toBe('104166.666667');
    expect(values?.money?.valueMillions).toBe('1.25');
    // Three distinct axes, none of them the same field.
    expect(values?.quantity).not.toBe(values?.money?.valueMillions);
  });

  it('refuses a non-integer number where an exact decimal is required', () => {
    const { refusals, projections } = projectProcurementCandidatesV1([
      candidate({
        candidateId: 'c-float',
        target: 'ProcurementDistributionLine',
        naturalKey: 'k',
        values: {
          identityNaturalKey: 'PROCUREMENT_BLIN:ARMY:2031A:001:base',
          fy: 2027,
          quantity: 1.5,
        },
      }),
    ]);
    expect(projections).toEqual([]);
    expect(refusals[0]?.reason).toBe('quantity_not_canonical_decimal');
  });

  it('never routes a procurement candidate to an RDT&E entity', () => {
    for (const target of PROCUREMENT_PROJECTOR_TARGETS_V1) {
      const lookup = lookupCanonicalMappingV1(`non_rdte:${target}`);
      expect(lookup.supported && lookup.entry.canonicalEntity.startsWith('canonical_rdte_')).toBe(
        false,
      );
    }
  });

  it('refuses an RDT&E target handed to the procurement projector', () => {
    const { refusals, projections } = projectProcurementCandidatesV1([
      candidate({ target: 'ProgramElement' }),
    ]);
    expect(projections).toEqual([]);
    expect(refusals[0]?.reason).toBe('unsupported_target');
  });
});

/* ------------------------------------------------------------------ */
/* H — O&M                                                             */
/* ------------------------------------------------------------------ */

describe('Phase 7 WS H — O&M projector', () => {
  const sag = (o: Partial<ProjectionCandidateInputV1> = {}) =>
    candidate({
      candidateId: 'c-sag',
      target: 'OmSag',
      naturalKey: 'OM_SAG:ARMY:OMA:011',
      values: {
        naturalKey: 'OM_SAG:ARMY:OMA:011',
        component: 'ARMY',
        account: 'OMA',
        sagCode: '011',
        budgetActivity: 'BA1',
        activityGroup: 'AG2',
        subActivityGroup: 'SAG3',
      },
      ...o,
    });

  it('projects a SAG to the O&M canonical entity, never an RDT&E one', () => {
    const { projections, refusals } = projectOmCandidatesV1([sag()]);
    expect(refusals).toEqual([]);
    const lookup = lookupCanonicalMappingV1(projections[0]!.projectionKind);
    expect(lookup.supported && lookup.entry.canonicalEntity).toBe('canonical_om_sag');
  });

  it('keeps the same SAG code under two accounts distinct', () => {
    const { projections } = projectOmCandidatesV1([
      sag(),
      sag({
        candidateId: 'c-sag2',
        naturalKey: 'OM_SAG:ARMY:OMR:011',
        values: {
          naturalKey: 'OM_SAG:ARMY:OMR:011',
          component: 'ARMY',
          account: 'OMR',
          sagCode: '011',
        },
      }),
    ]);
    expect(new Set(projections.map((p) => p.naturalKey)).size).toBe(2);
  });

  it('preserves the BA/BAG hierarchy as attributes of the identity row', () => {
    const { projections } = projectOmCandidatesV1([sag()]);
    const attributes = projections[0]?.values.attributes;
    expect(attributes?.budgetActivity).toBe('BA1');
    expect(attributes?.activityGroup).toBe('AG2');
    expect(attributes?.subActivityGroup).toBe('SAG3');
  });

  it('keeps money, workload, and narrative on separate axes', () => {
    const { projections, refusals } = projectOmCandidatesV1([
      candidate({
        candidateId: 'c-detail',
        target: 'OmDetailFact',
        naturalKey: 'OM_SAG:ARMY:OMA:011|2027|workload|flying_hours',
        values: {
          identityNaturalKey: 'OM_SAG:ARMY:OMA:011',
          fy: 2027,
          factKind: 'workload',
          factKey: 'flying_hours',
          quantity: 12000,
          narrative: 'Flying hour program',
          ...MONEY,
        },
      }),
    ]);
    expect(refusals).toEqual([]);
    const values = projections[0]?.values;
    expect(values?.quantity).toBe('12000');
    expect(values?.textValue).toBe('Flying hour program');
    expect(values?.money?.valueMillions).toBe('1.25');
  });

  it('does not double count detail facts against summary positions', () => {
    const { projections } = projectOmCandidatesV1([
      candidate({
        candidateId: 'c-year',
        target: 'OmSagYear',
        naturalKey: 'OM_SAG:ARMY:OMA:011|2027|request',
        values: {
          identityNaturalKey: 'OM_SAG:ARMY:OMA:011',
          fiscalYear: 2027,
          originalValue: '100',
          originalUnit: 'millions',
          valueMillions: '100',
        },
      }),
      candidate({
        candidateId: 'c-detail',
        target: 'OmDetailFact',
        naturalKey: 'OM_SAG:ARMY:OMA:011|2027|driver|fuel',
        values: {
          identityNaturalKey: 'OM_SAG:ARMY:OMA:011',
          fy: 2027,
          factKind: 'driver',
          factKey: 'fuel',
          originalValue: '40',
          originalUnit: 'millions',
          valueMillions: '40',
        },
      }),
    ]);

    // The detail fact is a component of the position, not a second position.
    expect(sumPositionMillionsV1(projections)).toBe('100');
  });

  it('sums positions exactly, without floating point', () => {
    const projections = [0.1, 0.2].map((_, index) =>
      candidate({
        candidateId: `c-${index}`,
        target: 'OmSagYear',
        naturalKey: `OM_SAG:ARMY:OMA:01${index}|2027|request`,
        values: {
          identityNaturalKey: `OM_SAG:ARMY:OMA:01${index}`,
          fiscalYear: 2027,
          originalValue: index === 0 ? '0.1' : '0.2',
          originalUnit: 'millions',
          valueMillions: index === 0 ? '0.1' : '0.2',
        },
      }),
    );
    const { projections: projected } = projectOmCandidatesV1(projections);
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(sumPositionMillionsV1(projected)).toBe('0.3');
  });

  it('never routes an O&M candidate to an RDT&E entity', () => {
    for (const target of OM_PROJECTOR_TARGETS_V1) {
      const lookup = lookupCanonicalMappingV1(`non_rdte:${target}`);
      expect(lookup.supported && lookup.entry.canonicalEntity.startsWith('canonical_rdte_')).toBe(
        false,
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* Shared refusal behaviour                                            */
/* ------------------------------------------------------------------ */

describe('Phase 7 WS F/G/H — refuse rather than default', () => {
  it('refuses an upstream-excluded candidate', () => {
    const { projections, refusals } = projectRdteCandidatesV1([
      candidate({ exclusionReason: 'artifact_rejected' }),
    ]);
    expect(projections).toEqual([]);
    expect(refusals[0]?.reason).toBe('candidate_excluded');
    expect(refusals[0]?.detail).toContain('artifact_rejected');
  });

  it('refuses a conflict-marked candidate', () => {
    const { projections, refusals } = projectRdteCandidatesV1([
      candidate({ operation: 'conflict' }),
    ]);
    expect(projections).toEqual([]);
    expect(refusals[0]?.reason).toBe('candidate_not_projectable');
  });

  it('refuses a funding position with no money rather than defaulting to zero', () => {
    const { projections, refusals } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-nomoney',
        target: 'ProgramElementYear',
        naturalKey: '0601101A|2027',
        values: { peCode: '0601101A', fiscalYear: 2027 },
      }),
    ]);
    expect(projections).toEqual([]);
    expect(refusals[0]?.reason).toBe('money_required_but_absent');
  });

  it('refuses a half-stated money value', () => {
    const { projections, refusals } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-halfmoney',
        target: 'ProgramElementYear',
        naturalKey: '0601101A|2027',
        values: { peCode: '0601101A', fiscalYear: 2027, valueMillions: '1.25' },
      }),
    ]);
    expect(projections).toEqual([]);
    expect(refusals[0]?.reason).toBe('money_required_but_absent');
  });

  it('refuses a non-canonical decimal string', () => {
    const { refusals } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-bad',
        target: 'ProgramElementYear',
        naturalKey: '0601101A|2027',
        values: {
          peCode: '0601101A',
          fiscalYear: 2027,
          valueMillions: '1,250.00',
          originalValue: '1250',
          originalUnit: 'thousands',
        },
      }),
    ]);
    expect(refusals[0]?.reason).toBe('money_not_canonical_decimal');
  });

  it('refuses a child row that names no parent', () => {
    const { refusals } = projectRdteCandidatesV1([
      candidate({
        candidateId: 'c-orphan',
        target: 'ProgramElementYear',
        naturalKey: '0601101A|2027',
        values: { fiscalYear: 2027, ...MONEY },
      }),
    ]);
    expect(refusals[0]?.reason).toBe('parent_key_absent');
  });

  it('refuses money on an entity that carries no money axis', () => {
    const { refusals } = projectRdteCandidatesV1([
      candidate({ values: { peCode: '0601101A', title: 'x', ...MONEY } }),
    ]);
    expect(refusals[0]?.reason).toBe('money_required_but_absent');
  });

  it('returns refusals rather than dropping candidates', () => {
    const { projections, refusals } = projectRdteCandidatesV1([
      candidate(),
      candidate({ candidateId: 'c-bad', exclusionReason: 'duplicate_conflict' }),
    ]);
    expect(projections.length + refusals.length).toBe(2);
  });

  it('is deterministic in output order', () => {
    const input = [
      candidate({ candidateId: 'b', naturalKey: '0601102A', values: { peCode: '0601102A' } }),
      candidate({ candidateId: 'a', naturalKey: '0601101A', values: { peCode: '0601101A' } }),
    ];
    const forward = projectRdteCandidatesV1(input);
    const reversed = projectRdteCandidatesV1([...input].reverse());
    expect(reversed.projections.map((p) => p.naturalKey)).toEqual(
      forward.projections.map((p) => p.naturalKey),
    );
  });

  it('sorts evidence ids so lineage is order-independent', () => {
    const { projections } = projectRdteCandidatesV1([candidate()]);
    expect(projections[0]?.lineage.evidenceIds).toEqual(['ev-1', 'ev-2']);
  });

  it('marks a derived value as derived', () => {
    const { projections } = projectRdteCandidatesV1([
      candidate({ values: { peCode: '0601101A', title: 'x', direct: false } }),
    ]);
    expect(projections[0]?.directOrDerived).toBe('derived');
  });
});

describe('Phase 7 WS F/G/H — no legacy writer is reachable', () => {
  const raw = readFileSync(join(__dirname, 'canonical-projectors-v1.ts'), 'utf8');

  /**
   * Comments are stripped before scanning. A gate that matches its own prose is
   * a false positive, and the Phase 6 lesson is to sharpen the gate rather than
   * weaken the assertion — the module documents that it never calls
   * `ProgramElementWriterService`, and saying so must not trip the check that
   * it doesn't.
   */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('imports no legacy writer or reconciliation service', () => {
    expect(source).not.toMatch(/ProgramElementWriterService/);
    expect(source).not.toMatch(/ReconciliationService/);
    expect(source).not.toMatch(/budget-position-writer/);
  });

  it('still contains the identifiers in prose, proving the gate strips comments', () => {
    // Guards the guard: if this ever fails, the stripping above is over-eager
    // and the import assertions would be passing vacuously.
    expect(raw).toMatch(/ProgramElementWriterService/);
  });

  it('imports no Prisma client and performs no DML', () => {
    expect(source).not.toMatch(/from\s+['"]@prisma\/client['"]/);
    const dml =
      /\b[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    expect(dml.test(source)).toBe(false);
  });

  it('names no canonical entity literal — the registry is the only router', () => {
    // isPositionEntity necessarily names position entities; everything else must
    // go through lookupCanonicalMappingV1. Assert no projector function body
    // hard-codes a destination.
    const projectorBodies = source.slice(source.indexOf('export function projectRdteCandidatesV1'));
    expect(projectorBodies).not.toMatch(/canonical_rdte_program_element\b/);
    expect(projectorBodies).not.toMatch(/canonical_procurement_budget_line\b/);
    expect(projectorBodies).not.toMatch(/canonical_om_sag\b/);
  });

  it('uses no floating-point arithmetic on money', () => {
    expect(source).not.toMatch(/parseFloat|Number\.parseFloat/);
    expect(source).not.toMatch(/toFixed\(/);
  });
});
