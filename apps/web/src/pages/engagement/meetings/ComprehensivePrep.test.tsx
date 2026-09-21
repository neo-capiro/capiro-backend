import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PrepSearchSettings } from './ComprehensivePrep.js';

const state = vi.hoisted(() => ({
  auth: { userId: 'user-a', orgId: 'org-a' },
  actAsTenantSlug: null as string | null,
  get: vi.fn(),
  put: vi.fn(),
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => state.auth }));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: state.actAsTenantSlug }),
}));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: state.get, put: state.put }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tree(qc: QueryClient, clientId: string | null = 'client-a', meetingId = 'meeting-a') {
  return (
    <QueryClientProvider client={qc}>
      <PrepSearchSettings
        meetingId={meetingId}
        clientId={clientId}
        depth="standard"
        setDepth={vi.fn()}
      />
    </QueryClientProvider>
  );
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const boardInput = () =>
  screen.getByRole('textbox', { name: 'Monday.com board IDs for this client' });
const saveButton = () => screen.getByRole('button', { name: 'Save board mapping' });

describe('PrepSearchSettings', () => {
  beforeEach(() => {
    state.auth = { userId: 'user-a', orgId: 'org-a' };
    state.actAsTenantSlug = null;
    state.get.mockReset();
    state.put.mockReset();
    state.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/capabilities')
        ? { meetingPrepComprehensiveEnabled: true }
        : { clientId: 'client-a', boardIds: ['111'] },
    }));
    state.put.mockImplementation(async (_url: string, body: { boardIds: string[] }) => ({
      data: { clientId: 'client-a', boardIds: body.boardIds },
    }));
  });

  test('shows board IDs directly, independently of the closed search-depth control', async () => {
    const qc = queryClient();
    render(tree(qc));
    await waitFor(() => expect(boardInput()).toHaveValue('111'));
    expect(boardInput()).toBeEnabled();
    expect(boardInput().closest('details')).toBeNull();
    expect(
      screen.getByText('Search depth', { selector: 'summary' }).closest('details'),
    ).not.toHaveAttribute('open');
  });

  test('keeps a disabled board field and assign-client guidance for an unassigned meeting', () => {
    render(tree(queryClient(), null));
    expect(boardInput()).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(
      screen.getByText('Assign this meeting to a client to add Monday.com board IDs.'),
    ).toBeVisible();
    expect(state.get.mock.calls.some(([url]) => url.endsWith('/prep-monday-mapping'))).toBe(false);
  });

  test('shows capability loading, then a recoverable error without hiding the field', async () => {
    const pending = deferred<never>();
    state.get.mockReturnValueOnce(pending.promise);
    const qc = queryClient();
    render(tree(qc));
    expect(boardInput()).toBeDisabled();
    expect(screen.getByText('Checking meeting preparation settings…')).toBeVisible();
    await act(async () => {
      pending.reject(new Error('offline'));
    });
    expect(await screen.findByRole('button', { name: 'Retry preparation settings' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry preparation settings' }));
    await waitFor(() => expect(boardInput()).toBeEnabled());
  });

  test('explains a disabled comprehensive-prep capability', async () => {
    state.get.mockResolvedValue({ data: { meetingPrepComprehensiveEnabled: false } });
    render(tree(queryClient()));
    expect(
      await screen.findByText('Monday.com meeting preparation is unavailable for this workspace.'),
    ).toBeVisible();
    expect(boardInput()).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });

  test('shows mapping loading and lets a failed lookup retry successfully', async () => {
    const pending = deferred<never>();
    state.get.mockImplementationOnce(async () => ({
      data: { meetingPrepComprehensiveEnabled: true },
    }));
    state.get.mockImplementationOnce(() => pending.promise);
    render(tree(queryClient()));
    expect(await screen.findByText('Loading your Monday.com board IDs…')).toBeVisible();
    expect(boardInput()).toBeDisabled();
    await act(async () => {
      pending.reject(new Error('Mapping could not load.'));
    });
    expect(await screen.findByText('Mapping could not load.')).toBeVisible();
    expect(boardInput()).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry board settings' }));
    await waitFor(() => expect(boardInput()).toHaveValue('111'));
    expect(boardInput()).toBeEnabled();
  });

  test('does not overwrite a board draft when server data refreshes', async () => {
    const qc = queryClient();
    render(tree(qc));
    await waitFor(() => expect(boardInput()).toHaveValue('111'));
    fireEvent.change(boardInput(), { target: { value: '222, 333' } });
    state.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/capabilities')
        ? { meetingPrepComprehensiveEnabled: true }
        : { clientId: 'client-a', boardIds: ['999'] },
    }));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['meeting-prep-monday-mapping'] });
    });
    expect(boardInput()).toHaveValue('222, 333');
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(state.put).toHaveBeenCalledWith(
        '/api/engagement/meetings/meeting-a/prep-monday-mapping',
        { boardIds: ['222', '333'] },
      ),
    );
    expect(await screen.findByText('Board mapping saved.')).toBeVisible();
  });

  test.each(['user', 'organization', 'impersonation'] as const)(
    'clears the previous %s scope immediately and ignores a late save completion',
    async (change) => {
      const qc = queryClient();
      const saving = deferred<{ data: { clientId: string; boardIds: string[] } }>();
      const nextMapping = deferred<{ data: { clientId: string; boardIds: string[] } }>();
      state.put.mockReturnValueOnce(saving.promise);
      const mounted = render(tree(qc));
      await waitFor(() => expect(boardInput()).toHaveValue('111'));
      fireEvent.change(boardInput(), { target: { value: '222' } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(state.put).toHaveBeenCalledTimes(1));
      if (change === 'user') state.auth.userId = 'user-b';
      if (change === 'organization') state.auth.orgId = 'org-b';
      if (change === 'impersonation') state.actAsTenantSlug = 'maven';
      state.get.mockImplementation((url: string) =>
        url.endsWith('/capabilities')
          ? Promise.resolve({ data: { meetingPrepComprehensiveEnabled: true } })
          : nextMapping.promise,
      );
      mounted.rerender(tree(qc));
      expect(boardInput()).toHaveValue('');
      expect(boardInput()).toBeDisabled();
      await act(async () => {
        nextMapping.resolve({ data: { clientId: 'client-a', boardIds: ['777'] } });
      });
      await waitFor(() => expect(boardInput()).toHaveValue('777'));
      await act(async () => {
        saving.resolve({ data: { clientId: 'client-a', boardIds: ['222'] } });
      });
      expect(boardInput()).toHaveValue('777');
      expect(screen.queryByText('Board mapping saved.')).not.toBeInTheDocument();
      expect(saveButton()).toBeEnabled();
      const capabilityCalls = state.get.mock.calls.filter(([url]) => url.endsWith('/capabilities'));
      expect(capabilityCalls).toHaveLength(2);
    },
  );

  test('resets cached boards, unsaved edits and save feedback when the assigned client changes', async () => {
    const qc = queryClient();
    const mounted = render(tree(qc));
    await waitFor(() => expect(boardInput()).toHaveValue('111'));
    fireEvent.click(saveButton());
    expect(await screen.findByText('Board mapping saved.')).toBeVisible();
    fireEvent.change(boardInput(), { target: { value: '222' } });
    expect(screen.queryByText('Board mapping saved.')).not.toBeInTheDocument();
    state.get.mockImplementation(async () => ({
      data: { clientId: 'client-b', boardIds: ['777'] },
    }));
    mounted.rerender(tree(qc, 'client-b'));
    expect(boardInput()).toHaveValue('');
    expect(boardInput()).toBeDisabled();
    await waitFor(() => expect(boardInput()).toHaveValue('777'));
    expect(screen.queryByText('Board mapping saved.')).not.toBeInTheDocument();
  });

  test('resets the draft on meeting changes, even when the client is unchanged', async () => {
    const qc = queryClient();
    const mounted = render(tree(qc));
    await waitFor(() => expect(boardInput()).toHaveValue('111'));
    fireEvent.change(boardInput(), { target: { value: '222' } });
    state.get.mockImplementation(async () => ({
      data: { clientId: 'client-a', boardIds: ['777'] },
    }));
    mounted.rerender(tree(qc, 'client-a', 'meeting-b'));
    expect(boardInput()).toHaveValue('');
    await waitFor(() => expect(boardInput()).toHaveValue('777'));
  });

  test('blocks a mapping response for a reassigned client', async () => {
    state.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/capabilities')
        ? { meetingPrepComprehensiveEnabled: true }
        : { clientId: 'client-b', boardIds: ['999'] },
    }));
    render(tree(queryClient()));
    expect(
      await screen.findByText(
        'The meeting client changed. Reopen this meeting before saving board IDs.',
      ),
    ).toBeVisible();
    expect(boardInput()).toHaveValue('');
    expect(saveButton()).toBeDisabled();
  });

  test('keeps an unavailable mapping visible and recoverable', async () => {
    state.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/capabilities') ? { meetingPrepComprehensiveEnabled: true } : null,
    }));
    render(tree(queryClient()));
    expect(
      await screen.findByText('Monday.com board settings are currently unavailable.'),
    ).toBeVisible();
    expect(boardInput()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry board settings' })).toBeVisible();
  });

  test('preserves the draft and refuses success when the save endpoint returns no mapping', async () => {
    state.put.mockResolvedValue({ data: null });
    render(tree(queryClient()));
    await waitFor(() => expect(boardInput()).toHaveValue('111'));
    fireEvent.change(boardInput(), { target: { value: '222' } });
    fireEvent.click(saveButton());
    expect(
      await screen.findByText('Monday.com board settings are unavailable. Retry shortly.'),
    ).toBeVisible();
    expect(screen.queryByText('Board mapping saved.')).not.toBeInTheDocument();
    expect(boardInput()).toHaveValue('222');
    expect(saveButton()).toBeEnabled();
  });
});
