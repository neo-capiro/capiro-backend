import { assessStewardFacts } from './steward-assurance';
import type { ExtractedConflict, ExtractedFact, StewardRef } from './steward-prompt';

const refs: StewardRef[] = [
  { ref: 'heading:FY27 Budget Request', kind: 'heading', preview: 'FY27 Budget Request' },
  { ref: 'row:Program Elements:3', kind: 'row', preview: 'PE 0604270F | RDT&E | $412.5M' },
];

function fact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    fact: 'The client is headquartered in Arlington, Virginia.',
    sourceRef: 'heading:FY27 Budget Request',
    authority: null,
    asOf: null,
    confidence: 0.9,
    citation: 'FY27 Budget Request',
    ...over,
  };
}

/** A high-risk budget claim citing an anchor the document does not have. */
const FABRICATED_BUDGET = fact({
  fact: 'PE 0604270F received $412.5 million in the FY27 budget request.',
  sourceRef: 'row:Program Elements:99',
});

/** The same claim, correctly anchored. */
const GROUNDED_BUDGET = fact({
  fact: 'PE 0604270F received $412.5 million in the FY27 budget request.',
  sourceRef: 'row:Program Elements:3',
});

describe('assessStewardFacts', () => {
  it('withholds NOTHING when not armed — the response stays byte-identical', () => {
    const facts = [FABRICATED_BUDGET, fact()];
    const out = assessStewardFacts({
      facts,
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      armed: false,
    });
    expect(out.facts).toEqual(facts);
    expect(out.heldCount).toBe(1); // observed…
    expect(out.verdicts[0]?.held).toBe(true); // …and reported…
    expect(out.facts).toHaveLength(2); // …but not acted on.
  });

  it('holds a high-risk fact citing an anchor outside the closed set once armed', () => {
    const out = assessStewardFacts({
      facts: [FABRICATED_BUDGET, fact()],
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      armed: true,
    });
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]?.fact).toMatch(/Arlington/);
    expect(out.verdicts[0]).toMatchObject({
      index: 0,
      highRisk: true,
      anchorResolved: false,
      held: true,
    });
    expect(out.verdicts[0]?.reason).toMatch(/closed set/i);
  });

  it('releases the SAME claim when it resolves to a real anchor', () => {
    const out = assessStewardFacts({
      facts: [GROUNDED_BUDGET],
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      armed: true,
    });
    expect(out.facts).toHaveLength(1);
    expect(out.verdicts[0]).toMatchObject({ highRisk: true, anchorResolved: true, held: false });
  });

  it('does not hold a LOW-risk fact with a bad anchor (quality issue, not fabricated authority)', () => {
    const out = assessStewardFacts({
      facts: [fact({ sourceRef: 'heading:Does Not Exist' })],
      conflicts: [],
      refs,
      templateKey: 'client-profile',
      armed: true,
    });
    expect(out.facts).toHaveLength(1);
    expect(out.verdicts[0]).toMatchObject({ anchorResolved: false, held: false });
  });

  it('remaps surviving conflict indices and drops conflicts whose fact was held', () => {
    const conflicts: ExtractedConflict[] = [
      { newFactIndex: 0, existingFactId: 'e1', material: true, rationale: 'differs' },
      { newFactIndex: 2, existingFactId: 'e2', material: false, rationale: 'differs' },
    ];
    const out = assessStewardFacts({
      // index 0 held, indices 1 and 2 survive
      facts: [FABRICATED_BUDGET, fact(), fact({ fact: 'The client has 4 registered lobbyists.' })],
      conflicts,
      refs,
      templateKey: 'client-budget-profile',
      armed: true,
    });
    expect(out.facts).toHaveLength(2);
    // The conflict on the HELD fact is gone, never re-paired with the fact that
    // shifted into slot 0.
    expect(out.conflicts).toEqual([
      { newFactIndex: 1, existingFactId: 'e2', material: false, rationale: 'differs' },
    ]);
  });

  it('holds nothing when the document exposed no anchors and no high-risk fact was claimed', () => {
    const out = assessStewardFacts({
      facts: [fact({ sourceRef: 'heading:X' })],
      conflicts: [],
      refs: [],
      templateKey: 'client-profile',
      armed: true,
    });
    expect(out.facts).toHaveLength(1);
    expect(out.heldCount).toBe(0);
  });

  it('produces a stable ledger hash for identical input', () => {
    const args = {
      facts: [GROUNDED_BUDGET],
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      armed: true,
    } as const;
    expect(assessStewardFacts({ ...args }).ledgerHash).toBe(
      assessStewardFacts({ ...args }).ledgerHash,
    );
    expect(assessStewardFacts({ ...args }).ledgerHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
