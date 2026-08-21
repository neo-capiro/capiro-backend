import { TenantHearingRelevanceProcessor } from './tenant-hearing-relevance.processor.js';
import type { PublicHearingInsight } from './public-hearing-intelligence.types.js';

const insight: PublicHearingInsight = {
  id: 'i1',
  hearingId: 'h1',
  captureId: 'c1',
  segmentId: 's1',
  sequence: 1,
  startMs: 0,
  endMs: 5_000,
  insightType: 'PROGRAM_ELEMENT_REFERENCE',
  title: 'Program Element 0605053A referenced',
  summary:
    'The Department of the Army discussed autonomous ground systems and H.R. 1.',
  evidenceText:
    'The Department of the Army discussed autonomous ground systems and H.R. 1.',
  entities: [
    { entityType: 'PROGRAM_ELEMENT', label: '0605053A', canonicalId: '0605053A' },
    { entityType: 'BILL', label: 'H.R. 1', canonicalId: 'HR-1' },
    { entityType: 'AGENCY', label: 'Department of the Army' },
  ],
  extractor: 'deterministic-public-facts',
  extractorVersion: '1',
  createdAt: '2026-08-21T12:00:00Z',
};

describe('TenantHearingRelevanceProcessor', () => {
  it('scores tenant-owned client matches separately from public insights', () => {
    const processor = new TenantHearingRelevanceProcessor({
      now: () => new Date('2026-08-21T12:00:00Z'),
    });
    const original = JSON.parse(JSON.stringify(insight)) as PublicHearingInsight;
    const result = processor.score({
      insights: [insight],
      context: {
        hearingId: 'h1',
        title: 'Defense posture',
        committeeName: 'Armed Services',
      },
      tenantContext: {
        tenantId: 'tenant-a',
        clients: [
          {
            clientId: 'client-a',
            clientName: 'Example Robotics',
            keywords: ['autonomous ground systems'],
            billIds: ['HR-1'],
            programElementIds: ['0605053A'],
            agencies: ['Army'],
            committees: ['Armed Services'],
          },
        ],
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-a',
        clientId: 'client-a',
        score: 100,
        matchedOn: expect.arrayContaining([
          { kind: 'BILL', value: 'HR-1' },
          { kind: 'PROGRAM_ELEMENT', value: '0605053A' },
          { kind: 'KEYWORD', value: 'autonomous ground systems' },
          { kind: 'COMMITTEE', value: 'Armed Services' },
        ]),
      }),
    );
    expect(insight).toEqual(original);
  });

  it('does not create a tenant row below the relevance threshold', () => {
    const processor = new TenantHearingRelevanceProcessor({ minimumScore: 20 });
    expect(
      processor.score({
        insights: [insight],
        context: { hearingId: 'h1', title: 'Defense posture' },
        tenantContext: {
          tenantId: 'tenant-a',
          clients: [
            {
              clientId: 'client-b',
              keywords: ['agriculture'],
              billIds: [],
              programElementIds: [],
              agencies: [],
              committees: [],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('rejects an insight from another hearing', () => {
    const processor = new TenantHearingRelevanceProcessor();
    expect(() =>
      processor.score({
        insights: [{ ...insight, hearingId: 'other' }],
        context: { hearingId: 'h1', title: 'Defense posture' },
        tenantContext: { tenantId: 'tenant-a', clients: [] },
      }),
    ).toThrow(/belongs to/i);
  });
});
