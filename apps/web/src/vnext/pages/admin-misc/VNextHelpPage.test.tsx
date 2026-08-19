/**
 * VNextHelpPage — behavior tests (the canonical HelpPage had none; these
 * assert the ported contract: GET /api/help/content on the ['help-content']
 * key, client-side search filtering, the video modal, guide new-tab behavior,
 * and the unavailable-item state).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VNextHelpPage } from './VNextHelpPage.js';

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

const CONTENT = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description: 'The basics.',
    items: [
      {
        id: 'v1',
        title: 'Tour the dashboard',
        description: 'A two-minute walkthrough.',
        type: 'video',
        durationLabel: '2:04',
        url: 'https://cdn.example/v1.mp4',
        thumbnailUrl: null,
      },
      {
        id: 'g1',
        title: 'Set up your team',
        description: 'Invite teammates and assign roles.',
        type: 'guide',
        url: 'https://docs.example/team',
        thumbnailUrl: null,
      },
      {
        id: 'g2',
        title: 'Coming soon guide',
        description: 'Not published yet.',
        type: 'guide',
        url: null,
        thumbnailUrl: null,
      },
    ],
  },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VNextHelpPage />
    </QueryClientProvider>,
  );
}

describe('VNextHelpPage', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ data: CONTENT });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders categories and items from GET /api/help/content', async () => {
    renderPage();

    expect(await screen.findByText('Getting started')).toBeInTheDocument();
    expect(screen.getByText('Tour the dashboard')).toBeInTheDocument();
    expect(screen.getByText('Set up your team')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/help/content');
    // Type badges.
    expect(screen.getByText('Video')).toBeInTheDocument();
    expect(screen.getAllByText('Guide').length).toBe(2);
    // The unpublished item is disabled and marked unavailable.
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Coming soon guide/ })).toBeDisabled();
  });

  test('search filters items across categories', async () => {
    renderPage();
    await screen.findByText('Tour the dashboard');

    fireEvent.change(screen.getByLabelText('Search help content'), {
      target: { value: 'teammates' },
    });

    expect(screen.getByText('Set up your team')).toBeInTheDocument();
    expect(screen.queryByText('Tour the dashboard')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search help content'), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText('No matching help content')).toBeInTheDocument();
  });

  test('clicking a video opens the player modal; a guide opens in a new tab', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderPage();
    await screen.findByText('Tour the dashboard');

    fireEvent.click(screen.getByRole('button', { name: /Tour the dashboard/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Tour the dashboard' });
    expect(dialog.querySelector('video')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Set up your team/ }));
    expect(openSpy).toHaveBeenCalledWith(
      'https://docs.example/team',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('honest empty and error states', async () => {
    apiGetMock.mockResolvedValueOnce({ data: [] });
    renderPage();
    expect(await screen.findByText('No help content yet')).toBeInTheDocument();
  });

  test('error state surfaces the message with a retry affordance', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText("Couldn't load help content")).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
