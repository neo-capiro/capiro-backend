import { billStage, passageProbability, humanizeBillId, BILL_STAGES } from './bill-stage.util.js';

describe('billStage', () => {
  it('classifies enacted', () => {
    expect(billStage('Became Public Law No: 119-42')).toBe('enacted');
    expect(billStage('Signed by President')).toBe('enacted');
  });
  it('classifies passed chamber', () => {
    expect(billStage('Passed House 284-139')).toBe('passed');
    expect(billStage('Agreed to in Senate')).toBe('passed');
  });
  it('classifies committee', () => {
    expect(billStage('Referred to the Committee on Energy and Natural Resources')).toBe(
      'committee',
    );
    expect(billStage('Reported with amendment')).toBe('committee');
    expect(billStage('Scheduled for full-committee markup')).toBe('committee');
  });
  it('defaults to introduced', () => {
    expect(billStage('Introduced in House')).toBe('introduced');
    expect(billStage(null)).toBe('introduced');
    expect(billStage(undefined)).toBe('introduced');
  });
  it('precedence: enacted beats passed', () => {
    // "Passed" appears, but enacted signal wins.
    expect(billStage('Passed and signed; became public law')).toBe('enacted');
  });
});

describe('passageProbability', () => {
  it('returns 0.99 for enacted', () => {
    expect(passageProbability({ latestActionText: 'Became Public Law', title: 'X' })).toBe(0.99);
  });
  it('stays within [0.02, 0.97]', () => {
    const cases = [
      {
        latestActionText: 'Introduced',
        title: 'Minor bill',
        latestActionDate: new Date('2020-01-01'),
      },
      {
        latestActionText: 'Passed House',
        title: 'National Defense Authorization Act',
        latestActionDate: new Date(),
      },
      { latestActionText: 'Referred to committee', title: 'X', latestActionDate: null },
    ];
    for (const c of cases) {
      const p = passageProbability(c);
      expect(p).toBeGreaterThanOrEqual(0.02);
      expect(p).toBeLessThanOrEqual(0.97);
    }
  });
  it('boosts must-pass vehicles over ordinary bills at the same stage', () => {
    const ndaa = passageProbability({
      latestActionText: 'Passed House',
      title: 'National Defense Authorization Act for FY2027',
    });
    const ordinary = passageProbability({
      latestActionText: 'Passed House',
      title: 'A minor naming bill',
    });
    expect(ndaa).toBeGreaterThan(ordinary);
  });
  it('decays a long-stalled bill vs a fresh one', () => {
    const stalled = passageProbability({
      latestActionText: 'Reported',
      title: 'X',
      latestActionDate: new Date(Date.now() - 400 * 86_400_000),
    });
    const fresh = passageProbability({
      latestActionText: 'Reported',
      title: 'X',
      latestActionDate: new Date(),
    });
    expect(fresh).toBeGreaterThan(stalled);
  });
});

describe('humanizeBillId', () => {
  it('humanizes congress bill ids', () => {
    expect(humanizeBillId('119-hr-7702')).toBe('H.R. 7702');
    expect(humanizeBillId('119-s-410')).toBe('S. 410');
    expect(humanizeBillId('118-hjres-12')).toBe('H.J.Res. 12');
  });
  it('falls back to the raw id when unparseable', () => {
    expect(humanizeBillId('weird')).toBe('weird');
  });
});

describe('BILL_STAGES', () => {
  it('has the four legislative stages in order', () => {
    expect(BILL_STAGES.map((s) => s.id)).toEqual(['introduced', 'committee', 'passed', 'enacted']);
  });
});
