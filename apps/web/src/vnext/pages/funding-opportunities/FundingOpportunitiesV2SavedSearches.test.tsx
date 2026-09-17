import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { OpportunitySearchCriteriaV2 } from '@capiro/shared';
import { DEFAULT_V2_CRITERIA } from './funding-opportunities-v2-state.js';
import { FundingOpportunitiesV2SavedSearches } from './FundingOpportunitiesV2SavedSearches.js';
import type { FundingOpportunityV2Api, SavedSearchRecordV2 } from './FundingOpportunitiesV2Adapter.js';

vi.mock('./funding-opportunities-v2-icons.js', () => ({
  FundingOpportunityV2Icon: ({ name }: { name: string }) => <span aria-hidden="true">{name}</span>,
}));

const criteria: OpportunitySearchCriteriaV2 = {
  ...DEFAULT_V2_CRITERIA,
  clientId: 'client-a',
  query: 'autonomous systems',
  sectors: ['defense electronics'],
};

function search(overrides: Partial<SavedSearchRecordV2> = {}): SavedSearchRecordV2 {
  return {
    id: 'search-1',
    name: 'Defense search',
    description: 'Important notices',
    visibility: 'tenant',
    clientId: 'client-a',
    criteria,
    warnings: [],
    archivedAt: null,
    createdByUserId: 'user-1',
    ownerId: 'user-1',
    updatedAt: '2026-09-16T12:00:00.000Z',
    ...overrides,
  };
}

function mount({ api = {} as FundingOpportunityV2Api, searches = [search()], currentUserId = 'user-1' as string | null, saveOpen = false, activeSavedSearchId = null as string | null } = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onApplyCriteria = vi.fn();
  const onApplyAndRefresh = vi.fn();
  const onToast = vi.fn();
  render(
    <FundingOpportunitiesV2SavedSearches
      api={api}
      criteria={criteria}
      activeSavedSearchId={activeSavedSearchId}
      clientName="Acme Defense"
      clients={[{ id: 'client-a', name: 'Acme Defense' }]}
      currentUserId={currentUserId}
      currentUserRole="standard_user"
      searches={searches}
      loading={false}
      error={false}
      open={!saveOpen}
      saveOpen={saveOpen}
      onClose={onClose}
      onOpenSave={vi.fn()}
      onSaved={onSaved}
      onApplyCriteria={onApplyCriteria}
      onApplyAndRefresh={onApplyAndRefresh}
      onToast={onToast}
    />,
  );
  return { onClose, onSaved, onApplyCriteria, onApplyAndRefresh, onToast };
}

function focusHarness() {
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return <><button onClick={() => setOpen(true)}>Open saved searches</button><FundingOpportunitiesV2SavedSearches api={{} as FundingOpportunityV2Api} criteria={criteria} clientName="Acme Defense" clients={[{ id: 'client-a', name: 'Acme Defense' }]} currentUserId="user-1" currentUserRole="standard_user" searches={[search()]} loading={false} error={false} open={open} saveOpen={false} onClose={() => setOpen(false)} onOpenSave={vi.fn()} onSaved={vi.fn()} onApplyCriteria={vi.fn()} onApplyAndRefresh={vi.fn()} onToast={vi.fn()} /></>;
  }
  return render(<Harness />);
}

