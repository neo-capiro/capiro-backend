// Phase 2 §3.e — ShareConfirmation lists every artifact individually and
// selects only approved, not-yet-shared ones by default. Unapproved
// artifacts are never selectable (see the component's toggle() guard),
// never mind default-selected — approval is a hard requirement, not a
// preference.

import { describe, expect, it } from 'vitest';
import { buildShareableItems, defaultSelectedKeys } from './ShareConfirmation.js';
import type { Meeting } from './meetings-types.js';

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Budget sync',
    source: 'outlook',
    description: null,
    location: null,
    startsAt: '2020-01-01T14:00:00.000Z',
    endsAt: '2020-01-01T14:30:00.000Z',
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

describe('buildShareableItems', () => {
  it('marks a note approved only when status is exactly "approved"', () => {
    const meeting = makeMeeting({
      notes: [
        { id: 'n1', confidential: false, status: 'approved', createdAt: '2026-07-01T00:00:00Z' },
        { id: 'n2', confidential: false, status: 'draft', createdAt: '2026-07-01T00:00:00Z' },
        { id: 'n3', confidential: false, createdAt: '2026-07-01T00:00:00Z' }, // no status at all
      ],
    });
    const items = buildShareableItems(meeting);
    expect(items.find((i) => i.id === 'n1')?.approved).toBe(true);
    expect(items.find((i) => i.id === 'n2')?.approved).toBe(false);
    expect(items.find((i) => i.id === 'n3')?.approved).toBe(false);
  });

  it('marks an attachment approved via approvedAt, not a status field', () => {
    const meeting = makeMeeting({
      attachments: [
        {
          id: 'a1',
          meetingId: 'm1',
          fileName: 'notes.pdf',
          contentType: 'application/pdf',
          byteSize: 100,
          source: 'upload',
          createdAt: '2026-07-01T00:00:00Z',
          approvedAt: '2026-07-02T00:00:00Z',
        },
        {
          id: 'a2',
          meetingId: 'm1',
          fileName: 'draft.pdf',
          contentType: 'application/pdf',
          byteSize: 100,
          source: 'upload',
          createdAt: '2026-07-01T00:00:00Z',
        },
      ],
    });
    const items = buildShareableItems(meeting);
    expect(items.find((i) => i.id === 'a1')?.approved).toBe(true);
    expect(items.find((i) => i.id === 'a2')?.approved).toBe(false);
  });

  it('flags an artifact already shared via sharedAt', () => {
    const meeting = makeMeeting({
      preps: [
        {
          id: 'p1',
          status: 'approved',
          agenda: [],
          talkingPoints: [],
          risks: [],
          followUps: [],
          emailEvidence: [],
          summary: null,
          provider: null,
          model: null,
          sharedAt: '2026-07-03T00:00:00Z',
          sharedByUserId: 'u1',
          createdAt: '2026-07-01T00:00:00Z',
          updatedAt: '2026-07-01T00:00:00Z',
        },
      ],
    });
    const items = buildShareableItems(meeting);
    expect(items[0]?.alreadyShared).toBe(true);
  });
});

describe('defaultSelectedKeys (Phase 2 §3.e — approved-only default selection)', () => {
  it('selects an approved, not-yet-shared artifact', () => {
    const keys = defaultSelectedKeys([
      { type: 'note', id: 'n1', label: 'Note', approved: true, alreadyShared: false },
    ]);
    expect(keys.has('note:n1')).toBe(true);
  });

  it('never selects an unapproved artifact, even if the caller tried to force it', () => {
    const keys = defaultSelectedKeys([
      { type: 'note', id: 'n1', label: 'Note', approved: false, alreadyShared: false },
    ]);
    expect(keys.size).toBe(0);
  });

  it('does not re-select an artifact that is already shared', () => {
    const keys = defaultSelectedKeys([
      { type: 'debrief', id: 'd1', label: 'Debrief', approved: true, alreadyShared: true },
    ]);
    expect(keys.size).toBe(0);
  });

  it('handles a mixed set, selecting only the approved-and-unshared subset', () => {
    const keys = defaultSelectedKeys([
      { type: 'prep', id: 'p1', label: 'Prep', approved: true, alreadyShared: false },
      { type: 'note', id: 'n1', label: 'Note', approved: false, alreadyShared: false },
      { type: 'debrief', id: 'd1', label: 'Debrief', approved: true, alreadyShared: true },
      { type: 'attachment', id: 'a1', label: 'File', approved: true, alreadyShared: false },
    ]);
    expect(Array.from(keys).sort()).toEqual(['attachment:a1', 'prep:p1']);
  });
});
