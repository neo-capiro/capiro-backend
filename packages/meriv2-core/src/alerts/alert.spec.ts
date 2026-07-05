import { REQUIRED_ALERT_FIELDS, buildAlert, isAlertComplete, type Alert } from './alert';

const full: Alert = {
  whatChanged: 'HASC marked up the FY26 NDAA autonomy line',
  whyItMatters: 'Directly funds the client program element',
  clientId: 'client_1',
  issueId: 'issue_autonomy',
  whoActs: 'Lead lobbyist',
  deadline: '2026-08-01',
  draftArtifactId: 'artifact_1',
  complianceCheckId: 'cc_1',
};

describe('buildAlert', () => {
  it('returns complete with no missing fields when fully populated', () => {
    const r = buildAlert(full);
    expect(r.complete).toBe(true);
    expect(r.missingFields).toEqual([]);
    expect(r.alert).toEqual(full);
  });

  it('FLAGS missing required fields but still returns the alert (never dropped)', () => {
    const r = buildAlert({ whatChanged: 'x', whyItMatters: 'y', clientId: 'c', issueId: 'i' });
    expect(r.complete).toBe(false);
    expect(r.missingFields).toEqual(['whoActs']);
    // The alert is still returned, with the missing field as an empty string.
    expect(r.alert.whoActs).toBe('');
    expect(r.alert.whatChanged).toBe('x');
  });

  it('treats blank/whitespace required values as missing', () => {
    const r = buildAlert({ ...full, whyItMatters: '   ', clientId: '' });
    expect(r.complete).toBe(false);
    expect(r.missingFields).toEqual(['whyItMatters', 'clientId']);
  });

  it('normalizes optional fields to null when absent', () => {
    const r = buildAlert({
      whatChanged: 'a',
      whyItMatters: 'b',
      clientId: 'c',
      issueId: 'i',
      whoActs: 'w',
    });
    expect(r.complete).toBe(true);
    expect(r.alert.deadline).toBeNull();
    expect(r.alert.draftArtifactId).toBeNull();
    expect(r.alert.complianceCheckId).toBeNull();
  });

  it('preserves + trims provided optional fields', () => {
    const r = buildAlert({ ...full, draftArtifactId: '  artifact_9  ' });
    expect(r.alert.draftArtifactId).toBe('artifact_9');
  });

  it('reports ALL missing required fields for an empty input', () => {
    const r = buildAlert({});
    expect(r.complete).toBe(false);
    expect(r.missingFields).toEqual([...REQUIRED_ALERT_FIELDS]);
  });
});

describe('isAlertComplete', () => {
  it('is true for a fully-populated alert and false otherwise', () => {
    expect(isAlertComplete(full)).toBe(true);
    expect(isAlertComplete({ ...full, whoActs: '' })).toBe(false);
  });
});

describe('REQUIRED_ALERT_FIELDS', () => {
  it('is exactly the five actionable fields', () => {
    expect([...REQUIRED_ALERT_FIELDS]).toEqual([
      'whatChanged',
      'whyItMatters',
      'clientId',
      'issueId',
      'whoActs',
    ]);
  });
});
