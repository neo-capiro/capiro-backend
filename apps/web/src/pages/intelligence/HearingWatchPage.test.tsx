import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { HearingWatchPanel } from './HearingWatchPage.js';

/**
 * P8 web wiring: the New-Hearing modal's "Resolve stream" button + conditional
 * consent field. The intel feature flag + api client are mocked.
 */
const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock }),
}));

vi.mock('../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => true,
}));

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  Object.defineProperty(window, 'getComputedStyle', {
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <HearingWatchPanel />
      </AntApp>
    </QueryClientProvider>,
  );
}

async function openNewHearingModal() {
  const btn = await screen.findByRole('button', { name: /Add hearing manually/i });
  fireEvent.click(btn);
  await screen.findByText('Start a hearing session');
}

describe('HearingWatchPage — New Hearing modal (P8)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
    apiGetMock.mockResolvedValue({ data: [] });
  });

  test('Resolve stream prefills the source URL and shows provenance', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'resolved',
            media: {
              url: 'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036788/judiciary/x/master.m3u8',
              kind: 'hls',
              provider: 'senate-isvp',
            },
            note: 'via Senate ISVP (judiciary)',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, {
      target: { value: 'https://www.senate.gov/isvp/?comm=judiciary&filename=x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    await waitFor(() => expect(screen.getByText(/via Senate ISVP/i)).toBeInTheDocument());
    await waitFor(() => expect((urlInput as HTMLInputElement).value).toContain('master.m3u8'));
  }, 15000);

  test('consent field appears only for a private source type', async () => {
    renderPanel();
    await openNewHearingModal();

    // Default source type is "hearing" (public) → no consent field.
    expect(screen.queryByText("Confirm you're authorized to capture this session.")).toBeNull();

    // Switch source type to "Meeting" (private) via the antd Select.
    const selects = document.querySelectorAll('.ant-select-selector');
    // The first Select in the form is "Source type".
    fireEvent.mouseDown(selects[0]!);
    const option = await screen.findByText('Meeting', {
      selector: '.ant-select-item-option-content',
    });
    fireEvent.click(option);

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("Confirm you're authorized to capture this session."),
      ).toBeInTheDocument(),
    );
  }, 15000);

  test('unresolvable outcome shows the note + reference link (no silent no-op)', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'unresolvable',
            reference: 'https://www.c-span.org/search/?searchtype=Videos&query=armed+services',
            note: 'No direct stream resolved — search C-SPAN or paste the stream URL',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, { target: { value: 'https://www.congress.gov/event/x' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    // The note renders in the assisted-paste fallback…
    await waitFor(() => expect(screen.getByText(/No direct stream resolved/i)).toBeInTheDocument());
    // …and the reference link is offered (C-SPAN ↗).
    expect(screen.getByRole('link', { name: /C-SPAN/i })).toBeInTheDocument();
  }, 15000);

  test('empty-candidates is treated as unresolvable and still gives feedback', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'candidates',
            candidates: [],
            reference: 'https://www.c-span.org/search/?searchtype=Videos&query=x',
            note: 'No direct stream resolved — search C-SPAN or paste the stream URL',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, { target: { value: 'https://www.congress.gov/event/y' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    // No "Pick the matching video" (empty list) — instead the fallback note.
    await waitFor(() => expect(screen.getByText(/No direct stream resolved/i)).toBeInTheDocument());
    expect(screen.queryByText('Pick the matching video')).toBeNull();
  }, 15000);

  test('IP-bound resolved source is NOT autofilled into the URL field', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'resolved',
            media: {
              url: 'https://rr5---sn-abc.googlevideo.com/hls/live/expiring.m3u8',
              kind: 'hls',
              provider: 'youtube-live',
              ipBound: true,
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
            note: 'via YouTube live (IP-bound, short-lived — re-resolve at ingest)',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i) as HTMLInputElement;
    fireEvent.change(urlInput, {
      target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    // The provenance + "not saved" note appears…
    await waitFor(() => expect(screen.getByText(/Source found — not saved/i)).toBeInTheDocument());
    // …but the expiring googlevideo URL is NOT written into the field.
    expect(urlInput.value).not.toContain('googlevideo.com');
    expect(urlInput.value).not.toContain('expiring.m3u8');
  }, 15000);

  test('candidates outcome renders a pick-list', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'candidates',
            candidates: [
              {
                title: 'Armed Services Hearing',
                pageUrl: 'https://www.c-span.org/program/x/y/1',
                programId: '1',
              },
            ],
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, { target: { value: 'https://www.c-span.org/search/?query=x' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    await waitFor(() => expect(screen.getByText('Pick the matching video')).toBeInTheDocument());
    expect(screen.getByText('Armed Services Hearing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use/i })).toBeInTheDocument();
  }, 15000);
});
