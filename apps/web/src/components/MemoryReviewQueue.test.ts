import { describe, expect, it } from 'vitest';
import {
  memoryReviewCandidateTitle,
  shouldRenderMemoryReviewQueue,
  type ReviewableMemoryCandidate,
} from './MemoryReviewQueue.js';

const candidate: ReviewableMemoryCandidate = {
  id: 'candidate-1',
  scope: 'client',
  clientId: 'client-1',
  proposedByUserId: 'proposer-1',
  sourceKind: 'settings_sections',
  createdAt: '2026-07-31T12:00:00.000Z',
  proposal: {
    key: 'settings-file:client-soul:client-1',
    value: null,
    canonicalItem: {
      type: 'client-soul',
      slug: 'client-1',
      title: 'Client Soul',
      sections: [
        {
          key: 'priorities',
          heading: 'Priorities',
          owner: 'human',
          body: 'Protect the FY27 request.',
        },
      ],
    },
  },
  capabilities: { approve: true, reject: false },
};

describe('MemoryReviewQueue trust contract', () => {
  it('renders only when the server says review is enabled and returns authorized candidates', () => {
    expect(shouldRenderMemoryReviewQueue(undefined)).toBe(false);
    expect(shouldRenderMemoryReviewQueue({ enabled: false, candidates: [candidate] })).toBe(false);
    expect(shouldRenderMemoryReviewQueue({ enabled: true, candidates: [] })).toBe(false);
    expect(shouldRenderMemoryReviewQueue({ enabled: true, candidates: [candidate] })).toBe(true);
  });

  it('uses the server-returned proposal identity rather than inventing one in the browser', () => {
    expect(memoryReviewCandidateTitle(candidate)).toBe('Client Soul');
    expect(
      memoryReviewCandidateTitle({
        ...candidate,
        proposal: { key: 'explicit:key', value: 'value', canonicalItem: null },
      }),
    ).toBe('explicit:key');
  });

  it('keeps approve and reject capabilities distinct', () => {
    expect(candidate.capabilities).toEqual({ approve: true, reject: false });
  });
});
