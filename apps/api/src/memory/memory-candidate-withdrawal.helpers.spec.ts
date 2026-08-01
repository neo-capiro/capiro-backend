import {
  candidateTransitionPath,
  classifyCandidateForGovernance,
  governedStatusForDecision,
} from './memory-governance-lifecycle.helpers.js';

describe('Phase 13 candidate disposition semantics', () => {
  it('keeps withdrawal and rejection in the same non-recallable governed state with distinct reasons', () => {
    expect(candidateTransitionPath('pending_review', 'withdrawn')).toEqual([
      {
        from: 'pending_review',
        to: 'rejected',
        reasonCode: 'withdrawn_by_proposer',
      },
    ]);
    expect(candidateTransitionPath('pending_review', 'rejected')).toEqual([
      {
        from: 'pending_review',
        to: 'rejected',
        reasonCode: 'rejected_by_reviewer',
      },
    ]);
    expect(governedStatusForDecision('withdrawn')).toBe('rejected');
    expect(governedStatusForDecision('rejected')).toBe('rejected');
  });

  it('never grants authority to a withdrawn proposal', () => {
    expect(
      classifyCandidateForGovernance(
        { scope: 'client', sourceKind: 'settings_sections', hasTtl: false },
        'withdrawn',
      ),
    ).toEqual({
      memoryClass: 'client_steering',
      memoryScope: 'client',
      memoryAuthority: null,
    });
  });

  it('preserves the submitted-for-review hop only for activation, not terminal disposition', () => {
    expect(candidateTransitionPath('suggested', 'approved').map((hop) => hop.to)).toEqual([
      'pending_review',
      'active',
    ]);
    expect(candidateTransitionPath('suggested', 'withdrawn')).toEqual([
      {
        from: 'suggested',
        to: 'rejected',
        reasonCode: 'withdrawn_by_proposer',
      },
    ]);
  });
});