function saveOriginHarness() {
  function Harness() {
    const [surface, setSurface] = React.useState<'page' | 'saved' | 'save'>('page');
    const [fromSaved, setFromSaved] = React.useState(false);
    return (
      <>
        <button onClick={() => { setFromSaved(false); setSurface('save'); }}>Open direct save</button>
        <button onClick={() => { setFromSaved(false); setSurface('saved'); }}>Open saved searches</button>
        <FundingOpportunitiesV2SavedSearches
          api={{} as FundingOpportunityV2Api}
          criteria={criteria}
          clientName="Acme Defense"
          clients={[{ id: 'client-a', name: 'Acme Defense' }]}
          currentUserId="user-1"
          currentUserRole="standard_user"
          searches={[search()]}
          loading={false}
          error={false}
          open={surface === 'saved' || surface === 'save'}
          saveOpen={surface === 'save'}
          saveOpenedFromSaved={fromSaved}
          onClose={(keepParent) => {
            if (keepParent && fromSaved) setSurface('saved');
            else { setFromSaved(false); setSurface('page'); }
          }}
          onOpenSave={(origin) => { setFromSaved(Boolean(origin)); setSurface('save'); }}
          onSaved={vi.fn()}
          onApplyCriteria={vi.fn()}
          onApplyAndRefresh={vi.fn()}
          onToast={vi.fn()}
        />
      </>
    );
  }
  return render(<Harness />);
}

