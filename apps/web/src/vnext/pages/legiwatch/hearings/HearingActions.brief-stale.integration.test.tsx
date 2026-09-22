import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  auth: { orgId: 'org-1', userId: 'user-1', isLoaded: true },
  impersonation: { actAsTenantSlug: null as string | null },
  // Every render of the stubbed dialog pushes the `onSaved` closure it was
  // given — capturing it here (not clicking a DOM button) lets the test
  // invoke a STALE dialog session's callback even after it has unmounted,
  // the same way a real in-flight save promise would resolve late.
  onSavedCalls: [] as Array<(draftId: string) => void>,
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mock.auth }));
vi.mock('../../../../state/impersonation.js', () => ({ useImpersonation: () => mock.impersonation }));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ post: async () => ({ data: {} }), get: async () => ({ data: {} }) }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ data: undefined }) }));

vi.mock('./CreateBriefDialog.js', () => ({
  CreateBriefDialog: ({ onSaved, onClose }: { onSaved: (draftId: string) => void; onClose: () => void }) => {
    mock.onSavedCalls.push(onSaved);
    return (
      <div role="dialog" aria-label="Create brief (stub)">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    );
  },
}));

import { HearingActions } from './HearingActions.js';

const defaults = {
  hearingId: 'hearing-1',
  hearingTitle: 'Hearing one',
  clientId: 'client-1',
  hasTranscript: true,
  canSaveMoment: true,
  pendingAction: null,
  onPendingHandled: vi.fn(),
};

function mount(initial: Partial<Parameters<typeof HearingActions>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = (props: Partial<Parameters<typeof HearingActions>[0]> = {}) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HearingActions {...defaults} {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = render(view(initial));
  return {
    ...rendered,
    update: (props: Partial<Parameters<typeof HearingActions>[0]> = {}) => rendered.rerender(view(props)),
  };
}

beforeEach(() => {
  mock.auth.orgId = 'org-1';
  mock.auth.userId = 'user-1';
  mock.impersonation.actAsTenantSlug = null;
  mock.onSavedCalls.length = 0;
});
afterEach(() => cleanup());

describe('Create brief completion guards a stale/superseded dialog session', () => {
  it('ignores a save that completes after the hearing changes, and does not surface it as the new status', async () => {
    const ui = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Create brief' }));
    await screen.findByRole('dialog', { name: 'Create brief (stub)' });
    expect(mock.onSavedCalls).toHaveLength(1);
    const staleOnSaved = mock.onSavedCalls[0]!;

    ui.update({ hearingId: 'hearing-2' });
    expect(screen.queryByRole('dialog', { name: 'Create brief (stub)' })).not.toBeInTheDocument();

    act(() => staleOnSaved('draft-stale'));
    expect(screen.queryByText('Brief saved to Workspace.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open →' })).not.toBeInTheDocument();
  });

  it('ignores a save that completes after Cancel, and does not clobber a later action', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Create brief' }));
    await screen.findByRole('dialog', { name: 'Create brief (stub)' });
    const staleOnSaved = mock.onSavedCalls[0]!;

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Create brief (stub)' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save to client' }));
    expect(await screen.findByText('Saved to your workspace.')).toBeInTheDocument();

    act(() => staleOnSaved('draft-stale'));
    expect(screen.getByText('Saved to your workspace.')).toBeInTheDocument();
    expect(screen.queryByText('Brief saved to Workspace.')).not.toBeInTheDocument();
  });

  it('applies a save that completes normally while its dialog is still the current one', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Create brief' }));
    await screen.findByRole('dialog', { name: 'Create brief (stub)' });
    act(() => mock.onSavedCalls[0]!('draft-1'));
    expect(await screen.findByText('Brief saved to Workspace.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open →' })).toBeInTheDocument();
  });
});
