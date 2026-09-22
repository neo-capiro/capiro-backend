import {
  isPassageQuestion,
  latestPassageOutcomes,
  statusEventDate,
  type PassageVoteEvidence,
} from './derive-bill-status';

function passageVote(overrides: Partial<PassageVoteEvidence> = {}): PassageVoteEvidence {
  return {
    id: 'house-119-1-1',
    billId: '119-hr-1',
    result: 'Passed',
    question: 'On Passage',
    voteDate: new Date('2026-01-01T12:00:00Z'),
    rollNumber: 1,
    ...overrides,
  };
}

describe('isPassageQuestion', () => {
  it('recognizes the House suspension-of-the-rules passage (contains "pass", not "passage")', () => {
    expect(isPassageQuestion('On Motion to Suspend the Rules and Pass')).toBe(true);
    expect(isPassageQuestion('On Motion to Suspend the Rules and Pass, as Amended')).toBe(true);
  });
  it('recognizes ordinary passage + resolution + concurrence forms', () => {
    expect(isPassageQuestion('On Passage')).toBe(true);
    expect(isPassageQuestion('On Passage of the Bill')).toBe(true);
    expect(isPassageQuestion('On Agreeing to the Resolution')).toBe(true);
    expect(isPassageQuestion('On the Third Reading')).toBe(true);
    expect(isPassageQuestion('On Motion to Concur in the Senate Amendment')).toBe(true);
  });
  it('rejects procedural questions (recommit / table / reconsider / cloture / motion to proceed)', () => {
    for (const q of [
      'On Motion to Recommit',
      'On Motion to Table',
      'On Motion to Reconsider',
      'On the Cloture Motion',
      'On the Motion to Proceed',
      'On Ordering the Previous Question',
    ]) {
      expect(isPassageQuestion(q)).toBe(false);
    }
    expect(isPassageQuestion(null)).toBe(false);
  });
});

describe('statusEventDate', () => {
  it('keeps the House passage date when a later action is Senate receipt', () => {
    const passage = new Date('2026-07-22T20:00:00.000Z');
    const senateReceipt = new Date('2026-09-14T00:00:00.000Z');
    expect(
      statusEventDate({
        status: 'passed_chamber',
        latestActionDate: senateReceipt,
        updateDate: senateReceipt,
        passageVoteDate: passage,
        actions: [
          { date: passage, text: 'On passage Passed by the Yeas and Nays: 216 - 212.' },
          { date: senateReceipt, text: 'Received in the Senate.' },
        ],
      }),
    ).toEqual(passage);
  });

  it('falls back to a strict passage action and ignores a later procedural motion', () => {
    const passage = new Date('2026-07-22T00:00:00.000Z');
    expect(
      statusEventDate({
        status: 'passed_chamber',
        latestActionDate: new Date('2026-07-23T00:00:00.000Z'),
        updateDate: null,
        passageVoteDate: null,
        actions: [
          { date: passage, text: 'Passed/agreed to in House: On passage Passed 216 - 212.' },
          {
            date: new Date('2026-07-23T00:00:00.000Z'),
            text: 'Motion to reconsider laid on the table Agreed to without objection.',
          },
        ],
      }),
    ).toEqual(passage);
  });
});

describe('latestPassageOutcomes', () => {
  it('lets a later failed final-passage vote supersede an earlier pass', () => {
    const outcomes = latestPassageOutcomes([
      passageVote({ result: 'Passed', voteDate: new Date('2026-01-01T12:00:00Z') }),
      passageVote({
        id: 'senate-119-1-2',
        result: 'Not Agreed to',
        voteDate: new Date('2026-02-01T12:00:00Z'),
        rollNumber: 2,
      }),
    ]);
    expect(outcomes.get('119-hr-1')).toMatchObject({
      outcome: 'fail',
      voteId: 'senate-119-1-2',
    });
  });

  it('lets a later successful reconsideration supersede an earlier failure', () => {
    const outcomes = latestPassageOutcomes([
      passageVote({ result: 'Failed', voteDate: new Date('2026-01-01T12:00:00Z') }),
      passageVote({
        id: 'house-119-1-2',
        result: 'Passed',
        voteDate: new Date('2026-01-02T12:00:00Z'),
        rollNumber: 2,
      }),
    ]);
    expect(outcomes.get('119-hr-1')).toMatchObject({ outcome: 'pass', voteId: 'house-119-1-2' });
  });

  it('ignores a later procedural failure', () => {
    const outcomes = latestPassageOutcomes([
      passageVote(),
      passageVote({
        id: 'house-119-1-2',
        question: 'On Motion to Recommit',
        result: 'Failed',
        voteDate: new Date('2026-01-02T12:00:00Z'),
        rollNumber: 2,
      }),
    ]);
    expect(outcomes.get('119-hr-1')).toMatchObject({ outcome: 'pass', voteId: 'house-119-1-1' });
  });
});
