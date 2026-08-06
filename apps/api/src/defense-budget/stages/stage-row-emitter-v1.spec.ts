/**
 * Phase 6 Workstream D — stage row emitter tests.
 *
 * Required coverage: one fixture per supported native line kind, repeated table
 * header across pages, adjustment-only row, unresolved procurement account,
 * invalid unit, candidate identity, duplicate conflict, no request ownership,
 * and no canonical writer import in the Phase 6 stage path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BudgetLineIdentityV1 } from '../contracts/extraction-artifact-v1.js';
import type { ResolvedBudgetLineBindingV1 } from './budget-line-reference-v1.js';
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  type CongressionalColumnV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
} from './congressional-table-v1.js';
import type { DefenseBudgetStageSourceProfileV1 } from './stage-source-profile-v1.js';
import { emitStageRowsV1, stageCoverageByLineKindV1 } from './stage-row-emitter-v1.js';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const RDTE: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '1160402F' };
const PROC: BudgetLineIdentityV1 = {
  lineKind: 'PROCUREMENT_BLIN',
  code: '12',
  account: 'PROC-NAVY',
  component: 'NAVY',
};
const OM: BudgetLineIdentityV1 = {
  lineKind: 'OM_SAG',
  code: '1B21',
  account: 'O&M-ARMY-BASE',
  component: 'ARMY',
};
const MILCON: BudgetLineIdentityV1 = {
  lineKind: 'MILCON_PROJECT',
  projectCode: 'P-100',
  component: 'ARMY',
  location: 'Fort Alpha',
};

function hascProfile(
  overrides: Partial<DefenseBudgetStageSourceProfileV1> = {},
): DefenseBudgetStageSourceProfileV1 {
  return {
    schemaVersion: 'defense_budget_stage_source_profile_v1',
    profileId: 'fy2026-hasc',
    profileVersion: 1,
    track: 'authorization',
    stage: 'hasc',
    authority: 'hasc_authorization',
    fiscalYear: 2026,
    vehicleClass: 'committee_report',
    chamber: 'house',
    sourceDocumentKeys: ['hasc-report-fy2026'],
    companionDocuments: [],
    requiredLineFamilies: ['rdte_pe'],
    tableSemanticsPolicy: 'header_required',
    declaredUnits: ['thousands'],
    requiredComparisonStages: [],
    enactmentProofRequirement: 'not_required',
    absenceAllowed: true,
    ...overrides,
  };
}

function accepted(identity: BudgetLineIdentityV1): ResolvedBudgetLineBindingV1 {
  return {
    reference: { referenceKind: 'pe_code', peCode: 'x' },
    targetIdentity: identity,
    candidates: [identity],
    basis: 'exact_identity',
    confidence: 1,
    status: 'accepted',
    supportingEvidenceIds: [],
  };
}

function notAccepted(
  status: 'candidate' | 'unresolved' | 'conflicting',
): ResolvedBudgetLineBindingV1 {
  return {
    reference: { referenceKind: 'unresolved_reference', rawText: 'raw' },
    candidates: [],
    basis: status === 'candidate' ? 'title_candidate' : 'none',
    confidence: status === 'candidate' ? 0.4 : 0,
    status,
    supportingEvidenceIds: [],
  };
}

const COLUMNS: CongressionalColumnV1[] = [
  { columnIndex: 0, headerText: 'Line', isQuantity: false },
  {
    columnIndex: 1,
    headerText: 'FY26 Request',
    moneySemantic: 'request_baseline',
    fiscalYear: 2026,
    isQuantity: false,
  },
  {
    columnIndex: 2,
    headerText: 'Change',
    moneySemantic: 'change',
    fiscalYear: 2026,
    isQuantity: false,
  },
  {
    columnIndex: 3,
    headerText: 'Recommended',
    moneySemantic: 'recommended_total',
    fiscalYear: 2026,
    isQuantity: false,
  },
];

function row(
  rowIndex: number,
  overrides: Partial<CongressionalRowV1> = {},
  money: { baseline?: string; change?: string; total?: string } = {},
): CongressionalRowV1 {
  const cells = [{ rowIndex, columnIndex: 0, rawText: `row-${rowIndex}` }];
  if (money.baseline != null) {
    cells.push({
      rowIndex,
      columnIndex: 1,
      rawText: money.baseline,
      value: money.baseline,
    } as never);
  }
  if (money.change != null) {
    cells.push({ rowIndex, columnIndex: 2, rawText: money.change, value: money.change } as never);
  }
  if (money.total != null) {
    cells.push({ rowIndex, columnIndex: 3, rawText: money.total, value: money.total } as never);
  }
  return {
    rowIndex,
    rawLabel: `label-${rowIndex}`,
    reference: { referenceKind: 'pe_code', peCode: '1160402F' },
    semanticKind: 'absolute_position',
    cells,
    ...overrides,
  } as CongressionalRowV1;
}

function tableWith(
  rows: CongressionalRowV1[],
  overrides: Partial<CongressionalTableV1> = {},
): CongressionalTableV1 {
  return {
    schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
    profileId: 'fy2026-hasc',
    sourceDocumentId: 'hasc-report-fy2026',
    sourceSha256: 'a'.repeat(64),
    page: 10,
    printedPage: 'II-4',
    headings: ['TITLE II'],
    declaredUnit: 'thousands',
    columns: COLUMNS,
    rows,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* field ownership                                                     */
