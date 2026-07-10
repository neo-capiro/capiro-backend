import { severityFor } from './emit-state-changes.js';

describe('severityFor (emit-state-changes, S5.3)', () => {
  it('rates enacted/vetoed/failed high (exactly as specced)', () => {
    for (const s of ['enacted', 'vetoed', 'failed']) {
      expect(severityFor(s)).toBe('high');
    }
  });
  it('rates mid-process advances medium', () => {
    for (const s of ['passed_chamber', 'to_governor']) {
      expect(severityFor(s)).toBe('medium');
    }
  });
  it('rates everything else info, including dead_by_deadline and veto_overridden', () => {
    expect(severityFor('dead_by_deadline')).toBe('info');
    expect(severityFor('veto_overridden')).toBe('info');
    expect(severityFor('reported')).toBe('info');
  });
});
