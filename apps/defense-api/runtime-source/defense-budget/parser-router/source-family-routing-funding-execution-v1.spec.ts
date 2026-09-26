import { routingForSourceFamily } from './source-family-routing.js';

describe('alternative-funding/execution source-family routing', () => {
  it('routes alternative funding families to their own family group, not annual public-law/committee groups', () => {
    for (const family of ['alt_supplemental', 'alt_reconciliation', 'alt_continuing_resolution', 'alt_rescission', 'alt_transfer', 'alt_reprogramming'] as const) {
      expect(routingForSourceFamily(family).family).toBe('alternative_funding');
    }
  });

  it('routes execution inputs to their own family group rather than unknown', () => {
    for (const family of ['exec_allocation', 'exec_obligation', 'exec_award'] as const) {
      expect(routingForSourceFamily(family).family).toBe('execution');
    }
  });
});
