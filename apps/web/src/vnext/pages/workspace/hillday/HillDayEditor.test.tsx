import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HillDayEditor } from './HillDayEditor.js';
import type { FirstPageEdits, HillDayDocumentView } from './types.js';

const api = vi.hoisted(() => ({ getDocument: vi.fn(), quality: vi.fn(), patchDocument: vi.fn(), createExport: vi.fn() }));
vi.mock('./api.js', () => ({ useHillDayApi: () => api }));
vi.mock('../../../../env.js', () => ({ config: { apiBaseUrl: 'https://example.test' } }));

function documentFixture(id = 'doc-one'): HillDayDocumentView {
  return {
    id, name: `Schedule ${id}`, status: 'generated', blueprint: { slug: 'hill-day', name: 'Hill Day Schedule' },
    client: { id: 'client-one', name: 'Anduril', mono: 'AN', hasLogo: false }, firm: { name: 'Capiro' },
    owner: { id: 'user-one', name: 'Neo', initials: 'NM' }, lookbackDays: 90, timeZone: 'America/New_York',
    weekStart: '2026-10-05', resolutionStatus: 'clean',
    cover: { title: 'Hill Day Schedule', dateline: 'Monday, October 5, 2026 · 1 meeting', facts: [
      { k: 'Sponsor', v: 'Anduril' }, { k: 'Prepared by', v: 'Capiro' }, { k: 'Meetings', v: '1' },
      { k: 'Date', v: 'Monday, October 5, 2026' }, { k: 'Lead', v: 'Neo Martinez' }, { k: 'Revision', v: '2 · edited' },
    ] },
    summary: [{ sectionId: 'section-one', meetingId: 'meeting-one', time: '1:00 PM', member: 'Rep. Alma Adams', office: 'North Carolina 12th', room: '2436 Rayburn', minutes: '30', staffLead: 'To be confirmed' }],
    sections: [], provenance: { generatedAt: null, model: null, sourceCounts: [], corrections: [], failedUnits: 0, quality: 1, totalSources: 0 },
    generation: { lastJobId: null, status: null }, meetingCount: 1, updatedAt: '2026-09-11T10:00:00.000Z', createdAt: '2026-09-10T10:00:00.000Z',
  };
}

function applyEdits(doc: HillDayDocumentView, edits: FirstPageEdits | null): HillDayDocumentView {
  const defaults = documentFixture(doc.id);
  return { ...doc, firstPage: edits, updatedAt: '2026-09-11T11:00:00.000Z',
    cover: { title: edits?.title ?? defaults.cover.title, dateline: edits?.dateline ?? defaults.cover.dateline,
      facts: defaults.cover.facts.map((f) => ({ ...f, v: edits?.facts?.find((e) => e.key === f.k)?.value ?? f.v })) },
    summary: defaults.summary.map((r) => ({ ...r, ...edits?.rows?.find((e) => e.meetingId === r.meetingId) })),
    summaryColumns: (['time', 'member', 'office', 'room', 'minutes', 'staffLead'] as const).filter((c) => !edits?.hiddenColumns?.includes(c)),
  };
}

function renderEditor(id = 'doc-one') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (docId: string) => <QueryClientProvider client={client}><MemoryRouter><HillDayEditor documentId={docId} /></MemoryRouter></QueryClientProvider>;
  const rendered = render(tree(id));
  return { ...rendered, changeDocument: (docId: string) => rendered.rerender(tree(docId)) };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const change = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
