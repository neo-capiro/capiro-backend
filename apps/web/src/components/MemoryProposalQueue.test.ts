import { describe, expect, it } from 'vitest';
import {
  ownedMemoryCandidateTitle,
  shouldRenderMemoryProposalQueue,
  type OwnedMemoryCandidate,
} from './MemoryProposalQueue.js';

const candidate: OwnedMemoryCandidate = {
  id: 'candidate-1',
  scope: 'client',
  clientId: 'client-1',
  sourceKind: 'settings_sections',
  createdAt: '2026-07-31T12:00:00.000Z',
  restricted: false,
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
  capabilities: { withdraw: true },
};

describe('MemoryProposalQueue trust contract', () => {
  it('renders only for a server-enabled nonempty proposer queue', () => {
    expect(shouldRenderMemoryProposalQueue(undefined)).toBe(false);
    expect(shouldRenderMemoryProposalQueue({ enabled: false, candidates: [candidate] })).toBe(
      false,
    );
    expect(shouldRenderMemoryProposalQueue({ enabled: true, candidates: [] })).toBe(false);
    expect(shouldRenderMemoryProposalQueue({ enabled: true, candidates: [candidate] })).toBe(true);
  });

  it('uses the server-returned proposal identity and preserves a redacted label', () => {
    expect(ownedMemoryCandidateTitle(candidate)).toBe('Client Soul');
    expect(
      ownedMemoryCandidateTitle({
        ...candidate,
        restricted: true,
        proposal: null,
      }),
    ).toBe('Restricted client memory proposal');
  });

  it('exposes withdrawal capability only, never reviewer rejection', () => {
    expect(candidate.capabilities).toEqual({ withdraw: true });
    expect(candidate.capabilities).not.toHaveProperty('reject');
  });
});
