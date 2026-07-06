import { toCanonicalAlert } from './canonical-alert.adapter';
import type { IntelAlertEvent } from './intel-alert.types';

const base: IntelAlertEvent = {
  tenantId: 't1',
  clientId: 'c1',
  billId: '119-hr-1',
  displayNum: 'H.R. 1',
  billTitle: 'A bill',
  changeType: 'bill_passed_chamber',
  triggerKey: 'floorVote',
  label: 'Passed the House',
  severity: 'notable',
  detail: 'Passed/agreed to in House.',
  actionDate: '2026-07-01',
  url: 'https://example.gov',
};

describe('tracker → canonical Alert adapter (SC1.1/SC1.2)', () => {
  it('maps a populated event; whoActs is flagged (no tracker source), alert still returned', () => {
    const out = toCanonicalAlert({ ...base, why: 'Client bill moved', matchedTags: ['defense'] });
    expect(out.alert.whatChanged).toBe('Passed/agreed to in House.');
    expect(out.alert.whyItMatters).toBe('Client bill moved');
    expect(out.alert.issueId).toBe('defense');
    expect(out.alert.deadline).toBe('2026-07-01');
    expect(out.alert.sourceType).toBe('bill');
    // Drop-nothing: incomplete (whoActs has no source) but the alert is present.
    expect(out.complete).toBe(false);
    expect(out.missingFields).toEqual(['whoActs']);
  });

  it('flags missing why/tag rather than fabricating them', () => {
    const out = toCanonicalAlert(base);
    expect(out.complete).toBe(false);
    expect(out.missingFields).toEqual(
      expect.arrayContaining(['whyItMatters', 'issueId', 'whoActs']),
    );
    expect(out.alert.whatChanged).toBe('Passed/agreed to in House.');
  });

  it('hearing triggers map to the hearing source type', () => {
    const out = toCanonicalAlert({ ...base, triggerKey: 'hearing' });
    expect(out.alert.sourceType).toBe('hearing');
  });
});
