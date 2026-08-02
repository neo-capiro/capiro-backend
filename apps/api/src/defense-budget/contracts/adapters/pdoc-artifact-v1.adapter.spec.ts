import {
  adaptPdocArtifactToArtifactV1,
  type PdocAdapterOptions,
  type PdocArtifactV1Input,
} from './pdoc-artifact-v1.adapter.js';
import { adapterTestContext } from './testing-helpers.js';
import type { DefenseBudgetAssertionV1 } from '../extraction-artifact-v1.js';

type ProcurementLineAssertion = Extract<
  DefenseBudgetAssertionV1,
  { assertionKind: 'procurement_line' }
>;
type FundingAssertion = Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }>;
type QuantityAssertion = Extract<DefenseBudgetAssertionV1, { assertionKind: 'quantity' }>;
type UnitCostAssertion = Extract<DefenseBudgetAssertionV1, { assertionKind: 'unit_cost' }>;

function lines(assertions: DefenseBudgetAssertionV1[]): ProcurementLineAssertion[] {
  return assertions.filter(
    (a): a is ProcurementLineAssertion => a.assertionKind === 'procurement_line',
  );
}
function funding(assertions: DefenseBudgetAssertionV1[]): FundingAssertion[] {
  return assertions.filter((a): a is FundingAssertion => a.assertionKind === 'funding');
}
function quantities(assertions: DefenseBudgetAssertionV1[]): QuantityAssertion[] {
  return assertions.filter((a): a is QuantityAssertion => a.assertionKind === 'quantity');
}
function unitCosts(assertions: DefenseBudgetAssertionV1[]): UnitCostAssertion[] {
  return assertions.filter((a): a is UnitCostAssertion => a.assertionKind === 'unit_cost');
}

const BASE_OPTIONS: PdocAdapterOptions = {
  account: 'procurement_of_ammunition_army',
  legacyLineItemDollarsUnit: 'dollars',
  defaultFiscalYear: 2099,
};

