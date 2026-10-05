import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const get = vi.fn(),
    post = vi.fn();
  return { get, post, api: { get, post } };
});
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
import { MANAGED_APP_IDS, ManagedMcpAppsProvider, useManagedMcpApps } from './managed-mcp-apps.js';

const disconnected = MANAGED_APP_IDS.map((id) => ({
  id,
  name: id,
  description: 'Read your data',
  status: 'disconnected',
  connected: false,
  available: true,
  needsReauth: false,
  lastError: null,
}));
function state(status: string, lastError: string | null = null) {
  return {
    data: {
      apps: disconnected.map((app) =>
        app.id === 'hubspot'
          ? { ...app, status, connected: status === 'connected', lastError }
          : app,
      ),
    },
  };
}
function Probe() {
  const value = useManagedMcpApps()!;
  return (
    <div>
      <span data-testid="status">{value.apps.find((app) => app.id === 'hubspot')?.status}</span>
      <span data-testid="count">{value.apps.length}</span>
      <span data-testid="error">{value.error}</span>
      <span data-testid="busy">{value.busyAppId}</span>
      <textarea aria-label="Draft" defaultValue="Keep this draft" />
      <button onClick={() => void value.connect('hubspot')}>Connect HubSpot</button>
      <button onClick={() => void value.disconnect('hubspot')}>Disconnect</button>
      <button onClick={() => void value.refresh()}>Refresh</button>
    </div>
  );
}
function popup() {
  return {
    document: { title: '', body: { textContent: '' } },
    location: { replace: vi.fn() },
    focus: vi.fn(),
    close: vi.fn(),
    closed: false,
  };
}
async function start() {
  const view = render(
    <ManagedMcpAppsProvider>
      <Probe />
    </ManagedMcpAppsProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent(String(MANAGED_APP_IDS.length)));
  return view;
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1250);
  });
}

describe('ManagedMcpAppsProvider', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.api = { get: mocks.get, post: mocks.post };
    mocks.get.mockResolvedValue(state('disconnected'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('opens sign-in synchronously and coalesces repeated clicks', async () => {
    let resolve!: (value: unknown) => void;
    mocks.post.mockImplementation(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    const win = popup();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    await start();
    fireEvent.click(screen.getByText('Connect HubSpot'));
    fireEvent.click(screen.getByText('Connect HubSpot'));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/api/clio/v3/apps/hubspot/connect', {});
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ data: { authUrl: null, alreadyConnected: true } });
    });
    expect(win.close).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Draft')).toHaveValue('Keep this draft');
  });

  test('reports blocked popups without starting an abandoned authorization', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await start();
    fireEvent.click(screen.getByText('Connect HubSpot'));
    expect(screen.getByTestId('error')).toHaveTextContent('Allow popups');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  test('navigates to OAuth and remains pending until the API confirms discovery', async () => {
    const win = popup();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    mocks.post.mockResolvedValue({ data: { authUrl: 'https://provider.example/authorize' } });
    await start();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByText('Connect HubSpot'));
    });
    expect(win.location.replace).toHaveBeenCalledWith('https://provider.example/authorize');
    mocks.get.mockResolvedValue(state('pending'));
    await tick();
    expect(win.close).not.toHaveBeenCalled();
    expect(screen.getByTestId('status')).toHaveTextContent('pending');
    mocks.get.mockResolvedValue(state('connected'));
    await tick();
    expect(win.close).toHaveBeenCalledOnce();
    expect(screen.getByTestId('status')).toHaveTextContent('connected');
  });

  test('preserves discovery errors through status refresh', async () => {
    const win = popup();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    mocks.post.mockResolvedValue({ data: { authUrl: 'https://provider.example/authorize' } });
    await start();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByText('Connect HubSpot'));
    });
    mocks.get.mockResolvedValue(state('error', 'Please try connecting again.'));
    await tick();
    expect(screen.getByTestId('error')).toHaveTextContent('Please try connecting again.');
    await act(async () => {
      fireEvent.click(screen.getByText('Refresh'));
    });
    expect(screen.getByTestId('error')).toHaveTextContent('Please try connecting again.');
    expect(win.close).toHaveBeenCalledOnce();
  });

  test('closing sign-in returns a recoverable error and preserves the draft', async () => {
    const win = popup();
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    mocks.post.mockResolvedValue({ data: { authUrl: 'https://provider.example/authorize' } });
    await start();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByText('Connect HubSpot'));
    });
    win.closed = true;
    await tick();
    await tick();
    expect(screen.getByTestId('error')).toHaveTextContent('closed before it finished');
    expect(screen.getByTestId('busy')).toBeEmptyDOMElement();
    expect(mocks.post).toHaveBeenCalledWith('/api/clio/v3/apps/hubspot/cancel', {});
    expect(screen.getByLabelText('Draft')).toHaveValue('Keep this draft');
  });

  test('a failed request remains visible after focus refresh', async () => {
    vi.spyOn(window, 'open').mockReturnValue(popup() as unknown as Window);
    mocks.post.mockRejectedValue(new Error('provider failed'));
    await start();
    fireEvent.click(screen.getByText('Connect HubSpot'));
    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('Could not complete'),
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByTestId('error')).toHaveTextContent('Could not complete');
  });

  test('changing Capiro identity immediately removes prior state and ignores a late response', async () => {
    mocks.get.mockResolvedValue(state('connected'));
    const view = await start();
    expect(screen.getByTestId('status')).toHaveTextContent('connected');
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    fireEvent.click(screen.getByText('Refresh'));
    mocks.api = { get: vi.fn().mockResolvedValue({ data: { apps: [] } }), post: mocks.post };
    view.rerender(
      <ManagedMcpAppsProvider>
        <Probe />
      </ManagedMcpAppsProvider>,
    );
    expect(screen.getByTestId('status')).toBeEmptyDOMElement();
    await act(async () => {
      resolve(state('connected'));
    });
    expect(screen.getByTestId('status')).toBeEmptyDOMElement();
  });

  test('disconnect refreshes persisted status and uses only the app id', async () => {
    mocks.get.mockResolvedValue(state('connected'));
    mocks.post.mockResolvedValue({ data: { disconnected: true } });
    await start();
    mocks.get.mockResolvedValue(state('disconnected'));
    fireEvent.click(screen.getByText('Disconnect'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('disconnected'));
    expect(mocks.post).toHaveBeenCalledWith('/api/clio/v3/apps/hubspot/disconnect', {});
  });
});
