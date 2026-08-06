import {
  adaptPdocArtifactToArtifactV1,
  PdocAliasConflictError,
  type PdocArtifactV1Input,
} from './pdoc-artifact-v1.adapter.js';
import { adapterTestContext } from './testing-helpers.js';

const OPTIONS = {
  account: 'procurement_of_ammunition_army',
  legacyLineItemDollarsUnit: 'dollars' as const,
  defaultFiscalYear: 2099,
};

function context() {
  return adapterTestContext({
    family: 'procurement',
    exhibit: 'P-40',
    component: 'ARMY',
  });
}

function input(): PdocArtifactV1Input {
  return {
    service: 'ARMY',
    fy: 2099,
    pes: [
      {
        peCode: '0132E00700',
        title: 'Test procurement line',
        fyData: [],
        lineItems: [],
      },
    ],
  };
}

describe('P-doc legacy alias truthfulness', () => {
  it('records the snake_case request and unit-cost fields as the actual source paths', () => {
    const artifactInput = input();
    artifactInput.pes[0]!.fyData = [
      {
        fy: 2099,
        request_dollars_thousands: 1250,
        unit_cost_dollars: 42,
      },
    ];

    const artifact = adaptPdocArtifactToArtifactV1(artifactInput, context(), OPTIONS);
    const paths = artifact.sourceFacts.map((fact) => fact.sourcePath);
    expect(paths).toContain('pes[0].fyData[0].request_dollars_thousands');
    expect(paths).toContain('pes[0].fyData[0].unit_cost_dollars');
    expect(paths).not.toContain('pes[0].fyData[0].requestDollarsThousands');
    expect(paths).not.toContain('pes[0].fyData[0].unitCostDollars');
  });

  it('rejects conflicting parent request aliases instead of first-non-null wins', () => {
    const artifactInput = input();
    artifactInput.pes[0]!.fyData = [
      {
        fy: 2099,
        requestDollarsThousands: 100,
        request_dollars_thousands: 200,
      },
    ];

    expect(() => adaptPdocArtifactToArtifactV1(artifactInput, context(), OPTIONS)).toThrow(
      PdocAliasConflictError,
    );
  });

  it('rejects conflicting parent unit-cost aliases', () => {
    const artifactInput = input();
    artifactInput.pes[0]!.fyData = [
      {
        fy: 2099,
        unitCostDollars: 100,
        unit_cost_dollars: 200,
      },
    ];

    expect(() => adaptPdocArtifactToArtifactV1(artifactInput, context(), OPTIONS)).toThrow(
      /unitCost.*unitCostDollars, unit_cost_dollars/,
    );
  });

  it('rejects conflicting child unit-cost aliases', () => {
    const artifactInput = input();
    artifactInput.pes[0]!.lineItems = [
      {
        description: 'Child line',
        fy: 2099,
        dollars: 1000,
        unitCost: 10,
        unit_cost: 11,
      },
    ];

    expect(() => adaptPdocArtifactToArtifactV1(artifactInput, context(), OPTIONS)).toThrow(
      /lineItems\[0\]\.unitCost.*unitCost, unit_cost/,
    );
  });
});
