import { isPassageQuestion } from './derive-bill-status';

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
