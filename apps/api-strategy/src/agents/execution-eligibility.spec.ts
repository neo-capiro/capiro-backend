import { describe, expect, it } from '@jest/globals';
import {
  evaluateEligibility,
  type EligibilityInput,
  type EligibilityNode,
} from './execution-eligibility.js';

/*
 * Exhaustive eligibility-gate tests for the PURE module. Every gate is
 * exercised in isolation (each failing reason fires on its own) AND together
 * (multi-reason accumulation — the module returns ALL failures, not the first).
 * The Stage-E blocking-conflict gate gets dedicated coverage: an open material
 * conflict is a HARD blocker here (unlike the draft path where it only
 * annotates). A `base*` node is fully eligible so each test flips exactly one
 * field and asserts the resulting reason set.
 */

const workspaceNode: EligibilityNode = {
  kind: 'action',
  subject: 'deliverable',
  ownerUserId: 'u-owner',
  startsOn: '2027-01-10',
  endsOn: '2027-02-10',
};
const outreachNode: EligibilityNode = {
  kind: 'action',
  subject: 'member',
  ownerUserId: 'u-owner',
  startsOn: '2027-01-10',
  endsOn: '2027-02-10',
};

function ws(node: Partial<EligibilityNode>, over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    node: { ...workspaceNode, ...node },
    strategyHealth: { openMaterialConflicts: 0 },
    hasWorkspaceAccess: true,
    kind: 'workspace',
    ...over,
  };
}
function outreach(
  node: Partial<EligibilityNode>,
  over: Partial<EligibilityInput> = {},
): EligibilityInput {
  return {
    node: { ...outreachNode, ...node },
    strategyHealth: { openMaterialConflicts: 0 },
    hasWorkspaceAccess: true,
    kind: 'outreach',
    ...over,
  };
}

describe('evaluateEligibility — workspace kind', () => {
  it('a fully-formed deliverable action node is eligible with no reasons', () => {
    expect(evaluateEligibility(ws({}))).toEqual({ eligible: true, reasons: [] });
    expect(evaluateEligibility(ws({ subject: 'submission' }))).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it('requires kind === action', () => {
    for (const kind of ['decision', 'gate', 'milestone', 'risk']) {
      const r = evaluateEligibility(ws({ kind }));
      expect(r.eligible).toBe(false);
      expect(r.reasons).toContain(`node kind must be 'action' for workspace execution (is '${kind}')`);
    }
  });

  it('requires subject in deliverable|submission', () => {
    for (const subject of ['member', 'committee', 'agency', 'ask', 'outcome', 'optics']) {
      const r = evaluateEligibility(ws({ subject }));
      expect(r.eligible).toBe(false);
      expect(r.reasons).toContain(
        `node subject must be one of deliverable, submission for workspace execution (is '${subject}')`,
      );
    }
  });

  it('requires an owner (null / empty / whitespace all fail)', () => {
    for (const ownerUserId of [null, '', '   ']) {
      const r = evaluateEligibility(ws({ ownerUserId }));
      expect(r.eligible).toBe(false);
      expect(r.reasons).toContain('node has no owner (ownerUserId is required)');
    }
  });

  it('requires a target date — startsOn OR endsOn satisfies it', () => {
    expect(evaluateEligibility(ws({ startsOn: null, endsOn: '2027-02-10' })).eligible).toBe(true);
    expect(evaluateEligibility(ws({ startsOn: '2027-01-10', endsOn: null })).eligible).toBe(true);
    const r = evaluateEligibility(ws({ startsOn: null, endsOn: null }));
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('node has no target date (startsOn or endsOn is required)');
  });

  it('requires workspace access', () => {
    const r = evaluateEligibility(ws({}, { hasWorkspaceAccess: false }));
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('caller has no workspace access');
  });

  it('BLOCKS on an open material conflict (Stage-E gate) — singular and plural wording', () => {
    const one = evaluateEligibility(ws({}, { strategyHealth: { openMaterialConflicts: 1 } }));
    expect(one.eligible).toBe(false);
    expect(one.reasons).toContain('strategy has 1 open material conflict (blocks execution)');

    const many = evaluateEligibility(ws({}, { strategyHealth: { openMaterialConflicts: 3 } }));
    expect(many.eligible).toBe(false);
    expect(many.reasons).toContain('strategy has 3 open material conflicts (blocks execution)');
  });

  it('accumulates EVERY failing reason, not just the first', () => {
    const r = evaluateEligibility(
      ws(
        { kind: 'decision', subject: 'member', ownerUserId: null, startsOn: null, endsOn: null },
        { hasWorkspaceAccess: false, strategyHealth: { openMaterialConflicts: 2 } },
      ),
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual([
      "node kind must be 'action' for workspace execution (is 'decision')",
      "node subject must be one of deliverable, submission for workspace execution (is 'member')",
      'caller has no workspace access',
      'node has no owner (ownerUserId is required)',
      'node has no target date (startsOn or endsOn is required)',
      'strategy has 2 open material conflicts (blocks execution)',
    ]);
  });
});

describe('evaluateEligibility — outreach kind', () => {
  it('a member/committee/agency node with owner + date + no conflict is eligible', () => {
    for (const subject of ['member', 'committee', 'agency']) {
      expect(evaluateEligibility(outreach({ subject }))).toEqual({ eligible: true, reasons: [] });
    }
  });

  it('requires subject in member|committee|agency', () => {
    for (const subject of ['deliverable', 'submission', 'ask', 'outcome', 'optics']) {
      const r = evaluateEligibility(outreach({ subject }));
      expect(r.eligible).toBe(false);
      expect(r.reasons).toContain(
        `node subject must be one of member, committee, agency for outreach execution (is '${subject}')`,
      );
    }
  });

  it('does NOT gate outreach on node kind — a non-action node with a valid subject is eligible', () => {
    for (const kind of ['decision', 'gate', 'milestone']) {
      expect(evaluateEligibility(outreach({ kind })).eligible).toBe(true);
    }
  });

  it('does NOT gate outreach on workspace access', () => {
    expect(evaluateEligibility(outreach({}, { hasWorkspaceAccess: false }))).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  it('requires an owner and a target date', () => {
    expect(evaluateEligibility(outreach({ ownerUserId: null })).reasons).toContain(
      'node has no owner (ownerUserId is required)',
    );
    expect(evaluateEligibility(outreach({ startsOn: null, endsOn: null })).reasons).toContain(
      'node has no target date (startsOn or endsOn is required)',
    );
  });

  it('BLOCKS on an open material conflict', () => {
    const r = evaluateEligibility(outreach({}, { strategyHealth: { openMaterialConflicts: 1 } }));
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('strategy has 1 open material conflict (blocks execution)');
  });
});
