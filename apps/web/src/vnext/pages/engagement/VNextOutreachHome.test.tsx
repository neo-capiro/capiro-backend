import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VNextOutreachHome,
  outreachCampaignName,
  outreachCampaignPill,
  outreachCampaignStatusDetail,
  outreachCampaignWhen,
} from './VNextOutreachHome.js';

/**
 * The Outreach home screen replaced two things: the builder mounting itself at
 * `/engagement/outreach` (which created an empty campaign on every visit) and
 * the collapsible "Campaigns" dropdown nested inside the builder.
 *
 * Its central honesty property: Draft vs Sent is read from the artifact-root
 * record status, never from `outreach_sessions.status` (which no code path ever
 * advances past 'active') and never from "the campaign reached the Send step".
 *
 * Every string asserted below is the Engagement V2 prototype's, character for
 * character — including the typographic apostrophes in the chooser tiles and
 * the empty state's "delivery", a step the built wizard does not have.
 */
const { getCalls, postCalls, getResponse, api } = vi.hoisted(() => {
  const getCalls: Array<{ url: string; params?: unknown }> = [];
  const postCalls: Array<{ url: string; body?: unknown }> = [];
  const getResponse: { rows: unknown } = { rows: [] };
  const api = {
    get: vi.fn(async (url: string, config?: { params?: unknown }) => {
      getCalls.push({ url, params: config?.params });
      // The Templates library shares this same mocked client (the segmented
      // nav switches VNextOutreachHome to that view) — it has its own real
      // shape (capabilities, previewSummary, etc.), so route it to an empty
      // list rather than the session rows this file's other tests configure.
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

function rowEls(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('.ochome__row'));
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

  describe('header copy', () => {
    it('renders the mono eyebrow and the prototype count line, with no headline or blurb', async () => {
      getResponse.rows = [
        row({ id: 'a', recordStatus: 'draft' }),
        row({ id: 'b', recordStatus: 'draft' }),
        row({ id: 'c', recordStatus: 'sent', sentAt: '2026-08-16T09:00:00.000Z' }),
        row({ id: 'd', recordStatus: 'partial', sentAt: '2026-08-16T09:00:00.000Z' }),
        row({ id: 'e', status: 'archived', recordStatus: 'sent' }),
      ];
      const { container } = renderHome();

      // Counted across the whole library, not the active filter — "All" is
      // showing four rows while the line reports five campaigns.
      await waitFor(() =>
        expect(screen.getByText('2 draft · 2 sent · 1 archived')).toBeInTheDocument(),
      );
      expect(container.querySelector('.ocb-eyebrow')?.textContent).toBe('Campaigns');
      expect(container.querySelector('h2')).toBeNull();
      expect(rowEls(container)).toHaveLength(4);
    });

    it('omits the archived clause entirely at zero archived', async () => {
      getResponse.rows = [
        row({ id: 'a', recordStatus: 'draft' }),
        row({ id: 'c', recordStatus: 'sent', sentAt: '2026-08-16T09:00:00.000Z' }),
      ];
      renderHome();
      await waitFor(() => expect(screen.getByText('1 draft · 1 sent')).toBeInTheDocument());
    });
  });

  describe('segmented nav', () => {
    it('switches between Campaigns and Templates and reports which is pressed', async () => {
      getResponse.rows = [row()];
      renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      const nav = screen.getByRole('navigation', { name: 'Outreach library' });
      const campaigns = within(nav).getByRole('button', { name: 'Campaigns' });
      const templates = within(nav).getByRole('button', { name: 'Templates' });
      expect(campaigns).toHaveAttribute('aria-pressed', 'true');
      expect(templates).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(templates);
      await waitFor(() =>
        expect(screen.getByText('Start from an approved way of working')).toBeInTheDocument(),
      );
      expect(within(nav).getByRole('button', { name: 'Templates' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.queryByText('Ground robotics')).not.toBeInTheDocument();

      fireEvent.click(within(nav).getByRole('button', { name: 'Campaigns' }));
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());
    });
  });

  describe('filters', () => {
    beforeEach(() => {
      getResponse.rows = [
        row({ id: 'd1', topic: 'Still drafting', recordStatus: 'draft' }),
        row({
          id: 's1',
          topic: 'Really sent',
          recordStatus: 'sent',
          sentAt: '2026-08-16T09:00:00.000Z',
        }),
        row({ id: 'a1', topic: 'Long gone', status: 'archived', recordStatus: 'sent' }),
      ];
    });

    it('defaults to All, which is everything except archived', async () => {
      renderHome();
      await waitFor(() => expect(screen.getByText('Still drafting')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Really sent')).toBeInTheDocument();
      expect(screen.queryByText('Long gone')).not.toBeInTheDocument();
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
      expect(rowEls(container)).toHaveLength(1);
    });

    it('reaches archived campaigns only through the Archived chip', async () => {
      const { container } = renderHome();
      await waitFor(() => expect(screen.getByText('Still drafting')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
      await waitFor(() => expect(screen.getByText('Long gone')).toBeInTheDocument());
      const rows = rowEls(container);
      expect(rows).toHaveLength(1);
      const archived = rows[0]!;
      // Dimmed, pill reads Archived even though the record says sent, and the
      // one-way Archive action is gone.
      expect(archived).toHaveAttribute('data-archived');
      expect(archived.querySelector('.eng-pill')?.textContent).toBe('Archived');
      expect(within(archived).queryByRole('button', { name: /^Archive / })).toBeNull();
    });
  });

  describe('table', () => {
    it('renders the six prototype columns with values from the real session summary', async () => {
      getResponse.rows = [
        row({
          id: 'session-42',
          topic: 'Ground robotics',
          goal: 'Brief the subcommittee',
          targetCount: 7,
          updatedAt: '2026-08-21T12:00:00.000Z',
          recordStatus: 'draft',
          sentAt: null,
        }),
      ];
      const { container } = renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      const head = container.querySelector('.ochome__head');
      expect(Array.from(head?.children ?? []).map((cell) => cell.textContent)).toEqual([
        'Status',
        'Campaign',
        'Targets',
        'Last updated',
        'Sent',
        '',
      ]);

      const cells = rowEls(container)[0]!;
      expect(cells.querySelector('.eng-pill')?.textContent).toBe('Draft');
      expect(cells.querySelector('.ochome__goal')?.textContent).toBe('Brief the subcommittee');
      // The real target count, not a formatted or suffixed one.
      expect(cells.querySelector('.ochome__count')?.textContent).toBe('7');
      const when = cells.querySelectorAll('.ochome__when');
      expect(when[0]?.textContent).toBe('Aug 21');
      // No recorded send, so an em dash — never a guessed date.
      expect(when[1]?.textContent).toBe('—');
    });

    it('names a partial send on the row rather than letting the goal read clean', async () => {
      getResponse.rows = [
        row({
          id: 'p',
          topic: 'Committee print follow-up',
          goal: 'Follow up after the print',
          recordStatus: 'partial',
          sentAt: '2026-08-10T09:00:00.000Z',
        }),
      ];
      const { container } = renderHome();
      await waitFor(() =>
        expect(screen.getByText('Committee print follow-up')).toBeInTheDocument(),
      );
      expect(rowEls(container)[0]!.querySelector('.eng-pill')?.textContent).toBe('Partial');
      expect(screen.getByText('Sent with failures · Follow up after the print')).toBeInTheDocument();
    });

    it('opens the builder from the campaign name, and only from it', async () => {
      getResponse.rows = [row({ id: 'session-42' })];
      const { container, onOpenCampaign } = renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      const rowEl = rowEls(container)[0]!;
      // The row itself is not a click target — the pill and the meta cells are
      // plain text, so Archive stays reachable beside them.
      expect(within(rowEl).getAllByRole('button')).toHaveLength(2);
      fireEvent.click(within(rowEl).getByRole('button', { name: /^Ground robotics/ }));
      expect(onOpenCampaign).toHaveBeenCalledWith('session-42');
    });

    it('archives a campaign through the real archive endpoint', async () => {
      getResponse.rows = [row({ id: 'session-9' })];
      const { container } = renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      const rowEl = rowEls(container)[0]!;
      const archiveButton = within(rowEl).getByRole('button', { name: 'Archive Ground robotics' });
      expect(archiveButton).toHaveTextContent('Archive');
      fireEvent.click(archiveButton);
      // Disabled while in flight rather than dimmed-but-clickable.
      expect(archiveButton).toBeDisabled();
      await waitFor(() =>
        expect(postCalls).toEqual([
          { url: '/api/engagement/outreach-v3/sessions/session-9/archive', body: undefined },
        ]),
      );
    });
  });

  describe('empty state', () => {
    it('renders the prototype heading, body and 36px New campaign', async () => {
      getResponse.rows = [];
      const { container } = renderHome();

      await waitFor(() =>
        expect(screen.getByText('No campaigns in this view')).toBeInTheDocument(),
      );
      expect(
        screen.getByText(
          'Start a governed campaign: goal, targets, delivery, context, immutable drafts, preflight, send.',
        ),
      ).toBeInTheDocument();
      expect(container.querySelector('.ochome__table')).toBeNull();
      // The filter chips stay above the empty card — the card replaces the
      // table, not the whole view.
      expect(screen.getByRole('button', { name: 'Archived' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /New campaign/ })).toHaveLength(2);
    });

    it('shows the same empty card when a filter has no rows, not a per-filter variant', async () => {
      getResponse.rows = [row({ id: 'd1', recordStatus: 'draft' })];
      renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
      expect(screen.getByText('No campaigns in this view')).toBeInTheDocument();
    });
  });

  describe('start-a-campaign chooser', () => {
    it('does NOT create a campaign just because the screen was opened', async () => {
      getResponse.rows = [row()];
      renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());
      expect(postCalls).toHaveLength(0);
    });

    it('offers both prototype tiles verbatim and creates nothing until one is picked', async () => {
      getResponse.rows = [row()];
      renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      fireEvent.click(screen.getAllByRole('button', { name: /New campaign/ })[0]!);
      expect(await screen.findByText('How would you like to start?')).toBeInTheDocument();
      expect(screen.getByText('Start a campaign')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Your firm’s own custom template. Strategy and guardrails carry over; recipients, context and approvals are always fresh.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText('Capiro’s own campaign structures, maintained for you.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(postCalls).toHaveLength(0);
    });

    it('creates a real session from Firm Template and carries the provenance label', async () => {
      getResponse.rows = [row()];
      const { onOpenCampaign } = renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      fireEvent.click(screen.getAllByRole('button', { name: /New campaign/ })[0]!);
      fireEvent.click(await screen.findByRole('button', { name: /Firm Template/ }));
      await waitFor(() =>
        expect(onOpenCampaign).toHaveBeenCalledWith('created-session', 'Firm Template'),
      );
      expect(postCalls).toEqual([
        { url: '/api/engagement/outreach-v3/sessions', body: { title: 'New outreach campaign' } },
      ]);
    });

    it('creates a real session from Capiro Template too — the tile is never a dead control', async () => {
      getResponse.rows = [row()];
      const { onOpenCampaign } = renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      fireEvent.click(screen.getAllByRole('button', { name: /New campaign/ })[0]!);
      fireEvent.click(await screen.findByRole('button', { name: /Capiro Template/ }));
      await waitFor(() =>
        expect(onOpenCampaign).toHaveBeenCalledWith('created-session', 'Capiro Template'),
      );
      expect(postCalls).toEqual([
        { url: '/api/engagement/outreach-v3/sessions', body: { title: 'New outreach campaign' } },
      ]);
    });

    it('opens from the empty state as well', async () => {
      getResponse.rows = [];
      const { onOpenCampaign } = renderHome();
      await waitFor(() =>
        expect(screen.getByText('No campaigns in this view')).toBeInTheDocument(),
      );

      fireEvent.click(screen.getAllByRole('button', { name: /New campaign/ })[1]!);
      fireEvent.click(await screen.findByRole('button', { name: /Firm Template/ }));
      await waitFor(() =>
        expect(onOpenCampaign).toHaveBeenCalledWith('created-session', 'Firm Template'),
      );
    });

    it('closes on Cancel without creating anything', async () => {
      getResponse.rows = [row()];
      renderHome();
      await waitFor(() => expect(screen.getByText('Ground robotics')).toBeInTheDocument());

      fireEvent.click(screen.getAllByRole('button', { name: /New campaign/ })[0]!);
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(screen.queryByText('How would you like to start?')).not.toBeInTheDocument(),
      );
      expect(postCalls).toHaveLength(0);
    });
  });

  describe('failure states the prototype has no equivalent for', () => {
    it('surfaces a list failure with a retry instead of an empty table', async () => {
      api.get.mockImplementationOnce(async () => {
        throw new Error('boom');
      });
      const { container } = renderHome();

      await waitFor(() =>
        expect(screen.getByText('Your campaigns could not be loaded')).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(container.querySelector('.ochome__table')).toBeNull();
      // Not the empty card either — an unread list is not an empty one.
      expect(screen.queryByText('No campaigns in this view')).toBeNull();
    });
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

    it('resolves all five pill labels, archived winning over the record status', () => {
      expect(outreachCampaignPill(row({ recordStatus: 'draft' }) as never)).toEqual({
        label: 'Draft',
        tone: 'eng-pill--gray',
      });
      expect(outreachCampaignPill(row({ recordStatus: 'sent' }) as never)).toEqual({
        label: 'Sent',
        tone: 'eng-pill--navy',
      });
      expect(outreachCampaignPill(row({ recordStatus: 'partial' }) as never)).toEqual({
        label: 'Partial',
        tone: 'eng-pill--warn',
      });
      expect(outreachCampaignPill(row({ recordStatus: 'failed' }) as never)).toEqual({
        label: 'Failed',
        tone: 'eng-pill--err',
      });
      expect(
        outreachCampaignPill(row({ status: 'archived', recordStatus: 'sent' }) as never),
      ).toEqual({ label: 'Archived', tone: 'eng-pill--gray' });
    });

    it('formats dates as month and day, and refuses to invent one', () => {
      expect(outreachCampaignWhen('2026-08-21T12:00:00.000Z')).toBe('Aug 21');
      expect(outreachCampaignWhen(null)).toBe('—');
      expect(outreachCampaignWhen(undefined)).toBe('—');
      expect(outreachCampaignWhen('not a date')).toBe('—');
    });
  });
});