describe('FundingOpportunitiesV2SavedSearches', () => {
  test('opens on the dialog close button and restores focus to the external trigger', async () => {
    focusHarness();
    const trigger = screen.getByRole('button', { name: 'Open saved searches' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Saved searches' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  test('Escape closes only the topmost save client menu and preserves the draft', async () => {
    mount({ saveOpen: true });
    const name = screen.getByLabelText('Name — required');
    fireEvent.change(name, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('dialog', { name: 'Choose a client' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Save search' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this draft')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Choose a client' })).not.toBeInTheDocument();
  });


  test('preserves the Saved drawer across Save cancel and then returns to the external trigger', () => {
    saveOriginHarness();
    const external = screen.getByRole('button', { name: 'Open saved searches' });
    external.focus();
    fireEvent.click(external);
    const openSave = screen.getByRole('button', { name: 'Save current search' });
    openSave.focus();
    fireEvent.click(openSave);
    expect(screen.getByRole('dialog', { name: 'Saved searches' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Save search' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Save search' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Saved searches' })).toBeInTheDocument();
    expect(document.activeElement).toBe(openSave);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Saved searches' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(external);
  });

  test('direct Save cancel returns to the page without a parent drawer', () => {
    saveOriginHarness();
    const direct = screen.getByRole('button', { name: 'Open direct save' });
    direct.focus();
    fireEvent.click(direct);
    expect(screen.getByRole('dialog', { name: 'Save search' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Save search' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Saved searches' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(direct);
  });

  test('client picker Close restores Change focus without changing the draft', () => {
    mount({ saveOpen: true });
    const name = screen.getByLabelText('Name — required');
    fireEvent.change(name, { target: { value: 'Keep this draft' } });
    const change = screen.getByRole('button', { name: 'Change' });
    fireEvent.click(change);
    const picker = screen.getByRole('dialog', { name: 'Choose a client' });
    expect(picker).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('button', { name: /^Close$/ }));
    expect(screen.queryByRole('dialog', { name: 'Choose a client' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(change);
    expect(screen.getByDisplayValue('Keep this draft')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Save search' })).toBeInTheDocument();
  });

  test.each([
    ['Rename Defense search', 'Rename Defense search', 'input'],
    ['Archive Defense search', 'Archive Defense search', 'button'],
    ['Delete Defense search', 'Delete Defense search', 'button'],
  ])('Escape closes %s and restores focus to its trigger', async (triggerName, dialogName, initialControl) => {
    mount();
    const trigger = screen.getByRole('button', { name: triggerName });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: dialogName })).toBeInTheDocument();
    expect(document.activeElement?.tagName.toLowerCase()).toBe(initialControl);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: dialogName })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  test('archives with PATCH archived:true and never calls DELETE', async () => {
    const updateSearch = vi.fn().mockResolvedValue(search({ archivedAt: '2026-09-16T12:01:00.000Z' }));
    const deleteSearch = vi.fn();
    mount({ api: { updateSearch, deleteSearch } as unknown as FundingOpportunityV2Api });

    fireEvent.click(screen.getByRole('button', { name: 'Archive Defense search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(updateSearch).toHaveBeenCalledWith('search-1', { archived: true }));
    expect(deleteSearch).not.toHaveBeenCalled();
  });

  test('deletes the selected record id only after delete confirmation', async () => {
    const second = search({ id: 'search-2', name: 'Second search' });
    const deleteSearch = vi.fn().mockResolvedValue({ deleted: true, id: 'search-2' });
    mount({ api: { deleteSearch } as unknown as FundingOpportunityV2Api, searches: [search(), second] });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Second search' }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));

    await waitFor(() => expect(deleteSearch).toHaveBeenCalledWith('search-2'));
  });

  test('keeps the save form and entered values after a failed save', async () => {
    const saveSearch = vi.fn().mockRejectedValue(new Error('request failed'));
    const mounted = mount({ api: { saveSearch } as unknown as FundingOpportunityV2Api, saveOpen: true });

    fireEvent.change(screen.getByLabelText('Name — required'), { target: { value: 'Keep this name' } });
    fireEvent.change(screen.getByLabelText('Description — optional'), { target: { value: 'Keep this description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save search' }));

    await waitFor(() => expect(saveSearch).toHaveBeenCalled());
    expect(screen.getByDisplayValue('Keep this name')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this description')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Save search' })).toBeInTheDocument();
    expect(mounted.onClose).not.toHaveBeenCalled();
    expect(mounted.onSaved).not.toHaveBeenCalled();
    expect(mounted.onToast).toHaveBeenCalledWith('error', 'The saved search could not be updated.');
  });

  test('disables protected mutations when the authenticated identity is unknown', () => {
    mount({ currentUserId: null });

    expect(screen.getByRole('button', { name: 'Rename Defense search' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive Defense search' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Defense search' })).toBeDisabled();
  });

  test('renders typed saved criteria and only marks the active stale search changed', () => {
    const stale = search({ id: 'search-1', criteria: { ...criteria, sectors: ['defense electronics'], naicsCodes: ['541715'] } });
    const unchanged = search({ id: 'search-2', name: 'Unchanged search', criteria });
    mount({ searches: [stale, unchanged], activeSavedSearchId: 'search-1' });
    expect(screen.getAllByText(/Active opportunities for Acme Defense in defense electronics/)).toHaveLength(2);
    expect(screen.getByText(/NAICS 541715/)).toBeInTheDocument();
    expect(screen.getByText('Criteria changed')).toBeInTheDocument();
    expect(screen.queryAllByText('Criteria changed')).toHaveLength(1);
  });

  test('removes keywords from the saved copy without changing the displayed discovery criteria', async () => {
    const saveSearch = vi.fn().mockResolvedValue(search({ criteria: { ...criteria, query: '' } }));
    const mounted = mount({ api: { saveSearch } as unknown as FundingOpportunityV2Api, saveOpen: true });

    fireEvent.change(screen.getByLabelText('Name — required'), { target: { value: 'Filters only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save without keywords' }));

    expect(screen.getByText('None — this search would match on filters alone')).toBeInTheDocument();
    expect(screen.getByText('Saved without keywords. The current discovery query remains unchanged.')).toBeInTheDocument();
    expect(screen.getByText('defense electronics')).toBeInTheDocument();
    expect(screen.queryByText('Sectors: defense electronics')).not.toBeInTheDocument();
    expect(screen.getByText('None — this search would match on filters alone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save search' }));
    await waitFor(() => expect(saveSearch).toHaveBeenCalledWith(expect.objectContaining({ criteria: expect.objectContaining({ query: '' }) })));
    expect(saveSearch).toHaveBeenCalledWith(expect.objectContaining({ criteria: expect.objectContaining({ sectors: ['defense electronics'] }) }));
    expect(mounted.onApplyCriteria).not.toHaveBeenCalled();
    expect(mounted.onApplyAndRefresh).not.toHaveBeenCalled();
    expect(criteria.query).toBe('autonomous systems');
  });
});
