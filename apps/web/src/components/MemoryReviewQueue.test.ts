import { describe, expect, it } from 'vitest';
import {
  candidateRejectRequiresReason,
  memoryCandidateKindLabel,
  memoryReviewCandidateTitle,
  shouldRenderMemoryReviewQueue,
  type ReviewableMemoryCandidate,
} from './MemoryReviewQueue.js';

const candidate: ReviewableMemoryCandidate = {
  id: 'candidate-1',
  candidateKind: 'standard',
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
  it('renders only when the server enables review and returns authorized candidates', () => {
    expect(shouldRenderMemoryReviewQueue(undefined)).toBe(false);
    expect(shouldRenderMemoryReviewQueue({ enabled: false, candidates: [candidate] })).toBe(false);
    expect(shouldRenderMemoryReviewQueue({ enabled: true, candidates: [] })).toBe(false);
    expect(shouldRenderMemoryReviewQueue({ enabled: true, candidates: [candidate] })).toBe(true);
  });

  it('uses server-returned proposal and candidate identities', () => {
    expect(memoryReviewCandidateTitle(candidate)).toBe('Client Soul');
    expect(memoryCandidateKindLabel(candidate.candidateKind)).toBe('New memory');
    expect(
      memoryReviewCandidateTitle({
        ...candidate,
        proposal: { key: 'explicit:key', value: 'value', canonicalItem: null },
      }),
    ).toBe('explicit:key');
  });

  it('requires bounded rejection evidence for immutable version candidates only', () => {
    expect(candidateRejectRequiresReason(candidate)).toBe(false);
    expect(candidateRejectRequiresReason({ ...candidate, candidateKind: 'correction' })).toBe(true);
    expect(candidateRejectRequiresReason({ ...candidate, candidateKind: 'restore' })).toBe(true);
    expect(candidateRejectRequiresReason({ ...candidate, candidateKind: 'contradiction' })).toBe(
      true,
    );
  });

  it('keeps approve and reject capabilities distinct', () => {
    expect(candidate.capabilities).toEqual({ approve: true, reject: false });
  });
});
