import { verifyAssuranceEnvelope } from '@capiro/meriv2-core';
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

const FABRICATED_BUDGET = fact({
  fact: 'PE 0604270F received $412.5 million in the FY27 budget request.',
  sourceRef: 'row:Program Elements:99',
});

const GROUNDED_BUDGET = fact({
  fact: 'PE 0604270F received $412.5 million in the FY27 budget request.',
  sourceRef: 'row:Program Elements:3',
});

describe('assessStewardFacts', () => {
  it('observes but withholds nothing in shadow', () => {
    const facts = [FABRICATED_BUDGET, fact()];
    const out = assessStewardFacts({
      facts,
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      mode: 'shadow',
      contextPacketId: 'packet-1',
    });
    expect(out.facts).toEqual(facts);
    expect(out.heldCount).toBe(1);
    expect(out.verdicts[0]?.held).toBe(true);
    expect(out.envelope.contextPacketId).toBe('packet-1');
    expect(verifyAssuranceEnvelope(out.envelope).valid).toBe(true);
  });

  it('holds a high-risk fact citing an anchor outside the closed set in enforce', () => {
    const out = assessStewardFacts({
      facts: [FABRICATED_BUDGET, fact()],
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      mode: 'enforce',
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

  it('releases the same claim when it resolves to a real anchor', () => {
    const out = assessStewardFacts({
      facts: [GROUNDED_BUDGET],
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      mode: 'enforce',
    });
    expect(out.facts).toHaveLength(1);
    expect(out.verdicts[0]).toMatchObject({ highRisk: true, anchorResolved: true, held: false });
  });

  it('does not hold a low-risk fact with a bad anchor', () => {
    const out = assessStewardFacts({
      facts: [fact({ sourceRef: 'heading:Does Not Exist' })],
      conflicts: [],
      refs,
      templateKey: 'client-profile',
      mode: 'enforce',
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
      facts: [FABRICATED_BUDGET, fact(), fact({ fact: 'The client has 4 registered lobbyists.' })],
      conflicts,
      refs,
      templateKey: 'client-budget-profile',
      mode: 'enforce',
    });
    expect(out.facts).toHaveLength(2);
    expect(out.conflicts).toEqual([
      { newFactIndex: 1, existingFactId: 'e2', material: false, rationale: 'differs' },
    ]);
  });

  it('holds nothing when no high-risk fact was claimed', () => {
    const out = assessStewardFacts({
      facts: [fact({ sourceRef: 'heading:X' })],
      conflicts: [],
      refs: [],
      templateKey: 'client-profile',
      mode: 'enforce',
    });
    expect(out.facts).toHaveLength(1);
    expect(out.heldCount).toBe(0);
  });

  it('binds policy identity and detects stale policy drift', () => {
    const out = assessStewardFacts({
      facts: [GROUNDED_BUDGET],
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      mode: 'shadow',
      policyBinding: { packId: 'pack-a', packVersion: '2', ruleId: 'facts' },
    });
    expect(
      verifyAssuranceEnvelope(out.envelope, {
        policyBinding: { packId: 'pack-a', packVersion: '3', ruleId: 'facts' },
      }).errors,
    ).toContain('policy_binding_drift');
  });

  it('produces a stable ledger hash for identical input', () => {
    const args = {
      facts: [GROUNDED_BUDGET],
      conflicts: [],
      refs,
      templateKey: 'client-budget-profile',
      mode: 'enforce' as const,
    };
    expect(assessStewardFacts({ ...args }).ledgerHash).toBe(
      assessStewardFacts({ ...args }).ledgerHash,
    );
    expect(assessStewardFacts({ ...args }).ledgerHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
