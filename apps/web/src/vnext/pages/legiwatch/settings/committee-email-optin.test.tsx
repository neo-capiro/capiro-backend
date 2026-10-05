/**
 * committee-follow alerts — LegiWatch Settings committee email opt-in.
 *
 * Covers the REAL contract (GET/PUT notification-preferences): default-off
 * rendering, toggle PUT, saved state from the server response, backend refusal
 * message surfaced verbatim, prefs GET failure + retry, and the pre-existing
 * per-client placeholder rows staying untouched.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
const apiPatch = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();
const apiPut = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();
const apiPost = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string) => apiGet(url),
    patch: (url: string, body: unknown) => apiPatch(url, body),
    put: (url: string, body: unknown) => apiPut(url, body),
    post: (url: string, body: unknown) => apiPost(url, body),
  }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 't', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
// The preferences hooks key their cache on the caller identity; without this
// mock the query stays disabled and the component never fetches.
vi.mock('../lib/saved-hearing-sessions.js', () => ({
  useHearingQueryIdentity: () => ({ identity: 'tenant-1:user-1', ready: true }),
}));

import { LegiWatchSettingsTab } from './LegiWatchSettingsTab.js';

const PREFS_PATH = '/api/legiwatch/live-hearings/notification-preferences';
let emailEnabled = false;

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: ['/legiwatch?tab=settings'] }, createElement(LegiWatchSettingsTab)),
    ),
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPut.mockReset();
  apiPost.mockReset();
  emailEnabled = false;
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/api/me')) {
      return Promise.resolve({ data: { user: { id: 'u-1', legiwatchPrefs: {} } } });
    }
    if (url === PREFS_PATH) {
      return Promise.resolve({
        data: { committeeEmailEnabled: emailEnabled, emailAddress: 'neo@capiro.ai' },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  apiPut.mockImplementation((url: string, body: unknown) => {
    if (url === PREFS_PATH) {
      emailEnabled = Boolean((body as { committeeEmailEnabled?: boolean }).committeeEmailEnabled);
      return Promise.resolve({
        data: { committeeEmailEnabled: emailEnabled, emailAddress: 'neo@capiro.ai' },
      });
    }
    return Promise.reject(new Error(`unexpected PUT ${url}`));
  });
  apiPatch.mockRejectedValue(new Error('unexpected PATCH'));
  apiPost.mockRejectedValue(new Error('unexpected POST'));
});

afterEach(() => cleanup());

describe('committee email opt-in (real GET/PUT contract)', () => {
  it('renders OFF by default with the account address shown', async () => {
    renderSettings();
    const row = await screen.findByLabelText('Committee email alerts');
    await waitFor(() =>
      expect(row.textContent).toContain('Off — alerts would go to neo@capiro.ai'),
    );
    expect(within(row).getByRole('button', { name: 'Turn on' })).toBeTruthy();
  });

  it('toggling on PUTs the contract and shows the server-persisted state', async () => {
    renderSettings();
    const row = await screen.findByLabelText('Committee email alerts');
    // Wait for the prefs query to resolve — clicking while the button is
    // still disabled (query loading) never issues the PUT.
    const btn = await within(row).findByRole('button', { name: 'Turn on' });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith(PREFS_PATH, { committeeEmailEnabled: true }));
    await screen.findByText('Saved');
    await waitFor(() =>
      expect(screen.getByLabelText('Committee email alerts').textContent).toContain(
        'On — alerts go to neo@capiro.ai',
      ),
    );
  });

  it('a backend refusal renders the server message verbatim and stays OFF', async () => {
    apiPut.mockImplementation((url: string) => {
      if (url === PREFS_PATH) {
        return Promise.reject({
          response: { data: { message: 'Your account has no valid email address.' } },
        });
      }
      return Promise.reject(new Error(`unexpected PUT ${url}`));
    });
    renderSettings();
    const row = await screen.findByLabelText('Committee email alerts');
    const btn = await within(row).findByRole('button', { name: 'Turn on' });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await screen.findByText('Your account has no valid email address.');
    // Server never persisted — the control stays Off.
    expect(screen.getByLabelText('Committee email alerts').textContent).toContain('Off');
  });

  it('a prefs GET failure shows a scoped error with retry and never claims "no email"', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/me')) {
        return Promise.resolve({ data: { user: { id: 'u-1', legiwatchPrefs: {} } } });
      }
      if (url === PREFS_PATH) return Promise.reject(new Error('boom'));
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderSettings();
    const row = await screen.findByLabelText('Committee email alerts');
    await waitFor(() =>
      expect(row.textContent).toContain('Your current preference could not be read'),
    );
    expect(row.textContent).not.toContain('no usable email address');
    expect(within(row).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('links lifecycle preferences to their per-hearing controls', async () => {
    renderSettings();
    // The Notifications card: aria-label is on the section, but anchor on the
    // heading to be resilient to label/query differences.
    const heading = await screen.findByRole('heading', { name: 'Notifications' });
    const notifications = heading.closest('section')!;
    expect(notifications.textContent).toMatch(/In-app · set per followed hearing/);
    expect(within(notifications as HTMLElement).getByRole('button', { name: 'Manage followed hearings' })).toBeTruthy();
    // The opt-in is a button, not a checkbox — zero checkboxes remain.
    expect(within(notifications as HTMLElement).queryAllByRole('checkbox').length).toBe(0);
  });
});
