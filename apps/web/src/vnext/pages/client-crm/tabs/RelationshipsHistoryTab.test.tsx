import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClientCrmHistoryProto } from './RelationshipsHistoryTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: vi.fn(), patch: patchMock }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function renderHistory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmHistoryProto client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
});

describe('ClientCrmHistoryProto', () => {
  it('shows a real empty state instead of the TIMELINE fixture when the client has no activity', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText('No activity recorded for this client yet.')).toBeInTheDocument(),
    );
    // A TIMELINE fixture title must not leak through as if real.
    expect(screen.queryByText('Overland AI Strategy Review')).not.toBeInTheDocument();
  });
});

/* ── Export (item 7, wire-audit "3 Compose extend") ───────────────────────── */

const ACTIVITY = [
  {
    id: 'act-1',
    kind: 'call',
    occurredAt: '2026-08-04T15:30:00.000Z',
    // Deliberately absent from portfolio-fixtures.ts, so the assertions cannot
    // pass against the TIMELINE fixture.
    title: 'Quarterly check-in with program office',
    body: 'Discussed FY27 timing, budget posture, and the "next" steps',
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: true,
    dueAt: null,
    settledAt: null,
    origin: 'recorded',
  },
  {
    id: 'act-2',
    kind: 'meeting',
    occurredAt: '2026-07-30T13:00:00.000Z',
    title: 'Site visit debrief',
    body: null,
    personId: null,
    sourceType: 'meeting',
    sourceId: 'meet-9',
    pinned: false,
    dueAt: null,
    settledAt: null,
    origin: 'derived',
  },
];

function captureCsv() {
  const blobs: Blob[] = [];
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    blobs.push(blob as Blob);
    return 'blob:csv';
  });
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return {
    blobs,
    restore: () => {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      clickSpy.mockRestore();
    },
  };
}

describe('ClientCrmHistoryProto — Export', () => {
  it('exports the real activity rows as CSV', async () => {
    getMock.mockResolvedValue({ data: ACTIVITY });
    const csv = captureCsv();
    renderHistory();

    await screen.findByText('Quarterly check-in with program office');
    fireEvent.click(screen.getByText('Export'));

    const text = await csv.blobs[0]!.text();
    expect(text.split('\r\n')[0]).toBe(
      'Occurred at,Kind,Group,Title,Detail,Origin,Pinned,Due at,Settled at,Source type,Source id',
    );
    // The raw ISO timestamp, not the abbreviated on-screen date.
    expect(text).toContain('2026-08-04T15:30:00.000Z');
    expect(text).toContain('Quarterly check-in with program office');
    expect(text).toContain('Site visit debrief');
    // A field holding a comma and quotes is quoted and its quotes doubled, or
    // the row silently gains columns in a spreadsheet.
    expect(text).toContain('"Discussed FY27 timing, budget posture, and the ""next"" steps"');
    csv.restore();
  });

  it('exports only the filtered view', async () => {
    getMock.mockResolvedValue({ data: ACTIVITY });
    const csv = captureCsv();
    renderHistory();

    await screen.findByText('Quarterly check-in with program office');
    fireEvent.click(screen.getByRole('button', { name: 'Calls' }));
    fireEvent.click(screen.getByText('Export'));

    const text = await csv.blobs[0]!.text();
    expect(text).toContain('Quarterly check-in with program office');
    expect(text).not.toContain('Site visit debrief');
    csv.restore();
  });

  it('disables Export rather than writing the TIMELINE fixture to a file', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderHistory();

    // The fixture is on screen for pixel review; a CSV of it would outlive the
    // context that made it obviously a placeholder.
    expect(screen.getByText('Export')).toBeDisabled();
  });
});

/* ── Open commitments rail (item 8, wire-audit "3 Compose extend") ────────── */

const COMMITMENTS = [
  {
    id: 'act-due',
    kind: 'commitment',
    occurredAt: '2026-08-01T12:00:00.000Z',
    // Absent from portfolio-fixtures.ts, so these cannot pass against OV_ATTN.
    title: 'Send the revised cost narrative',
    body: null,
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: false,
    dueAt: '2026-08-30T12:00:00.000Z',
    settledAt: null,
    origin: 'recorded',
  },
  {
    id: 'act-undated',
    kind: 'commitment',
    occurredAt: '2026-08-02T12:00:00.000Z',
    title: 'Introduce the team to committee staff',
    body: null,
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: false,
    dueAt: null,
    settledAt: null,
    origin: 'recorded',
  },
  {
    id: 'act-settled',
    kind: 'commitment',
    occurredAt: '2026-07-01T12:00:00.000Z',
    title: 'Already handled commitment',
    body: null,
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: false,
    dueAt: '2026-07-30T12:00:00.000Z',
    settledAt: '2026-07-29T12:00:00.000Z',
    origin: 'recorded',
  },
];

/** The rail lives in the "Relationship controls" card; the same activity also
 *  appears in the timeline, so every rail assertion is scoped to that card. */
async function railCard() {
  const heading = await screen.findByText('Relationship controls');
  const card = heading.closest('section');
  if (!card) throw new Error('Relationship controls card not found');
  return within(card);
}

describe('ClientCrmHistoryProto — open commitments rail', () => {
  it('lists real open commitments, including one with no due date, and drops settled ones', async () => {
    getMock.mockResolvedValue({ data: COMMITMENTS });
    renderHistory();

    const rail = await railCard();
    await waitFor(() => expect(rail.getByText('Send the revised cost narrative')).toBeInTheDocument());
    // An undated commitment is still outstanding — it just has no date to show.
    expect(rail.getByText('Introduce the team to committee staff')).toBeInTheDocument();
    expect(rail.getByText('No due date')).toBeInTheDocument();
    // Settled means off the rail.
    expect(rail.queryByText('Already handled commitment')).not.toBeInTheDocument();
    // The OV_ATTN fixture rows this rail used to borrow must not leak through.
    expect(screen.queryByText('Client requested an Army procurement assessment')).not.toBeInTheDocument();
    expect(screen.queryByText('Conference restoration memo has no source pack')).not.toBeInTheDocument();
  });

  it('settles a commitment through the real activity endpoint', async () => {
    getMock.mockResolvedValue({ data: COMMITMENTS });
    patchMock.mockResolvedValue({ data: { id: 'act-due' } });
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Settle Send the revised cost narrative' }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-1/activity/act-due', { settled: true }),
    );
  });

  it('offers no Settle on an undated commitment — the API refuses those', async () => {
    getMock.mockResolvedValue({ data: COMMITMENTS });
    renderHistory();

    // Wait for the rail to be real before asserting an absence.
    await screen.findByRole('button', { name: 'Settle Send the revised cost narrative' });
    expect(
      screen.queryByRole('button', { name: 'Settle Introduce the team to committee staff' }),
    ).not.toBeInTheDocument();
  });

  it('shows a real empty rail once activity resolves to nothing, not the fixture', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderHistory();

    await waitFor(() => expect(screen.getByText('Nothing outstanding.')).toBeInTheDocument());
    // And the invented "pinned note" sentence is gone once we know there is none.
    expect(screen.getByText(/No pinned note yet/)).toBeInTheDocument();
    expect(
      screen.queryByText('Client prefers concise written updates before live strategy discussions.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the fixture rail while the fetch is still in flight', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderHistory();

    expect(screen.queryByText('Nothing outstanding.')).not.toBeInTheDocument();
  });
});