/* ------------------------------------------------------------------ */

describe('stage emitter — field ownership', () => {
  it('derives hascMark from the authority; the caller never picks the field', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([row(0, {}, { total: '125' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.field).toBe('hascMark');
    expect(emission.positions).toHaveLength(1);
    expect(emission.positions[0]!.field).toBe('hascMark');
  });

  it('emits sascMark for a SASC profile from the same shared code path', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile({
        profileId: 'fy2026-sasc',
        stage: 'sasc',
        authority: 'sasc_authorization',
        chamber: 'senate',
      }),
      table: tableWith([row(0, {}, { total: '125' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.field).toBe('sascMark');
  });

  it('never grants request ownership: a printed request is comparison-only', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([row(0, {}, { baseline: '100', total: '125' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.baselines).toHaveLength(1);
    expect(emission.baselines[0]!.comparisonOnly).toBe(true);
    expect(emission.baselines[0]).not.toHaveProperty('field');
    // The position is the recommendation, not the request.
    expect(emission.positions[0]!.value).toBe('125');
    expect(emission.positions.map((position) => position.value)).not.toContain('100');
  });
});

/* ------------------------------------------------------------------ */
/* every native line kind                                              */
/* ------------------------------------------------------------------ */

describe('stage emitter — native line kinds', () => {
  it('emits a position for each supported line kind', () => {
    const identities = [RDTE, PROC, OM, MILCON];
    const rows = identities.map((_identity, index) => row(index, {}, { total: '10' }));
    const bindings = new Map(identities.map((identity, index) => [index, accepted(identity)]));
    const emission = emitStageRowsV1({
      profile: hascProfile({
        requiredLineFamilies: ['rdte_pe', 'procurement_blin', 'om_sag', 'milcon_project'],
      }),
      table: tableWith(rows),
      bindingsByRowIndex: bindings,
    });
    expect(emission.positions).toHaveLength(4);
    expect(stageCoverageByLineKindV1(emission)).toEqual({
      RDTE_PE: 1,
      PROCUREMENT_BLIN: 1,
      OM_SAG: 1,
      MILCON_PROJECT: 1,
      UNKNOWN: 0,
    });
  });

  it('carries the same header semantics across a repeated header on a later page', () => {
    const first = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([row(0, {}, { total: '10' })], { page: 10, printedPage: 'II-4' }),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    const continued = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([row(0, {}, { total: '20' })], { page: 11, printedPage: 'II-5' }),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(first.positions[0]!.page).toBe(10);
    expect(continued.positions[0]!.page).toBe(11);
    expect(continued.positions[0]!.printedPage).toBe('II-5');
    expect(continued.positions[0]!.field).toBe(first.positions[0]!.field);
  });
});

/* ------------------------------------------------------------------ */
/* bindings that must not machine-pass                                 */
/* ------------------------------------------------------------------ */

describe('stage emitter — bindings that cannot pass', () => {
  it.each(['candidate', 'unresolved', 'conflicting'] as const)(
    'omits a %s binding instead of emitting a position',
    (status) => {
      const emission = emitStageRowsV1({
        profile: hascProfile(),
        table: tableWith([row(0, {}, { total: '125' })]),
        bindingsByRowIndex: new Map([[0, notAccepted(status)]]),
      });
      expect(emission.positions).toHaveLength(0);
      expect(emission.omissions).toHaveLength(1);
      expect(emission.omissions[0]!.reason).toBe('binding_not_accepted');
      expect(emission.omissions[0]!.detail).toBe(status);
    },
  );

  it('omits a row with no binding at all (unresolved procurement account)', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([
        row(
          0,
          { reference: { referenceKind: 'procurement_line', lineCode: '12' } },
          { total: '9' },
        ),
      ]),
      bindingsByRowIndex: new Map(),
    });
    expect(emission.positions).toHaveLength(0);
    expect(emission.omissions[0]!.reason).toBe('binding_not_accepted');
    expect(emission.omissions[0]!.detail).toBe('no_binding');
  });
});

/* ------------------------------------------------------------------ */
/* actions, units, policies                                            */
/* ------------------------------------------------------------------ */

describe('stage emitter — actions, units, and policies', () => {
  it('emits an adjustment-only row as an action, never a position', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([row(0, { semanticKind: 'adjustment' }, { change: '25' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.positions).toHaveLength(0);
    expect(emission.actions).toHaveLength(1);
    expect(emission.actions[0]!.rowKind).toBe('adjustment');
    expect(emission.actions[0]!.amount).toBe('25');
  });

  it('rejects a unit the profile does not declare rather than inferring one', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile({ declaredUnits: ['millions'] }),
      table: tableWith([row(0, {}, { total: '125' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.positions).toHaveLength(0);
    expect(emission.omissions[0]!.reason).toBe('undeclared_unit');
    expect(emission.omissions[0]!.detail).toBe('thousands');
  });

  it('derives baseline+change under header_required and records the arithmetic', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([row(0, {}, { baseline: '100', change: '25' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.positions).toHaveLength(1);
    expect(emission.positions[0]!.provenance).toBe('derived');
    expect(emission.positions[0]!.value).toBe('125');
    expect(emission.positions[0]!.derivation).toEqual({ baseline: '100', change: '25' });
  });

  it('forbids that derivation under totals_only', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile({ tableSemanticsPolicy: 'totals_only' }),
      table: tableWith([row(0, {}, { baseline: '100', change: '25' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.positions).toHaveLength(0);
    expect(emission.omissions[0]!.reason).toBe('totals_only_policy_forbids_derivation');
    // The baseline is still recorded as comparison-only.
    expect(emission.baselines).toHaveLength(1);
  });

  it('produces no money at all under narrative_only', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile({ tableSemanticsPolicy: 'narrative_only' }),
      table: tableWith([row(0, {}, { total: '125' })]),
      bindingsByRowIndex: new Map([[0, accepted(RDTE)]]),
    });
    expect(emission.positions).toHaveLength(0);
    expect(emission.baselines).toHaveLength(0);
    expect(emission.actions).toHaveLength(0);
    expect(emission.omissions[0]!.reason).toBe('narrative_policy_forbids_money');
  });

  it('records every row exactly once across positions, actions, and omissions', () => {
    const emission = emitStageRowsV1({
      profile: hascProfile(),
      table: tableWith([
        row(0, {}, { total: '10' }),
        row(1, { semanticKind: 'rescission' }, { change: '-2' }),
        row(2, { semanticKind: 'narrative_only' }),
      ]),
      bindingsByRowIndex: new Map([
        [0, accepted(RDTE)],
        [1, accepted(RDTE)],
        [2, accepted(RDTE)],
      ]),
    });
    const accountedRows = new Set([
      ...emission.positions.map((entry) => entry.rowIndex),
      ...emission.actions.map((entry) => entry.rowIndex),
      ...emission.omissions.map((entry) => entry.rowIndex),
    ]);
    expect(accountedRows).toEqual(new Set([0, 1, 2]));
  });
});

/* ------------------------------------------------------------------ */
/* architecture                                                        */
/* ------------------------------------------------------------------ */

describe('stage emitter — architecture', () => {
  it('no Phase 6 stage source imports a canonical writer', () => {
    const dir = __dirname;
    const offenders = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => {
        const source = fs.readFileSync(path.join(dir, name), 'utf8');
        return /\bimport\s+(?!type\b)[\w$*{},\s]*?\s+from\s+['"][^'"]*program-element-writer[^'"]*['"]/.test(
          source,
        );
      });
    expect(offenders).toEqual([]);
  });
});