function pdocInput(overrides: Partial<PdocArtifactV1Input> = {}): PdocArtifactV1Input {
  return {
    service: 'ARMY',
    fy: 2099,
    sourceUrl: 'https://example.invalid/pdoc.pdf',
    pes: [
      {
        peCode: '0132E00700',
        title: 'CTG, 5.56MM, All Types',
        budgetActivity: 'BA 01',
        lineNumber: '0132E00700',
        programOfRecord: null,
        fyData: [
          {
            fy: 2099,
            quantity: 12,
            requestDollarsThousands: 2036358,
            unitCostDollars: 169696500,
          },
        ],
        lineItems: [
          {
            description: 'Army',
            fy: 2099,
            quantity: 12,
            dollars: 2036358000,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function pdocContext() {
  return adapterTestContext({
    family: 'procurement',
    exhibit: 'P-40',
    component: 'ARMY',
  });
}

describe('adaptPdocArtifactToArtifactV1', () => {
  it('preserves the native PROCUREMENT_BLIN identity with account context', () => {
    const artifact = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const parent = lines(artifact.assertions)[0]!;
    expect(parent.parentIdentity).toEqual({
      lineKind: 'PROCUREMENT_BLIN',
      code: '0132E00700',
      account: 'procurement_of_ammunition_army',
      component: 'ARMY',
    });
    // Never collapsed into an RDT&E PE identity.
    expect(artifact.assertions.some((a) => a.assertionKind === 'program_element_identity')).toBe(
      false,
    );
  });

  it('does not share identity for the same numeric code in different accounts', () => {
    const a = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const b = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), {
      ...BASE_OPTIONS,
      account: 'other_procurement_army',
    });
    expect(a.artifactId).not.toBe(b.artifactId);
    expect(lines(a.assertions)[0]!.parentIdentity.account).toBe('procurement_of_ammunition_army');
    expect(lines(b.assertions)[0]!.parentIdentity.account).toBe('other_procurement_army');
  });

  it('keeps base and advance procurement identities separate', () => {
    const base = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const advance = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), {
      ...BASE_OPTIONS,
      advanceProcurement: true,
    });
    expect(base.artifactId).not.toBe(advance.artifactId);
    expect(lines(advance.assertions)[0]!.parentIdentity.advanceProcurement).toBe(true);
  });

  it('maps fyData request amounts as funding with the explicit thousands unit', () => {
    const artifact = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const request = funding(artifact.assertions)[0]!;
    expect(request.field).toBe('request');
    expect(request.fiscalYear).toBe(2099);
    expect(request.money).toEqual({
      originalValue: '2036358',
      originalUnit: 'thousands',
      valueMillions: '2036.358',
    });
    expect(request.metadata?.['declaredUnitSource']).toBe('p1_convention');
  });

  it('keeps quantity as a quantity assertion, never money', () => {
    const artifact = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const qty = quantities(artifact.assertions)[0]!;
    expect(qty.quantity).toBe('12');
    expect(qty.fiscalYear).toBe(2099);
    const qtyFactPaths = artifact.sourceFacts
      .filter((f) => f.category === 'quantity')
      .map((f) => f.sourcePath);
    expect(qtyFactPaths).toContain('pes[0].fyData[0].quantity');
  });

  it('keeps unit cost in dollars as its own assertion kind', () => {
    const artifact = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const unitCost = unitCosts(artifact.assertions)[0]!;
    expect(unitCost.unitCostDollars).toBe('169696500');
    expect(unitCost.fiscalYear).toBe(2099);
  });

  it('maps child line items to procurement_line assertions linked to the parent', () => {
    const artifact = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const all = lines(artifact.assertions);
    expect(all).toHaveLength(2); // parent-level + child
    const child = all.find((a) => a.description === 'Army')!;
    expect(child.parentIdentity.code).toBe('0132E00700');
    expect(child.quantity).toBe('12');
    expect(child.dollars).toEqual({
      originalValue: '2036358000',
      originalUnit: 'dollars',
      valueMillions: '2036.358',
    });
    // Child dollars share the parent's request magnitude — linked, not merged.
    expect(child.sourceFactIds.length).toBeGreaterThan(1);
  });

  it('creates omissions (not silence) for empty child descriptions', () => {
    const input = pdocInput();
    input.pes[0]!.lineItems = [{ description: '', fy: 2099, quantity: 1, dollars: 100 }];
    const artifact = adaptPdocArtifactToArtifactV1(input, pdocContext(), BASE_OPTIONS);
    expect(artifact.omissions.some((o) => o.reason === 'missing_value')).toBe(true);
    expect(artifact.summary.completenessStatus).toBe('complete_with_omissions');
  });

  it('creates a blocking unsupported_unit omission when child dollars unit is unprovable', () => {
    const artifact = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), {
      account: BASE_OPTIONS.account,
      defaultFiscalYear: 2099,
    });
    expect(
      artifact.omissions.some((o) => o.reason === 'unsupported_unit' && o.severity === 'blocking'),
    ).toBe(true);
    // The child line is not asserted while its dollars are unproven.
    expect(lines(artifact.assertions).some((a) => a.description === 'Army')).toBe(false);
  });

  it('honors a row-level dollarsUnit over the legacy convention', () => {
    const input = pdocInput();
    input.pes[0]!.lineItems = [
      { description: 'Navy', fy: 2099, quantity: 1, dollars: 1250, dollarsUnit: 'thousands' },
    ];
    const artifact = adaptPdocArtifactToArtifactV1(input, pdocContext(), BASE_OPTIONS);
    const child = lines(artifact.assertions).find((a) => a.description === 'Navy')!;
    expect(child.dollars).toEqual({
      originalValue: '1250',
      originalUnit: 'thousands',
      valueMillions: '1.25',
    });
    expect(child.metadata?.['dollarsUnitSource']).toBe('row');
  });

  it('warns and defaults when an fyData row carries an invalid fy', () => {
    const input = pdocInput();
    input.pes[0]!.fyData = [
      { fy: 'not-a-year', quantity: 1, requestDollarsThousands: 100, unitCostDollars: 100 },
    ];
    const artifact = adaptPdocArtifactToArtifactV1(input, pdocContext(), BASE_OPTIONS);
    expect(artifact.warnings.some((w) => w.code === 'legacy_pdoc_fydata_missing_fy')).toBe(true);
    expect(funding(artifact.assertions)[0]!.fiscalYear).toBe(2099);
  });

  it('creates an invalid_number omission for malformed fyData money', () => {
    const input = pdocInput();
    input.pes[0]!.fyData = [
      { fy: 2099, quantity: 1, requestDollarsThousands: 'bogus', unitCostDollars: 100 },
    ];
    const artifact = adaptPdocArtifactToArtifactV1(input, pdocContext(), BASE_OPTIONS);
    expect(artifact.omissions.some((o) => o.reason === 'invalid_number')).toBe(true);
    expect(funding(artifact.assertions)).toHaveLength(0);
  });

  it('blocks parent and child data when the procurement code is missing', () => {
    const input = pdocInput();
    input.pes[0]!.peCode = null;
    const artifact = adaptPdocArtifactToArtifactV1(input, pdocContext(), BASE_OPTIONS);
    expect(artifact.omissions.some((o) => o.reason === 'invalid_identity')).toBe(true);
    expect(lines(artifact.assertions)).toHaveLength(0);
  });

  it('accepts the snake_case legacy aliases', () => {
    const input = pdocInput();
    input.pes[0]!.fyData = [
      { fy: 2099, quantity: 3, request_dollars_thousands: 1250, unit_cost_dollars: 42 },
    ];
    input.pes[0]!.lineItems = [
      { description: 'Army', fy: 2099, quantity: 3, dollars: 1250000, unit_cost: 42 },
    ];
    const artifact = adaptPdocArtifactToArtifactV1(input, pdocContext(), BASE_OPTIONS);
    expect(funding(artifact.assertions)[0]!.money.originalValue).toBe('1250');
    expect(unitCosts(artifact.assertions)[0]!.unitCostDollars).toBe('42');
    const child = lines(artifact.assertions).find((a) => a.description === 'Army')!;
    expect(child.unitCostDollars).toBe('42');
  });

  it('is complete when every fact resolves', () => {
    const artifact = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    expect(artifact.summary.completenessStatus).toBe('complete');
    expect(artifact.summary.uncoveredRequiredSourceFactCount).toBe(0);
  });

  it('replay is deterministic', () => {
    const first = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    const second = adaptPdocArtifactToArtifactV1(pdocInput(), pdocContext(), BASE_OPTIONS);
    expect(second).toEqual(first);
    expect(second.artifactId).toBe(first.artifactId);
  });
});
