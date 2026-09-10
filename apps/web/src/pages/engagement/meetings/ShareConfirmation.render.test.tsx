// EM-09 — the "Approve first" hint text next to an unapproved artifact must
// point somewhere real. Attachments never had a tab to approve from until
// DebriefTab.tsx grew an AttachmentApprovalList (see its own header comment);
// this used to blanket-say "go to its tab to approve" for every artifact
// type, including attachments, which had no tab at all. Rendered coverage
// (not just the buildShareableItems/defaultSelectedKeys pure-function tests
// in ShareConfirmation.test.ts) so the actual displayed copy is asserted,
// not just the data shaping that feeds it.
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { ShareConfirmation } from './ShareConfirmation.js';
import type { Meeting } from './meetings-types.js';

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}));

vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { user: { id: 'u1' } } }),
}));

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Capiro Walkthrough',
    source: 'outlook',
    description: null,
    location: null,
    startsAt: '2026-09-08T14:00:00.000Z',
    endsAt: '2026-09-08T14:30:00.000Z',
    organizerEmail: null,
    organizerName: null,
    status: 'confirmed',
    metadata: null,
    isVirtual: false,
    joinLink: null,
    provider: null,
    visibility: 'private',
    sharedAt: null,
    sharedByUserId: null,
    client: { id: 'c1', name: 'Aperture' },
    attendees: [],
    attachments: [],
    preps: [],
    notes: [],
    debriefs: [],
    notesApproved: false,
    meri: null,
    contributors: [],
    sharedBy: null,
    ...overrides,
  };
}

function buildTree(qc: QueryClient, meeting: Meeting): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <ShareConfirmation meeting={meeting} open onClose={() => {}} />
      </AntApp>
    </QueryClientProvider>
  );
}

describe('ShareConfirmation — EM-09 unapproved-artifact hint text', () => {
  test('an unapproved attachment gets a hint naming the real Debrief tab, not "its tab"', () => {
    const meeting = makeMeeting({
      attachments: [
        {
          id: 'att-1',
          meetingId: 'm1',
          fileName: 'meeting-transcript-2026-09-08.txt',
          contentType: 'text/plain',
          byteSize: 4096,
          source: 'upload',
          createdAt: '2026-09-08T00:00:00Z',
          approvedAt: null,
        },
      ],
    });
    render(buildTree(new QueryClient(), meeting));

    expect(screen.getByText('meeting-transcript-2026-09-08.txt')).toBeInTheDocument();
    expect(
      screen.getByText('Approve first — open the Debrief tab to approve this attachment.'),
    ).toBeInTheDocument();
    // The old, now-dead-end phrasing must be gone for attachments specifically.
    expect(screen.queryByText('Approve first — go to its tab to approve.')).not.toBeInTheDocument();
  });

  test('an unapproved prep/note/debrief KEEPS the original "go to its tab" hint (they really do have tabs)', () => {
    const meeting = makeMeeting({
      notes: [{ id: 'n1', confidential: false, status: 'draft', createdAt: '2026-09-08T00:00:00Z' }],
    });
    render(buildTree(new QueryClient(), meeting));

    expect(screen.getByText('Approve first — go to its tab to approve.')).toBeInTheDocument();
  });
});
