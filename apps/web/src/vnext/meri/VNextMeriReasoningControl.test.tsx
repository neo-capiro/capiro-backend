import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const patch = vi.fn();
  return {
    get,
    patch,
    api: { get, patch },
    orgId: 'org-1',
    userId: 'user-1',
    actAsTenantSlug: null as string | null,
  };
});

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => mocks.api,
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mocks }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => mocks }));

import {
  VNextMeriReasoningControl,
  applyReasoningModeToConversation,
  readDraftReasoningMode,
  writeDraftReasoningMode,
} from './VNextMeriReasoningControl.js';
import { useMeriReasoningMode } from './meri-reasoning-state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ModeConsumer({ conversationId }: { conversationId: string }) {
  const { mode, chooseMode } = useMeriReasoningMode(conversationId);
  return (
    <div>
      <output aria-label="Shared mode">{mode}</output>
      <button onClick={() => void chooseMode('deep')}>Choose deep</button>
      <button onClick={() => void chooseMode('standard')}>Choose standard</button>
    </div>
  );
}

let testIdentity = 0;
const identityKey = () => `${mocks.actAsTenantSlug ?? mocks.orgId}:${mocks.userId}`;

describe('VNextMeriReasoningControl', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.patch.mockReset();
    mocks.get.mockResolvedValue({ data: { reasoningMode: 'standard' } });
    mocks.patch.mockResolvedValue({ data: { reasoningMode: 'deep' } });
    mocks.orgId = 'org-1';
    mocks.userId = `user-${++testIdentity}`;
    mocks.actAsTenantSlug = null;
    window.sessionStorage.clear();
  });

  test('loads the saved mode and exposes every supported reasoning option', async () => {
    render(<VNextMeriReasoningControl conversationId="conversation-1" />);

    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith(
        '/api/clio/v3/conversations/conversation-1/reasoning-mode',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning depth: Standard' }));

    expect(screen.getByRole('menu', { name: 'Reasoning depth' })).toBeTruthy();
    expect(screen.getByText('REASONING DEPTH · THIS THREAD')).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Fast/ })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Standard/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: /Deep/ })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: /Max/ })).toBeTruthy();
  });

  test('persists a selected mode for the active conversation', async () => {
    render(<VNextMeriReasoningControl conversationId="conversation-1" />);

    await screen.findByRole('button', { name: 'Reasoning depth: Standard' });
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning depth: Standard' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Deep/ }));

    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        '/api/clio/v3/conversations/conversation-1/reasoning-mode',
        { reasoningMode: 'deep' },
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reasoning depth: Deep' })).toBeTruthy(),
    );
  });

  test('persists Standard when resetting an existing Max thread', async () => {
    mocks.get.mockResolvedValueOnce({ data: { reasoningMode: 'max' } });
    render(<VNextMeriReasoningControl conversationId="conversation-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning depth: Max' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Standard/ }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        '/api/clio/v3/conversations/conversation-1/reasoning-mode',
        { reasoningMode: 'standard' },
      ),
    );
    expect(screen.getByRole('button', { name: 'Reasoning depth: Standard' })).toBeTruthy();
  });

  test('the shared apply helper persists Standard rather than silently retaining a previous depth', async () => {
    await applyReasoningModeToConversation(mocks.api, 'conversation-1', 'standard');
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/clio/v3/conversations/conversation-1/reasoning-mode',
      { reasoningMode: 'standard' },
    );
  });

  test('restores the prior choice and reports an error when persistence fails', async () => {
    mocks.patch.mockRejectedValueOnce(new Error('offline'));
    render(<VNextMeriReasoningControl conversationId="conversation-1" />);

    await screen.findByRole('button', { name: 'Reasoning depth: Standard' });
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning depth: Standard' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The reasoning mode could not be saved.'),
    );
    expect(screen.getByRole('button', { name: 'Reasoning depth: Standard' })).toBeTruthy();
  });

  test('on the new-thread screen stores a draft mode without calling the API', async () => {
    render(<VNextMeriReasoningControl conversationId={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning depth: Standard' }));
    expect(screen.getByText('REASONING DEPTH · THIS NEW THREAD')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reasoning depth: Max' })).toBeTruthy(),
    );
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(readDraftReasoningMode(identityKey())).toBe('max');
  });

  test('read/write draft helpers round-trip a valid mode', () => {
    writeDraftReasoningMode('deep', identityKey());
    expect(readDraftReasoningMode(identityKey())).toBe('deep');
  });

  test('header and another consumer share one saved mode and one Standard update', async () => {
    mocks.get.mockResolvedValue({ data: { reasoningMode: 'max' } });
    render(
      <>
        <VNextMeriReasoningControl conversationId="shared" />
        <ModeConsumer conversationId="shared" />
      </>,
    );
    await screen.findByRole('button', { name: 'Reasoning depth: Max' });
    expect(screen.getByLabelText('Shared mode')).toHaveTextContent('max');
    expect(mocks.get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Choose standard' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/api/clio/v3/conversations/shared/reasoning-mode', {
        reasoningMode: 'standard',
      }),
    );
    expect(screen.getByRole('button', { name: 'Reasoning depth: Standard' })).toBeTruthy();
    expect(screen.getByLabelText('Shared mode')).toHaveTextContent('standard');
  });

  test('a delayed initial GET cannot overwrite an explicit Standard selection', async () => {
    const read = deferred<{ data: { reasoningMode: string } }>();
    mocks.get.mockReturnValueOnce(read.promise);
    render(<VNextMeriReasoningControl conversationId="slow-read" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning depth: Standard' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Standard/ }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    await act(async () => {
      read.resolve({ data: { reasoningMode: 'max' } });
    });
    expect(screen.getByRole('button', { name: 'Reasoning depth: Standard' })).toBeTruthy();
  });

  test('serializes writes and does not roll back a newer choice when an earlier save settles', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.patch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mocks.get.mockResolvedValue({ data: { reasoningMode: 'max' } });
    render(<ModeConsumer conversationId="queued" />);
    await waitFor(() => expect(screen.getByLabelText('Shared mode')).toHaveTextContent('max'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose deep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose standard' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Shared mode')).toHaveTextContent('standard');
    await act(async () => {
      first.resolve({});
    });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Shared mode')).toHaveTextContent('standard');
    await act(async () => {
      second.resolve({});
    });
    expect(mocks.patch.mock.calls.map((call) => call[1])).toEqual([
      { reasoningMode: 'deep' },
      { reasoningMode: 'standard' },
    ]);
  });

  test('a failed shared save restores the last confirmed mode for every control', async () => {
    mocks.get.mockResolvedValue({ data: { reasoningMode: 'deep' } });
    mocks.patch.mockRejectedValueOnce(new Error('offline'));
    render(
      <>
        <VNextMeriReasoningControl conversationId="failed-shared" />
        <ModeConsumer conversationId="failed-shared" />
      </>,
    );
    await screen.findByRole('button', { name: 'Reasoning depth: Deep' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose standard' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Reasoning depth: Deep' })).toBeTruthy();
    expect(screen.getByLabelText('Shared mode')).toHaveTextContent('deep');
  });

  test('does not dispatch an older queued choice after the effective identity changes', async () => {
    const first = deferred<unknown>();
    mocks.get
      .mockResolvedValueOnce({ data: { reasoningMode: 'max' } })
      .mockResolvedValueOnce({ data: { reasoningMode: 'fast' } });
    mocks.patch.mockReturnValueOnce(first.promise);
    const view = render(<ModeConsumer conversationId="queued-identity" />);
    await waitFor(() => expect(screen.getByLabelText('Shared mode')).toHaveTextContent('max'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose deep' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Choose standard' }));
    mocks.actAsTenantSlug = 'another-tenant';
    view.rerender(<ModeConsumer conversationId="queued-identity" />);
    await waitFor(() => expect(screen.getByLabelText('Shared mode')).toHaveTextContent('fast'));
    await act(async () => {
      first.resolve({});
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Shared mode')).toHaveTextContent('fast');
  });

  test('thread changes isolate stale GET and PATCH completions', async () => {
    const readA = deferred<{ data: { reasoningMode: string } }>();
    const saveA = deferred<unknown>();
    mocks.get
      .mockReturnValueOnce(readA.promise)
      .mockResolvedValueOnce({ data: { reasoningMode: 'fast' } });
    mocks.patch.mockReturnValueOnce(saveA.promise);
    const view = render(<VNextMeriReasoningControl conversationId="thread-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning depth: Standard' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Deep/ }));
    view.rerender(<VNextMeriReasoningControl conversationId="thread-b" />);
    await screen.findByRole('button', { name: 'Reasoning depth: Fast' });
    await act(async () => {
      readA.resolve({ data: { reasoningMode: 'max' } });
      saveA.reject(new Error('offline'));
    });
    expect(screen.getByRole('button', { name: 'Reasoning depth: Fast' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('draft controls synchronize and isolate org, user and impersonation choices', async () => {
    const view = render(
      <>
        <div data-testid="first">
          <VNextMeriReasoningControl />
        </div>
        <div data-testid="second">
          <VNextMeriReasoningControl />
        </div>
      </>,
    );
    const first = within(screen.getByTestId('first'));
    fireEvent.click(first.getByRole('button', { name: 'Reasoning depth: Standard' }));
    fireEvent.click(first.getByRole('menuitemradio', { name: /Max/ }));
    expect(screen.getAllByRole('button', { name: 'Reasoning depth: Max' })).toHaveLength(2);
    expect(readDraftReasoningMode('another-org:another-user')).toBe('standard');
    mocks.actAsTenantSlug = 'other-tenant';
    view.rerender(<VNextMeriReasoningControl />);
    expect(screen.getByRole('button', { name: 'Reasoning depth: Standard' })).toBeTruthy();
    mocks.actAsTenantSlug = null;
    view.rerender(<VNextMeriReasoningControl />);
    expect(screen.getByRole('button', { name: 'Reasoning depth: Max' })).toBeTruthy();
  });

  test('an unreadable saved mode is disclosed and an explicit selection can recover', async () => {
    mocks.get.mockRejectedValueOnce(new Error('offline'));
    render(<VNextMeriReasoningControl conversationId="load-error" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning depth: Standard' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Standard/ }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        '/api/clio/v3/conversations/load-error/reasoning-mode',
        { reasoningMode: 'standard' },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
