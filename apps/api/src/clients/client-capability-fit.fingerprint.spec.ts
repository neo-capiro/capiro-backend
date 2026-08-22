import { capabilityFitFingerprint } from './client-capability-fit.fingerprint.js';

const capA = {
  id: 'cap-1',
  name: 'Autonomous Ground Systems',
  tags: ['autonomy', 'robotics'],
  keywords: ['UGV'],
  peNumbers: ['0605053A'],
  peNumber: null,
  sector: 'defense',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('capabilityFitFingerprint', () => {
  it('is a stable sha256 hex digest', () => {
    const fp = capabilityFitFingerprint({ capabilities: [capA] });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(capabilityFitFingerprint({ capabilities: [capA] })).toBe(fp);
  });

  it('ignores capability ordering', () => {
    const capB = { ...capA, id: 'cap-2', name: 'Hypersonics' };
    expect(capabilityFitFingerprint({ capabilities: [capA, capB] })).toBe(
      capabilityFitFingerprint({ capabilities: [capB, capA] }),
    );
  });

  it('changes when a tag changes', () => {
    expect(capabilityFitFingerprint({ capabilities: [{ ...capA, tags: ['autonomy'] }] })).not.toBe(
      capabilityFitFingerprint({ capabilities: [capA] }),
    );
  });

  it('changes when a PE number changes', () => {
    expect(
      capabilityFitFingerprint({ capabilities: [{ ...capA, peNumbers: ['0604256F'] }] }),
    ).not.toBe(capabilityFitFingerprint({ capabilities: [capA] }));
  });

  it('changes when the capability set grows', () => {
    expect(
      capabilityFitFingerprint({ capabilities: [capA, { ...capA, id: 'cap-2' }] }),
    ).not.toBe(capabilityFitFingerprint({ capabilities: [capA] }));
  });

  it('changes when client issue codes change', () => {
    expect(
      capabilityFitFingerprint({ capabilities: [capA], issueCodes: ['DEF'] }),
    ).not.toBe(capabilityFitFingerprint({ capabilities: [capA] }));
  });

  it('tolerates a Date updatedAt and non-array tags JSON', () => {
    const fp = capabilityFitFingerprint({
      capabilities: [{ ...capA, tags: null, updatedAt: new Date('2026-08-01T00:00:00.000Z') }],
    });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes an empty capability set without throwing', () => {
    expect(capabilityFitFingerprint({ capabilities: [] })).toMatch(/^[0-9a-f]{64}$/);
  });
});
