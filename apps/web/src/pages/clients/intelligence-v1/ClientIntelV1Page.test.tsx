import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { ClientIntelV1Page } from './ClientIntelV1Page.js';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'tenant-1', userId: 'user-1' }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  Link: ({ children }: { children?: unknown }) => <a>{children as never}</a>,
}));

// Every query on the page goes through useApi().get; tests steer the
// profile-v1 aggregate call per-URL via this mock.
const getMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: vi.fn(), delete: vi.fn() }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <ClientIntelV1Page clientId="client-1" clientName="Acme Defense" />
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('ClientIntelV1Page aggregate loading gate', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  test('holds aggregate sections behind skeletons while profile-v1 is pending', () => {
    // All requests stay in flight — the cold-load window where the page used
    // to render the four sections with an undefined aggregate.
    getMock.mockImplementation(() => new Promise(() => {}));
    renderPage();

    expect(screen.getByText(/Compiling intelligence profile/i)).toBeTruthy();
    // No section anchors → no affirmatively false empty states such as
    // "No relevant bills yet" / "0 rules tracked" during the load window.
    expect(document.getElementById('snapshot')).toBeNull();
    expect(document.getElementById('legislative-regulatory')).toBeNull();
    expect(screen.queryByText(/No relevant bills yet/i)).toBeNull();
  });

  test('suppresses aggregate sections beneath the load-error alert', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/profile-v1')) return Promise.reject(new Error('boom'));
      return new Promise(() => {});
    });
    renderPage();

    // profileV1Query retries once (~1s backoff) before settling into error.
    expect(
      await screen.findByText(/Intelligence aggregate failed to load/i, undefined, {
        timeout: 10000,
      }),
    ).toBeTruthy();
    expect(document.getElementById('snapshot')).toBeNull();
    expect(screen.queryByText(/No relevant bills yet/i)).toBeNull();
    expect(screen.queryByText(/Compiling intelligence profile/i)).toBeNull();
  });
});
