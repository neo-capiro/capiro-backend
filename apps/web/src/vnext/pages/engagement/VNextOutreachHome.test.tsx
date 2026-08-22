import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VNextOutreachHome,
  outreachCampaignName,
  outreachCampaignStatusDetail,
} from './VNextOutreachHome.js';

/**
 * The Outreach home screen replaced two things: the builder mounting itself at
 * `/engagement/outreach` (which created an empty campaign on every visit) and
 * the collapsible "Campaigns" dropdown nested inside the builder.
 *
 * Its central honesty property: Draft vs Sent is read from the artifact-root
 * record status, never from `outreach_sessions.status` (which no code path ever
 * advances past 'active') and never from "the campaign reached the Send step".
 */
const { getCalls, postCalls, getResponse, api } = vi.hoisted(() => {
  const getCalls: Array<{ url: string; params?: unknown }> = [];
  const postCalls: Array<{ url: string; body?: unknown }> = [];
  const getResponse: { rows: unknown } = { rows: [] };
  const api = {
    get: vi.fn(async (url: string, config?: { params?: unknown }) => {
      getCalls.push({ url, params: config?.params });
      // The Templates library shares this same mocked client (Use a template
      // switches VNextOutreachHome to that view) — it has its own real shape
      // (capabilities, previewSummary, etc.), so route it to an empty list
      // rather than the session rows this file's other tests configure.
      if (url.includes('/templates')) return { data: [] };
      return { data: getResponse.rows };
    }),
    post: vi.fn(async (url: string, body?: unknown) => {
      postCalls.push({ url, body });
      return { data: { session: { id: 'created-session' } } };
    }),
  };
  return { getCalls, postCalls, getResponse, api };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    status: 'active',
    currentStateVersion: 2,
    title: 'New outreach campaign',
    updatedAt: '2026-08-17T12:00:00.000Z',
    topic: 'Ground robotics',
    goal: 'Brief the subcommittee',
    targetCount: 7,
    recordStatus: 'draft',
    sentAt: null,
    ...over,
  };
}

function renderHome(onOpenCampaign = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <VNextOutreachHome onOpenCampaign={onOpenCampaign} selectedClientId={null} />
    </QueryClientProvider>,
  );
  return { ...result, onOpenCampaign };
}

describe('VNextOutreachHome', () => {
  beforeEach(() => {
    getCalls.length = 0;
    postCalls.length = 0;
    getResponse.rows = [];
    api.get.mockClear();
    api.post.mockClear();
  });

  it('lists draft and sent campaigns from the real V3 sessions endpoint', async () => {
    getResponse.rows = [
      row({ id: 'draft-1', topic: 'Ground robotics', recordStatus: 'draft' }),
      row({
        id: 'sent-1',
        topic: 'FY27 mark-up',
        recordStatus: 'sent',
        sentAt: '2026-08-16T09:00:00.000Z',
      }),
    ];
    renderHome();

    await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());
    expect(screen.getByText('FY27 mark-up')).toBeInTheDocument();
    expect(screen.getByText('1 draft · 1 sent')).toBeInTheDocument();
    expect(
      getCalls.some(
        (call) =>
          call.url === '/api/engagement/outreach-v3/sessions?limit=100&includeArchived=true',
      ),
    ).toBe(true);
    // One request serves every filter, so clicking a filter can never flash a
    // loading skeleton over rows the client already has.
    expect(getCalls).toHaveLength(1);
  });

  it('does NOT create a campaign just because the screen was opened', async () => {
    getResponse.rows = [row()];
    renderHome();
    await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());
    expect(postCalls).toHaveLength(0);
  });

  it('creates a campaign only after New campaign -> Start from scratch, then opens the builder for it', async () => {
    getResponse.rows = [row()];
    const { onOpenCampaign } = renderHome();
    await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /New campaign/i })[0]!);
    // The truthful entry chooser (closeout runbook 7.1) — no session is
    // created until the operator explicitly picks a path.
    expect(postCalls).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Start from scratch/i }));
    await waitFor(() => expect(onOpenCampaign).toHaveBeenCalledWith('created-session'));
    expect(postCalls).toEqual([
      { url: '/api/engagement/outreach-v3/sessions', body: { title: 'New outreach campaign' } },
    ]);
  });

  it('New campaign -> Use a template switches to the Templates view without creating a session', async () => {
    getResponse.rows = [row()];
    renderHome();
    await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /New campaign/i })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /Use a template/i }));
    await waitFor(() => expect(screen.getByText('Start from an approved way of working')).toBeInTheDocument());
    expect(postCalls).toHaveLength(0);
  });

  it('opens the builder for an existing campaign row', async () => {
    getResponse.rows = [row({ id: 'session-42' })];
    const { onOpenCampaign } = renderHome();
    await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Open Ground robotics'));
    expect(onOpenCampaign).toHaveBeenCalledWith('session-42');
  });

  it('filters to Sent using the recorded send, not the session status', async () => {
    getResponse.rows = [
      // status 'completed' with no recorded send is still a draft: nothing in
      // the backend ever writes that status, and it is not a send either way.
      row({ id: 'a', topic: 'Never sent', status: 'completed', recordStatus: 'draft' }),
      row({
        id: 'b',
        topic: 'Really sent',
        recordStatus: 'sent',
        sentAt: '2026-08-16T09:00:00.000Z',
      }),
    ];
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByText('Really sent')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
    expect(screen.getByText('Really sent')).toBeInTheDocument();
    expect(screen.queryByText('Never sent')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    await waitFor(() => expect(screen.getByText('Never sent')).toBeInTheDocument());
    expect(screen.queryByText('Really sent')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.uui-outreach-home__row')).toHaveLength(1);
  });

  it('archives a campaign through the real archive endpoint', async () => {
    getResponse.rows = [row({ id: 'session-9' })];
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

    const rowEl = container.querySelector('.uui-outreach-home__row') as HTMLElement;
    fireEvent.click(within(rowEl).getByTitle('Archive Ground robotics'));
    await waitFor(() =>
      expect(postCalls).toEqual([
        { url: '/api/engagement/outreach-v3/sessions/session-9/archive', body: undefined },
      ]),
    );
  });

  it('offers a New campaign action from the empty state', async () => {
    getResponse.rows = [];
    const { onOpenCampaign } = renderHome();
    await waitFor(() => expect(screen.getByText('No campaigns yet')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /New campaign/i })[1]!);
    fireEvent.click(await screen.findByRole('button', { name: /Start from scratch/i }));
    await waitFor(() => expect(onOpenCampaign).toHaveBeenCalledWith('created-session'));
  });

  describe('row copy', () => {
    it('names a campaign by its spec topic, since every session title is identical', () => {
      expect(outreachCampaignName(row() as never)).toBe('Ground robotics');
      expect(outreachCampaignName(row({ topic: null }) as never)).toBe('New outreach campaign');
      expect(outreachCampaignName(row({ topic: null, title: null }) as never)).toBe(
        'Untitled campaign',
      );
    });

    it('never reports a partial or failed send as a clean send', () => {
      expect(outreachCampaignStatusDetail(row({ recordStatus: 'sent' }) as never)).toBe('Sent');
      expect(outreachCampaignStatusDetail(row({ recordStatus: 'partial' }) as never)).toBe(
        'Sent with failures',
      );
      expect(outreachCampaignStatusDetail(row({ recordStatus: 'failed' }) as never)).toBe(
        'Send failed',
      );
      expect(outreachCampaignStatusDetail(row({ recordStatus: 'draft' }) as never)).toBe(
        'In progress',
      );
    });
  });
});
