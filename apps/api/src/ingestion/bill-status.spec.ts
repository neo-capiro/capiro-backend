import { deriveBillStatus, classifyVoteResult } from '@capiro/shared';

describe('classifyVoteResult', () => {
  it('reads passing results', () => {
    for (const r of ['Passed', 'Agreed to', 'Adopted']) expect(classifyVoteResult(r)).toBe('pass');
  });
  it('reads failing results — incl. "not agreed to" (contains "agreed to")', () => {
    for (const r of ['Failed', 'Rejected', 'Not Agreed to', 'Motion to table agreed to'])
      expect(classifyVoteResult(r)).toBe('fail');
  });
  it('is null on empty/unknown', () => {
    expect(classifyVoteResult(null)).toBeNull();
    expect(classifyVoteResult('Ordered')).toBeNull();
  });
});

describe('deriveBillStatus', () => {
  it('THE H.R. 8800 REGRESSION: rule reported + governing rule FAILED → rule_failed (never advancing)', () => {
    // H.R. 8800's own latest action reads like it is advancing...
    const naive = deriveBillStatus({
      latestActionText: 'Rules Committee Resolution H. Res. 1398 Reported to House.',
    });
    expect(naive.status).toBe('rule_pending'); // rule granted, floor pending — NOT "passed"
    // ...but its governing rule (H.Res. 1398) FAILED 198-224 → the bill is stalled.
    const truthful = deriveBillStatus({
      latestActionText: 'Rules Committee Resolution H. Res. 1398 Reported to House.',
      ruleOutcome: 'failed',
    });
    expect(truthful.status).toBe('rule_failed');
    expect(truthful.label).toMatch(/stalled/i);
  });

  it('an adopted rule sends the bill to the floor', () => {
    expect(
      deriveBillStatus({
        latestActionText: 'Rules Committee Resolution H. Res. 1400 Reported to House.',
        ruleOutcome: 'adopted',
      }).status,
    ).toBe('floor');
  });

  it('a FAILED own floor vote → failed even when the latest action text is procedural (the rule hres case)', () => {
    expect(
      deriveBillStatus({
        latestActionText:
          'POSTPONED PROCEEDINGS - The Chair put the question on the motion to reconsider.',
        failedChamber: true,
      }).status,
    ).toBe('failed');
    // ...but an actual passage still outranks a failed-vote signal.
    expect(
      deriveBillStatus({ latestActionText: 'x', passedChamber: true, failedChamber: true }).status,
    ).toBe('passed_chamber');
  });

  it('a real chamber-passage vote outranks rule state', () => {
    expect(
      deriveBillStatus({
        latestActionText: 'Rules Committee Resolution H. Res. 1398 Reported to House.',
        ruleOutcome: 'failed',
        passedChamber: true,
      }).status,
    ).toBe('passed_chamber');
  });

  it('classifies the ordinary ladder from action text', () => {
    expect(deriveBillStatus({ latestActionText: 'Became Public Law No: 119-42.' }).status).toBe(
      'enacted',
    );
    expect(
      deriveBillStatus({ latestActionText: 'Failed of passage/not agreed to in House' }).status,
    ).toBe('failed');
    expect(deriveBillStatus({ latestActionText: 'Presented to President.' }).status).toBe(
      'to_president',
    );
    expect(
      deriveBillStatus({ latestActionText: 'Passed the House by recorded vote.' }).status,
    ).toBe('passed_chamber');
    expect(
      deriveBillStatus({
        latestActionText: 'Ordered to be Reported by the Yeas and Nays: 44 - 12.',
      }).status,
    ).toBe('reported');
    expect(
      deriveBillStatus({ latestActionText: 'Referred to the House Committee on Armed Services.' })
        .status,
    ).toBe('committee');
    expect(deriveBillStatus({ latestActionText: 'Introduced in House' }).status).toBe('introduced');
  });
});
