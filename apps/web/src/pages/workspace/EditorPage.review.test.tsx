import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CapiroToastProvider } from '../../vnext/components/feedback/toast.js';
import { EditorPage } from './EditorPage.js';

const state = vi.hoisted(() => {
  const draft = {
    id: 'saved-debrief', docTitle: 'Saved hearing debrief', client: null,
    updatedAt: '2026-10-06T00:00:00Z', documents: [],
    config: {
      product: 'Hearing debrief', sections: ['Executive Summary'], offices: [],
      sectionContent: { 'Executive Summary': '<p>Verified hearing findings.</p>' },
      sectionMeta: {}, letterhead: 'none',
    },
  };
  const save = vi.fn().mockResolvedValue({});
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}) };
  return { draft, save, mutation, empty: { data: [] }, api: { get: vi.fn().mockResolvedValue({ data: [] }) } };
});

vi.mock('../../lib/use-api.js', () => ({ useApi: () => state.api }));
vi.mock('../../lib/me.js', () => ({ useMe: () => ({ data: null }) }));
vi.mock('./api.js', async (load) => ({
  ...await load<typeof import('./api.js')>(),
  useDraft: () => ({ data: state.draft, isLoading: false }),
  useUpdateDraft: () => ({ mutateAsync: state.save }),
  useUpdateDocument: () => state.mutation, useAddDocument: () => state.mutation,
  useDeleteDocument: () => state.mutation, useGenerateSection: () => state.mutation,
  useGenerateAll: () => state.mutation, useRetryFailedSections: () => state.mutation,
  useCreateVersion: () => state.mutation, useCreateComment: () => state.mutation,
  useWorkspaceAssistant: () => state.mutation,
  useCollaborators: () => state.empty, useTenantMembers: () => state.empty,
  useComments: () => state.empty, useDraftContext: () => state.empty,
}));
vi.mock('./editor/useEditLock.js', () => ({ useEditLock: () => ({ lock: {}, canEdit: true }) }));
vi.mock('./editor/PaperBody.js', () => ({
  PaperBody: ({ onMarkReviewed, sections }: {
    onMarkReviewed: (name: string) => void; sections: { name: string; status: string; content: string }[];
  }) => <>{sections.map((section) => <div key={section.name}>
    <span>{section.status}</span><div dangerouslySetInnerHTML={{ __html: section.content }} />
    <button onClick={() => onMarkReviewed(section.name)}>Mark reviewed</button>
  </div>)}</>,
}));
vi.mock('./StepsRail.js', () => ({ StepsRail: () => null }));
vi.mock('./editor/EditorToolbar.js', () => ({ EditorToolbar: () => null }));
vi.mock('./editor/RichTextToolbar.js', () => ({ RichTextToolbar: () => null }));
vi.mock('./editor/DraftOutline.js', () => ({ DraftOutline: () => null }));
vi.mock('./editor/OfficeRow.js', () => ({ OfficeRow: () => null }));
vi.mock('./editor/DocTabs.js', () => ({ DocTabs: () => null }));
vi.mock('./editor/InsertRail.js', () => ({ InsertRail: () => null }));
vi.mock('./editor/MeriPanel.js', () => ({ MeriPanel: () => null }));
vi.mock('./editor/canvas-blocks.js', () => ({ Letterhead: () => null }));
vi.mock('./editor/VersionPopover.js', () => ({ VersionPopover: () => null }));
vi.mock('./editor/LockBanner.js', () => ({ LockBanner: () => null }));
vi.mock('./LibraryPage.js', () => ({ MeriDraftingOverlay: () => null }));

describe('Editor review on the vNext surface', () => {
  it('marks a saved section reviewed, shows feedback, and autosaves without an Ant App provider', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><CapiroToastProvider>
      <MemoryRouter initialEntries={['/workspace/draft/saved-debrief']}><Routes>
        <Route path="/workspace/draft/:draftId" element={<EditorPage />} />
      </Routes></MemoryRouter>
    </CapiroToastProvider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Marked "Executive Summary" reviewed');
    await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        sectionMeta: { 'Executive Summary': { status: 'done' } },
        sectionContent: { 'Executive Summary': '<p>Verified hearing findings.</p>' },
      }),
    })), { timeout: 4000 });
    expect(screen.getByText('Verified hearing findings.')).toBeInTheDocument();
  });
});
