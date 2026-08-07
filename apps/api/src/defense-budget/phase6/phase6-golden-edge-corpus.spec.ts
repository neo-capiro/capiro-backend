import * as fs from 'node:fs';
import * as path from 'node:path';

interface EdgeCorpus {
  nativeRows: Array<{
    lineKind: string;
    originalUnit: string;
    quantity?: string;
    request: string;
    change: string;
    after: string;
  }>;
  actions: Array<{ actionType: string; signedValueMillions?: string; transferGroupId?: string }>;
  incorporatedEnactmentProof: {
    publicLawSourceSha256: string;
    lineDetailSourceSha256: string;
    incorporationCitation: string;
  };
  reviewCases: Array<{ kind: string; expectedOutcome: string }>;
}

const FIXTURE = path.resolve(
  process.cwd(),
  'src/defense-budget/phase6/__fixtures__/golden-phase6-edge-cases.json',
);
function load(): EdgeCorpus {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as EdgeCorpus;
}

describe('Phase 6 golden mixed-unit and review edge corpus', () => {
  it('covers dollars, thousands, and millions without unit inference', () => {
    expect(new Set(load().nativeRows.map((row) => row.originalUnit))).toEqual(
      new Set(['dollars', 'thousands', 'millions']),
    );
  });

  it('retains procurement quantity separately from money', () => {
    const procurement = load().nativeRows.find((row) => row.lineKind === 'PROCUREMENT_BLIN');
    expect(procurement?.quantity).toBe('12');
    expect(procurement?.after).toBe('75');
  });

  it('covers adjustment, transfer, rescission, undistributed, and general-provision action shapes', () => {
    const types = new Set(load().actions.map((action) => action.actionType));
    for (const required of [
      'increase',
      'decrease',
      'transfer_out',
      'transfer_in',
      'rescission',
      'undistributed_adjustment',
      'general_provision',
    ]) {
      expect(types.has(required)).toBe(true);
    }
    const transfer = load().actions.filter((action) => action.transferGroupId === 't1');
    expect(transfer).toHaveLength(2);
    expect(new Set(transfer.map((action) => action.signedValueMillions))).toEqual(
      new Set(['-3', '3']),
    );
  });

  it('pins independent public-law and line-detail hashes for incorporated enactment proof', () => {
    const proof = load().incorporatedEnactmentProof;
    expect(proof.publicLawSourceSha256).not.toBe(proof.lineDetailSourceSha256);
    expect(proof.incorporationCitation.length).toBeGreaterThan(0);
  });

  it('covers missing, candidate, unresolved, and conflicting review outcomes', () => {
    const cases = new Map(load().reviewCases.map((item) => [item.kind, item.expectedOutcome]));
    expect(cases.get('missing_comparison')).toBe('NOT_RUN');
    expect(cases.get('candidate_identity')).toBe('REVIEW');
    expect(cases.get('unresolved_identity')).toBe('REVIEW');
    expect(cases.get('conflicting_identity')).toBe('BLOCKED');
    expect(cases.get('conflicting_duplicate')).toBe('BLOCKED');
  });
});
