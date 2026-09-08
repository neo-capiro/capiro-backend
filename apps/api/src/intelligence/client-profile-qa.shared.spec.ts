import {
  billStage,
  deriveBillStatus,
  matchesAdvocacyOrganization,
  matchesTestimonyOrganization,
  advocacyAttributionNeedsReview,
} from '@capiro/shared';

describe('Profile QA: durable bill stages and organization attribution', () => {
  const procedural = 'Motion to reconsider laid on the table Agreed to without objection.';
  const passage = 'On passage Passed by the Yeas and Nays: 296 - 128.';
  it('retains chamber passage through a later procedural action in the board and canonical derivation', () => {
    expect(billStage(procedural, 'passed_chamber')).toBe('passed');
    expect(billStage(procedural, 'introduced', [passage, procedural])).toBe('passed');
    expect(
      deriveBillStatus({
        latestActionText: procedural,
        actionTexts: [passage, procedural],
        ruleOutcome: 'failed',
      }).status,
    ).toBe('passed_chamber');
  });
  it('does not mistake a reconsideration or amendment for passage', () => {
    expect(billStage(procedural, null, ['An amendment was agreed to.'])).toBe('introduced');
  });
  it('keeps enactment even when a later procedural note is latest', () => {
    expect(billStage(procedural, null, ['Became Public Law No: 119-1.'])).toBe('enacted');
  });
  it('requires a full organization match, including the digit in L3Harris', () => {
    expect(matchesAdvocacyOrganization('L3 Harris', 'L3Harris, Inc.')).toBe(true);
    for (const source of [
      'Curley, John Harris',
      'Harris St. Laurent & Wechsler LLP',
      'Brian Harrison',
    ])
      expect(matchesAdvocacyOrganization('L3 Harris', source)).toBe(false);
  });
  it('uses witness affiliation, not the witness name', () => {
    expect(
      matchesTestimonyOrganization(
        'L3 Harris',
        'Carol Harris, Director, Government Accountability Office',
      ),
    ).toBe(false);
    expect(matchesTestimonyOrganization('L3 Harris', 'Brian Harrison, Official, HUD')).toBe(false);
    expect(
      matchesTestimonyOrganization('L3 Harris', 'Jane Smith, Vice President, L3Harris Inc.'),
    ).toBe(true);
  });
  it('keeps assignment corrections separate from entity verification', () => {
    expect(
      advocacyAttributionNeedsReview('testimony', {
        matterLocked: true,
        clientMatch: { method: 'name_similarity' },
      }),
    ).toBe(true);
    expect(
      advocacyAttributionNeedsReview('fara', {
        clientMatch: { method: 'confirmed_client_intel_mapping' },
      }),
    ).toBe(false);
  });
});