async function editFirstPage() {
  await waitFor(() => expect(button('Edit first page').disabled).toBe(false));
  fireEvent.click(button('Edit first page'));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getDocument.mockImplementation(async (id: string) => documentFixture(id));
  api.quality.mockResolvedValue({ documentId: 'doc-one', score: 1, checks: [], computedAt: '' });
  api.patchDocument.mockImplementation(async (id: string, body: { firstPage: FirstPageEdits | null }) => applyEdits(documentFixture(id), body.firstPage));
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Hill Day first-page editing', () => {
  it('saves only changed fields and hidden columns, including intentional blank cells', async () => {
    const view = renderEditor();
    await editFirstPage();
    expect(button('Preview as client').disabled).toBe(true);
    expect(button('Deliver').disabled).toBe(true);
    change('Title', 'Anduril · Hill visits');
    change('Subtitle', 'October 5 · Draft for review');
    change('Sponsor', 'Anduril team');
    change('Meeting 1 room', 'Rayburn 101');
    change('Meeting 1 staff lead', '');
    for (const name of ['Office', 'Minutes', 'Staff lead']) fireEvent.click(screen.getByRole('checkbox', { name }));
    expect(screen.queryByRole('columnheader', { name: 'Office' })).toBeNull();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    fireEvent.click(button('Save first page'));
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('doc-one', {
      expectedUpdatedAt: '2026-09-11T10:00:00.000Z', firstPage: {
        title: 'Anduril · Hill visits', dateline: 'October 5 · Draft for review',
        facts: [{ key: 'Sponsor', value: 'Anduril team' }], rows: [{ meetingId: 'meeting-one', room: 'Rayburn 101', staffLead: '' }],
        hiddenColumns: ['office', 'minutes', 'staffLead'],
      },
    }));
    await waitFor(() => expect(button('Preview as client').disabled).toBe(false));
    expect(screen.getByRole('heading', { name: 'Anduril · Hill visits' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    // A new editor gets its saved values and visibility from GET, with no local draft state.
    const saved = await api.patchDocument.mock.results[0]!.value;
    view.unmount();
    api.getDocument.mockResolvedValue(saved);
    renderEditor();
    await editFirstPage();
    expect((screen.getByRole('textbox', { name: 'Meeting 1 room' }) as HTMLTextAreaElement).value).toBe('Rayburn 101');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Staff lead' }));
    expect((screen.getByRole('textbox', { name: 'Meeting 1 staff lead' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('drops orphaned overrides when meetings have been removed from the schedule', async () => {
    const doc = documentFixture();
    doc.firstPage = { rows: [{ meetingId: 'removed-meeting', room: 'Obsolete room' }] };
    api.getDocument.mockResolvedValue(doc);
    renderEditor();
    await editFirstPage();
    change('Title', 'Current schedule');
    fireEvent.click(button('Save first page'));
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('doc-one', {
      expectedUpdatedAt: doc.updatedAt, firstPage: { title: 'Current schedule' },
    }));
  });

  it('keeps prior overrides without freezing untouched source values or temporary changes', async () => {
    const doc = applyEdits(documentFixture(), { title: 'Custom cover', rows: [{ meetingId: 'meeting-one', room: 'Custom room' }] });
    api.getDocument.mockResolvedValue(doc);
    renderEditor();
    await editFirstPage();
    change('Revision', 'temporary');
    change('Revision', '2 · edited');
    change('Meeting 1 member', 'Updated member');
    fireEvent.click(button('Save first page'));
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('doc-one', {
      expectedUpdatedAt: doc.updatedAt,
      firstPage: { title: 'Custom cover', rows: [{ meetingId: 'meeting-one', room: 'Custom room', member: 'Updated member' }] },
    }));
  });

  it('cancels all local edits and prevents hiding the last visible column', async () => {
    renderEditor();
    await editFirstPage();
    change('Title', 'Discard me');
    for (const name of ['Office', 'Minutes', 'Staff lead', 'Room', 'Time']) fireEvent.click(screen.getByRole('checkbox', { name }));
    expect((screen.getByRole('checkbox', { name: 'Member' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(button('Cancel'));
    expect(api.patchDocument).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Hill Day Schedule' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(6);
    expect(button('Preview as client').disabled).toBe(false);
  });

  it('preserves input after a failed save and keeps exports blocked during and after failure', async () => {
    let rejectSave!: (reason: unknown) => void;
    api.patchDocument.mockReturnValue(new Promise((_, reject) => { rejectSave = reject; }));
    renderEditor();
    await editFirstPage();
    change('Title', 'Keep my draft');
    fireEvent.click(button('Save first page'));
    expect(button('Saving…').disabled).toBe(true);
    expect(button('Preview as client').disabled).toBe(true);
    expect(button('Deliver').disabled).toBe(true);
    await act(async () => rejectSave({ response: { data: { message: 'Document changed. Reload before saving.' } } }));
    expect(screen.getByRole('alert').textContent).toContain('Document changed. Reload before saving.');
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Keep my draft');
    expect(button('Save first page').disabled).toBe(false);
    expect(button('Preview as client').disabled).toBe(true);
    expect(api.createExport).not.toHaveBeenCalled();
  });

  it('restores saved defaults and all columns using an optimistic concurrency version', async () => {
    const doc = applyEdits(documentFixture(), { title: 'Custom cover', hiddenColumns: ['office', 'room', 'staffLead'] });
    api.getDocument.mockResolvedValue(doc);
    renderEditor();
    await waitFor(() => expect(button('Restore defaults').disabled).toBe(false));
    fireEvent.click(button('Restore defaults'));
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('doc-one', { firstPage: null, expectedUpdatedAt: doc.updatedAt }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Hill Day Schedule' })).toBeTruthy());
    expect(screen.getAllByRole('columnheader')).toHaveLength(6);
  });

  it('clears stale preview links when editing and does not carry drafts across document routes', async () => {
    api.createExport.mockResolvedValue({ status: 'ready', url: '/export?token=qa' });
    const view = renderEditor();
    await waitFor(() => expect(button('Preview as client').disabled).toBe(false));
    fireEvent.click(button('Preview as client'));
    await screen.findByRole('link', { name: /Open the client preview/ });
    await editFirstPage();
    expect(screen.queryByRole('link', { name: /Open the client preview/ })).toBeNull();
    change('Title', 'Wrong document');
    view.changeDocument('doc-two');
    await waitFor(() => expect(button('Schedule doc-two')).toBeTruthy());
    expect(screen.queryByRole('textbox', { name: 'Title' })).toBeNull();
    expect(button('Preview as client').disabled).toBe(false);
    await editFirstPage();
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Hill Day Schedule');
    change('Lead', 'New owner');
    fireEvent.click(button('Save first page'));
    await waitFor(() => expect(api.patchDocument).toHaveBeenCalledWith('doc-two', { expectedUpdatedAt: documentFixture().updatedAt, firstPage: { facts: [{ key: 'Lead', value: 'New owner' }] } }));
  });
});
