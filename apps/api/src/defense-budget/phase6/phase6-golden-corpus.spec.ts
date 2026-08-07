import * as fs from 'node:fs';
import * as path from 'node:path';

interface GoldenCycle {
  lineKinds: Array<{ lineKind: string; key: string }>;
  stages: Array<{
    stage: string;
    track: string;
    field: string;
    value: string;
    proofId?: string;
    revisedTotalBasis?: string;
    metric?: string;
    asOfDate?: string;
    cumulative?: boolean;
  }>;
}

const FIXTURE = path.resolve(
  process.cwd(),
  'src/defense-budget/phase6/__fixtures__/golden-phase6-cycle.json',
);

function load(): GoldenCycle {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as GoldenCycle;
}

describe('Phase 6 golden all-stage corpus', () => {
  it('covers all four native line kinds', () => {
    expect(load().lineKinds.map((item) => item.lineKind).sort()).toEqual([
      'MILCON_PROJECT',
      'OM_SAG',
      'PROCUREMENT_BLIN',
      'RDTE_PE',
    ]);
  });

  it('keeps authorization, appropriations, enacted, reprogramming, and execution stages distinct', () => {
    const stages = load().stages;
    expect(stages).toHaveLength(9);
    expect(new Set(stages.map((item) => item.stage)).size).toBe(9);
    expect(stages.find((item) => item.stage === 'ndaa_conference')?.field).toBe('ndaaConference');
    expect(stages.find((item) => item.stage === 'appropriations_conference')?.field).toBe(
      'conference',
    );
    expect(stages.find((item) => item.stage === 'public_law')?.field).toBe('enacted');
    expect(stages.find((item) => item.stage === 'reprogramming')?.field).toBe('reprogrammed');
    expect(stages.find((item) => item.stage === 'execution')?.field).toBe('executed');
  });

  it('retains proof and metric metadata on sensitive terminal stages', () => {
    const stages = load().stages;
    expect(stages.find((item) => item.stage === 'public_law')?.proofId).toBe('proof-golden');
    expect(stages.find((item) => item.stage === 'reprogramming')?.revisedTotalBasis).toBe(
      'explicit_after',
    );
    expect(stages.find((item) => item.stage === 'execution')).toMatchObject({
      metric: 'obligations',
      asOfDate: '2027-12-31',
      cumulative: true,
    });
  });
});
