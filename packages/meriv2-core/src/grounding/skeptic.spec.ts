import { buildSkepticPrompt, runSkeptic, runSkepticPanel, type SkepticJudge } from './skeptic';

const fixedJudge =
  (out: { refuted?: unknown; confidence?: unknown; reason?: unknown }): SkepticJudge =>
  async () =>
    out;

describe('buildSkepticPrompt', () => {
  it('is adversarial, closed-world, and embeds the claim + evidence', () => {
    const p = buildSkepticPrompt({
      claim: 'H.R. 8800 is advancing under the rule.',
      evidence: '{"billId":"hr-8800-119","status":"rule_failed"}',
      predicate: 'rule_operative',
    });
    expect(p).toMatch(/REFUTE/i);
    expect(p).toContain('absence\n  of evidence is not support');
    expect(p).toContain('Default to refuted');
    expect(p).toContain('H.R. 8800 is advancing under the rule.');
    expect(p).toContain('rule_failed');
    expect(p).toContain('rule_operative');
  });
});

describe('runSkeptic', () => {
  it('passes a supported claim through (refuted=false)', async () => {
    const v = await runSkeptic(
      { claim: 'x', evidence: 'y' },
      fixedJudge({ refuted: false, confidence: 'high', reason: 'evidence states it' }),
    );
    expect(v).toEqual({ refuted: false, confidence: 'high', reason: 'evidence states it' });
  });
  it('refutes when the judge refutes', async () => {
    const v = await runSkeptic(
      { claim: 'x', evidence: 'y' },
      fixedJudge({ refuted: true, confidence: 'medium', reason: 'not in evidence' }),
    );
    expect(v.refuted).toBe(true);
  });
  it('FAILS CLOSED (refuted) on a malformed verdict', async () => {
    const v = await runSkeptic({ claim: 'x', evidence: 'y' }, fixedJudge({ confidence: 'high' }));
    expect(v.refuted).toBe(true);
    expect(v.confidence).toBe('low');
  });
  it('FAILS CLOSED (refuted) when the judge throws', async () => {
    const throwingJudge: SkepticJudge = async () => {
      throw new Error('model timeout');
    };
    const v = await runSkeptic({ claim: 'x', evidence: 'y' }, throwingJudge);
    expect(v.refuted).toBe(true);
    expect(v.reason).toMatch(/failed/i);
  });
  it('normalizes an out-of-range confidence to low', async () => {
    const v = await runSkeptic(
      { claim: 'x', evidence: 'y' },
      fixedJudge({ refuted: false, confidence: 'certain' }),
    );
    expect(v.confidence).toBe('low');
  });
});

describe('runSkepticPanel — adversarial majority vote', () => {
  it('refutes when a majority refute (2 of 3)', async () => {
    let i = 0;
    const alternating: SkepticJudge = async () => {
      const outs = [{ refuted: true }, { refuted: true }, { refuted: false }];
      return outs[i++ % 3]!;
    };
    const r = await runSkepticPanel({ claim: 'x', evidence: 'y' }, alternating, 3);
    expect(r.refuteVotes).toBe(2);
    expect(r.threshold).toBe(2);
    expect(r.refuted).toBe(true);
    expect(r.votes).toHaveLength(3);
  });
  it('survives when only a minority refute (1 of 3)', async () => {
    let i = 0;
    const mostlyPass: SkepticJudge = async () => {
      const outs = [{ refuted: true }, { refuted: false }, { refuted: false }];
      return outs[i++ % 3]!;
    };
    const r = await runSkepticPanel({ claim: 'x', evidence: 'y' }, mostlyPass, 3);
    expect(r.refuteVotes).toBe(1);
    expect(r.refuted).toBe(false);
  });
  it('clamps N to [1,7] and a thrown judge makes the whole panel refute (fail-closed)', async () => {
    const throwing: SkepticJudge = async () => {
      throw new Error('down');
    };
    const r = await runSkepticPanel({ claim: 'x', evidence: 'y' }, throwing, 99);
    expect(r.votes).toHaveLength(7);
    expect(r.refuted).toBe(true);
    expect(r.refuteVotes).toBe(7);
  });
});
