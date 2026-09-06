import { describe, expect, test } from 'vitest';
import { explainSignals } from './opportunity-explanations.js';

describe('client fit explanations', () => {
  test('distinguishes a recorded funding priority from a capability and preserves the phrase', () => {
    const explained = explainSignals([
      {
        signal: 'capabilityKeyword',
        source: 'funding_priority',
        strength: 'moderate',
        weight: 15,
        matchedOn: 'rural broadband deployment',
      },
    ]);
    expect(explained.strongest).toMatchObject({
      label: 'Funding priority match',
      matchedOn: 'rural broadband deployment',
      source: 'funding_priority',
    });
    expect(
      explainSignals([
        { signal: 'capabilityKeyword', strength: 'moderate', matchedOn: 'fiber installation' },
      ]).strongest?.label,
    ).toBe('Capability match');
  });

  test('eligibility cannot become fit evidence on current or older saved records', () => {
    const explained = explainSignals([
      { signal: 'applicantType', strength: 'weak', weight: 25, matchedOn: 'Small businesses' },
      { signal: 'stateRestriction', strength: 'weak', weight: 15, matchedOn: 'VA' },
      { signal: 'applicantType', strength: 'weak', weight: 0, matchedOn: 'State governments' },
      { signal: 'genericTopical', strength: 'weak', weight: 0, matchedOn: 'government' },
    ]);
    expect(explained.signals).toEqual([]);
    expect(explained.strongest).toBeNull();
  });

  test('orders substantive evidence and retains contract set-aside evidence', () => {
    const explained = explainSignals([
      { signal: 'sector', strength: 'weak', weight: 4, matchedOn: 'aerospace' },
      { signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '336411' },
      { signal: 'applicantType', strength: 'strong', weight: 25, matchedOn: 'Small businesses' },
      { signal: 'setAsideSelfReported', strength: 'strong', weight: 10, matchedOn: 'SBA' },
    ]);
    expect(explained.signals.map((signal) => signal.signal)).toEqual([
      'naicsExact',
      'setAsideSelfReported',
      'sector',
    ]);
  });
});
