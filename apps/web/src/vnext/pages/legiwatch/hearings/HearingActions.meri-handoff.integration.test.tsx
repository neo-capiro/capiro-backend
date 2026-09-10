import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HearingActions } from './HearingActions.js';
import { LW_MERI_CONTEXT_KEY } from '../../../meri/meri-legiwatch-handoff.js';

const mocks = vi.hoisted(() => ({
  auth: { orgId: 'org-a', userId: 'user-a' },
  impersonation: { actAsTenantSlug: null as string | null },
  otherCalls: [] as Array<{ success: (value: unknown) => void }>,
  calls: [] as Array<{
    input: unknown;
    success: (value: unknown) => void;
    error: (value: unknown) => void;
  }>,
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mocks.auth }));
vi.mock('../../../../state/impersonation.js', () => ({
  useImpersonation: () => mocks.impersonation,
}));
vi.mock('../lib/wave1-api.js', () => ({
  useAskMeri: () => ({
    mutate: (
      input: unknown,
      callbacks: { onSuccess: (value: unknown) => void; onError: (value: unknown) => void },
    ) => mocks.calls.push({ input, success: callbacks.onSuccess, error: callbacks.onError }),
  }),
  useCreateBrief: () => ({
    mutate: (_input: unknown, callbacks: { onSuccess: (value: unknown) => void }) =>
      mocks.otherCalls.push({ success: callbacks.onSuccess }),
  }),
  useStageOutreach: () => ({ mutate: vi.fn() }),
  useSaveItem: () => ({
    mutate: (_input: unknown, callbacks: { onSuccess: (value: unknown) => void }) =>
      mocks.otherCalls.push({ success: callbacks.onSuccess }),
  }),
  useCalendarExport: () => ({ mutate: vi.fn() }),
  downloadIcs: vi.fn(),
  w1Error: (error: Error) => error.message,
}));
const defaults = {
  hearingId: 'hearing-a',
  hearingTitle: 'Hearing A',
  clientId: 'client-a',
  canCreateBrief: true,
  canSaveMoment: true,
  pendingAction: null,
  onPendingHandled: () => undefined,
};
function view(props: Partial<typeof defaults> = {}) {
  return (
    <MemoryRouter>
      <HearingActions {...defaults} {...props} />
    </MemoryRouter>
  );
}
function packet(title: string) {
  return { hearing: { id: 'hearing-a', title }, client: { id: 'client-a' } };
}

describe('Ask Meri producer ownership', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.calls.length = 0;
    mocks.otherCalls.length = 0;
    mocks.auth.orgId = 'org-a';
    mocks.impersonation.actAsTenantSlug = null;
  });
  afterEach(() => vi.restoreAllMocks());
  it.each(['Create brief', 'Save to client'])(
    'a late %s completion cannot replace the latest Ask Meri result',
    (action) => {
      render(view());
      fireEvent.click(screen.getByRole('button', { name: action }));
      fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
      act(() => mocks.calls[0]!.success(packet('Latest hearing context')));
      const latest = sessionStorage.getItem(LW_MERI_CONTEXT_KEY);
      act(() => mocks.otherCalls[0]!.success({ draftId: 'stale-draft' }));
      expect(screen.getByText(/Hearing context prepared/)).toBeTruthy();
      expect(screen.queryByText(/Brief created in Workspace|Saved to your workspace/)).toBeNull();
      expect(sessionStorage.getItem(LW_MERI_CONTEXT_KEY)).toBe(latest);
    },
  );
  it.each(['Create brief', 'Save to client'])(
    'a late %s completion cannot publish into a new client selection',
    (action) => {
      const rendered = render(view());
      fireEvent.click(screen.getByRole('button', { name: action }));
      rendered.rerender(view({ clientId: 'client-other' }));
      act(() => mocks.otherCalls[0]!.success({ draftId: 'stale-draft' }));
      expect(screen.queryByText(/Brief created in Workspace|Saved to your workspace/)).toBeNull();
    },
  );
  it('keeps an initial recommended action alive through StrictMode effect replay', () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <HearingActions
            {...defaults}
            pendingAction={{ action: 'ask_meri', refs: { insightId: 'insight-a' } }}
          />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(mocks.calls).toHaveLength(1);
    act(() => mocks.calls[0]!.success(packet('Recommended hearing')));
    expect(sessionStorage.getItem(LW_MERI_CONTEXT_KEY)).not.toBeNull();
    expect(screen.getByText(/Hearing context prepared/)).toBeTruthy();
  });
  it('stores the exact owner and a unique launch id in the packet and destination', () => {
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    act(() => mocks.calls[0]!.success(packet('Prepared hearing')));
    const entry = JSON.parse(sessionStorage.getItem(LW_MERI_CONTEXT_KEY)!);
    expect(entry).toMatchObject({
      hearingId: 'hearing-a',
      identityKey: 'org-a:user-a',
      packet: packet('Prepared hearing'),
    });
    expect(entry.handoffId).toEqual(expect.any(String));
    expect(screen.getByText(/Hearing context prepared/)).toBeTruthy();
  });
  it('keeps the latest request when earlier requests settle later', () => {
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    act(() => mocks.calls[1]!.success(packet('Latest hearing context')));
    const latest = sessionStorage.getItem(LW_MERI_CONTEXT_KEY);
    act(() => mocks.calls[0]!.success(packet('Obsolete context')));
    expect(sessionStorage.getItem(LW_MERI_CONTEXT_KEY)).toBe(latest);
    act(() => mocks.calls[0]!.error(new Error('Obsolete failure')));
    expect(screen.queryByText('Obsolete failure')).toBeNull();
  });
  it.each(['tenant', 'client', 'hearing', 'unmount', 'return-to-original'] as const)(
    'drops late results after %s changes',
    (change) => {
      const rendered = render(view());
      fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
      if (change === 'tenant') {
        mocks.impersonation.actAsTenantSlug = 'tenant-other';
        rendered.rerender(view());
      }
      if (change === 'client') rendered.rerender(view({ clientId: 'client-other' }));
      if (change === 'hearing') rendered.rerender(view({ hearingId: 'hearing-other' }));
      if (change === 'return-to-original') {
        rendered.rerender(view({ clientId: 'client-other' }));
        rendered.rerender(view());
      }
      if (change === 'unmount') rendered.unmount();
      act(() => mocks.calls[0]!.success(packet('Obsolete context')));
      expect(sessionStorage.getItem(LW_MERI_CONTEXT_KEY)).toBeNull();
      expect(screen.queryByText(/Hearing context prepared/)).toBeNull();
    },
  );
  it('reports storage failure without preparing a destination', () => {
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    act(() => mocks.calls[0]!.success(packet('Unstored context')));
    expect(screen.getByText(/could not be saved for Meri/)).toBeTruthy();
    expect(screen.queryByText(/Hearing context prepared/)).toBeNull();
  });
});
