import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  resetChatStoreForTests,
  setActiveConversation,
  setConversations,
  useChatStore,
} from './chat-store.js';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  fetch: vi.fn(),
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mocks.getToken }),
}));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));

import { MeriWorkspaceThreadRail } from './MeriWorkspaceThreadRail.js';

function Probe() {
  const state = useChatStore();
  return <div data-testid="active-id">{state.activeConversationId ?? ''}</div>;
}

describe('MeriWorkspaceThreadRail', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    mocks.fetch.mockReset();
    global.fetch = mocks.fetch as typeof fetch;
  });

  test('groups real conversations chronologically and filters by title', async () => {
    const today = new Date().toISOString();
    const earlier = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: 'today-1',
            title: 'Protect the emitter add',
            clientId: 'c1',
            client: { id: 'c1', name: 'Kestrel Dynamics' },
            latestMessage: null,
            updatedAt: today,
          },
          {
            id: 'old-1',
            title: 'Conference outlook',
            clientId: null,
            client: null,
            latestMessage: null,
            updatedAt: earlier,
          },
        ]),
        { status: 200 },
      ),
    );

    render(<MeriWorkspaceThreadRail />);
    await screen.findByText('Protect the emitter add');
    expect(screen.getByText('TODAY')).toBeTruthy();
    expect(screen.getByText('EARLIER')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search threads'), {
      target: { value: 'conference' },
    });
    expect(screen.queryByText('Protect the emitter add')).toBeNull();
    expect(screen.getByText('Conference outlook')).toBeTruthy();
  });

  test('hydrates the selected thread into the shared chat store', async () => {
    const now = new Date().toISOString();
    setConversations([
      {
        id: 'conv-1',
        title: 'Kestrel brief',
        clientId: 'c1',
        client: { id: 'c1', name: 'Kestrel Dynamics' },
        latestMessage: null,
        updatedAt: now,
      },
    ]);
    setActiveConversation(null);

    mocks.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'conv-1',
              title: 'Kestrel brief',
              clientId: 'c1',
              client: { id: 'c1', name: 'Kestrel Dynamics' },
              latestMessage: null,
              updatedAt: now,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'm1',
              role: 'user',
              body: 'What changed?',
              createdAt: now,
              metadata: {},
              artifacts: [],
            },
          ]),
          { status: 200 },
        ),
      );

    render(
      <>
        <MeriWorkspaceThreadRail />
        <Probe />
      </>,
    );

    const thread = await screen.findByRole('button', { name: /Kestrel brief/i });
    fireEvent.click(thread);

    await waitFor(() => expect(screen.getByTestId('active-id')).toHaveTextContent('conv-1'));
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.test/api/clio/conversations/conv-1/messages',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    );
  });
});
