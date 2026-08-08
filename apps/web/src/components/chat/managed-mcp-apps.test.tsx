import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post }),
}));

import { ManagedMcpAppsProvider, useManagedMcpApps } from './managed-mcp-apps.js';

const disconnected = [
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'CRM',
    status: 'disconnected',
    connected: false,
    available: true,
    needsReauth: false,
    lastError: null,
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Tables',
    status: 'disconnected',
    connected: false,
    available: true,
    needsReauth: false,
    lastError: null,
  },
] as const;

function Probe() {
  const apps = useManagedMcpApps()!;
  return (
    <div>
      <span data-testid="status">{apps.apps.find((app) => app.id === 'hubspot')?.status}</span>
      <button type="button" onClick={() => void apps.connect('hubspot')}>
        Connect HubSpot
      </button>
    </div>
  );
}

describe('ManagedMcpAppsProvider', () => {
  const originalOpen = window.open;

  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.get.mockResolvedValue({ data: { apps: disconnected } });
  });

  afterEach(() => {
    window.open = originalOpen;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('opens a blank sign-in window synchronously before waiting for the API', async () => {
    let resolvePost: ((value: unknown) => void) | undefined;
    mocks.post.mockImplementation(
      () => new Promise((resolve) => {
        resolvePost = resolve;
      }),
    );
    const close = vi.fn();
    const popup = {
      document: { title: '', body: { innerHTML: '' } },
      location: { replace: vi.fn() },
      focus: vi.fn(),
      close,
      closed: false,
    } as unknown as Window;
    window.open = vi.fn(() => popup);

    render(
      <ManagedMcpAppsProvider>
        <Probe />
      </ManagedMcpAppsProvider>,
    );
    await screen.findByTestId('status');
    fireEvent.click(screen.getByRole('button', { name: 'Connect HubSpot' }));

    expect(window.open).toHaveBeenCalledWith(
      'about:blank',
      'capiro-meri-connect-hubspot',
      expect.stringContaining('popup=yes'),
    );
    expect(mocks.post).toHaveBeenCalledWith('/api/clio/v3/apps/hubspot/connect', {});

    resolvePost?.({ data: { authUrl: null, alreadyConnected: true } });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  test('navigates to provider OAuth and closes after the API reports connected', async () => {
    vi.useFakeTimers();
    let getCount = 0;
    mocks.get.mockImplementation(async () => {
      getCount += 1;
      return {
        data: {
          apps:
            getCount >= 2
              ? disconnected.map((app) =>
                  app.id === 'hubspot'
                    ? { ...app, status: 'connected', connected: true }
                    : app,
                )
              : disconnected,
        },
      };
    });
    mocks.post.mockResolvedValue({
      data: { authUrl: 'https://hubspot.example/authorize', alreadyConnected: false },
    });
    const replace = vi.fn();
    const close = vi.fn();
    const popup = {
      document: { title: '', body: { innerHTML: '' } },
      location: { replace },
      focus: vi.fn(),
      close,
      closed: false,
    } as unknown as Window;
    window.open = vi.fn(() => popup);

    render(
      <ManagedMcpAppsProvider>
        <Probe />
      </ManagedMcpAppsProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect HubSpot' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replace).toHaveBeenCalledWith('https://hubspot.example/authorize');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status').textContent).toBe('connected');
  });
});
