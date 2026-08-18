import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TargetDirectoryBrowser } from './TargetDirectoryBrowser.js';
import type { OutreachV3ResolvedTargetRef } from './contracts.js';

/**
 * The Directory tab's whole point is V2 parity: it must read
 * GET /api/directory/contacts with V2's parameters (no query, pageSize 50,
 * sort name-asc) so the full directory is reachable A–Z with staffers nested,
 * rather than the previous ~20-row score-ranked capability blend.
 *
 * Selection stays governed: a row adds a bare `{ source, id }` locator through
 * ADD_TARGET_REFS, which the backend re-resolves. The directory locator schemas
 * are `.strict()`, so sending any display field would be rejected.
 */
const { calls, state, api } = vi.hoisted(() => {
  const calls: Array<{ method: string; url: string; params?: unknown }> = [];
  const state: { contacts: unknown[]; favorites: unknown[]; total: number } = {
    contacts: [],
    favorites: [],
    total: 0,
  };
  const api = {
    get: vi.fn(async (url: string, config?: { params?: unknown }) => {
      calls.push({ method: 'get', url, params: config?.params });
      if (url === '/api/directory/favorites') return { data: state.favorites };
      return {
        data: {
          sourceId: 'snapshot-1',
          contacts: state.contacts,
          total: state.total,
          page: 1,
          pageSize: 50,
          totals: { all: state.total, house: 0, senate: 0, governors: 0, staff: 0 },
          availableStates: ['CA', 'TX'],
          availableFilters: { chambers: ['House', 'Senate'], committees: [] },
        },
      };
    }),
    post: vi.fn(async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, params: body });
      return { data: {} };
    }),
    delete: vi.fn(async (url: string) => {
      calls.push({ method: 'delete', url });
      return { data: {} };
    }),
  };
  return { calls, state, api };
});

vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));

function member(over: Record<string, unknown> = {}) {
  return {
    id: 'member-101',
    memberId: 101,
    fullName: 'Rep. Ada Byron',
    memberName: 'Byron',
    title: 'Representative',
    office: 'House Armed Services',
    chamber: 'House',
    state: 'CA',
    district: '12',
    partyName: 'Democrat',
    committees: ['Armed Services'],
    focusAreas: [],
    leadershipPositions: [],
    addresses: [],
    staff: [
      {
        id: 'staff-9001',
        fullName: 'Grace Hopper',
        title: 'Legislative Director',
        roles: [],
        issueAreas: ['Defense'],
        email: 'grace@example.gov',
        phone: '',
        officeLocation: '',
      },
    ],
    ...over,
  };
}

function renderBrowser(
  selected: OutreachV3ResolvedTargetRef[] = [],
  applyCommands = vi.fn(async () => undefined),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <TargetDirectoryBrowser
        selected={selected}
        busy={false}
        applyCommands={applyCommands}
        onProfile={() => undefined}
      />
    </QueryClientProvider>,
  );
  return { ...result, applyCommands };
}

describe('TargetDirectoryBrowser', () => {
  beforeEach(() => {
    calls.length = 0;
    state.contacts = [];
    state.favorites = [];
    state.total = 0;
    api.get.mockClear();
    api.post.mockClear();
    api.delete.mockClear();
  });

  it('reads the whole Directory A–Z with V2 parameters, with no query typed', async () => {
    state.contacts = [member()];
    state.total = 538;
    renderBrowser();

    await waitFor(() => expect(screen.getByText('Rep. Ada Byron')).toBeInTheDocument());
    const contactsCall = calls.find((call) => call.url === '/api/directory/contacts');
    expect(contactsCall?.params).toEqual({
      q: undefined,
      state: undefined,
      chamber: undefined,
      page: 1,
      pageSize: 50,
      // Omitting `sort` makes the backend default to 'recent' (lastTouchpoint),
      // which reads as arbitrary ordering rather than a browsable directory.
      sort: 'name-asc',
    });
    expect(screen.getByText('1–50 of 538 offices')).toBeInTheDocument();
  });

  it('adds a member with a bare governed locator — no display fields', async () => {
    state.contacts = [member()];
    state.total = 1;
    const { applyCommands, container } = renderBrowser();
    await waitFor(() => expect(screen.getByText('Rep. Ada Byron')).toBeInTheDocument());

    const row = container.querySelector('.ov3-dir__row') as HTMLElement;
    fireEvent.click(within(row).getByLabelText('Add to this campaign'));

    expect(applyCommands).toHaveBeenCalledWith([
      {
        type: 'ADD_TARGET_REFS',
        schemaVersion: 1,
        payload: { refs: [{ source: 'directory_member', id: 'member-101' }] },
      },
    ]);
  });

  it('exposes staffers under their office and adds them as directory_staff', async () => {
    state.contacts = [member()];
    state.total = 1;
    const { applyCommands } = renderBrowser();
    await waitFor(() => expect(screen.getByText('Rep. Ada Byron')).toBeInTheDocument());

    // Collapsed by default, exactly like V2.
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Expand staffers'));
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();

    const staffRow = screen.getByText('Grace Hopper').closest('.ov3-dir__row') as HTMLElement;
    fireEvent.click(within(staffRow).getByLabelText('Add to this campaign'));
    expect(applyCommands).toHaveBeenCalledWith([
      {
        type: 'ADD_TARGET_REFS',
        schemaVersion: 1,
        payload: { refs: [{ source: 'directory_staff', id: 'staff-9001' }] },
      },
    ]);
  });

  it('shows an already-selected row as added and removes it by target key', async () => {
    state.contacts = [member()];
    state.total = 1;
    const selected = [
      {
        targetKey: 'otgt_member_101',
        locator: { source: 'directory_member', id: 'member-101' },
        displayName: 'Rep. Ada Byron',
      },
    ] as unknown as OutreachV3ResolvedTargetRef[];
    const { applyCommands } = renderBrowser(selected);
    await waitFor(() => expect(screen.getByText('Rep. Ada Byron')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Added — click to remove'));
    expect(applyCommands).toHaveBeenCalledWith([
      {
        type: 'REMOVE_TARGET_REFS',
        schemaVersion: 1,
        payload: { targetKeys: ['otgt_member_101'] },
      },
    ]);
  });

  it('passes state and chamber filters to the server and resets the page', async () => {
    state.contacts = [member()];
    state.total = 200;
    renderBrowser();
    await waitFor(() => expect(screen.getByText('Rep. Ada Byron')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/directory/contacts' &&
            (call.params as { page?: number } | undefined)?.page === 2,
        ),
      ).toBe(true),
    );

    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'TX' } });
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/directory/contacts' &&
            (call.params as { state?: string; page?: number } | undefined)?.state === 'TX' &&
            (call.params as { page?: number } | undefined)?.page === 1,
        ),
      ).toBe(true),
    );
  });

  it('counts only directory favorites, not namespaced client-contact ones', async () => {
    state.contacts = [member()];
    state.total = 1;
    state.favorites = [
      { directoryContactId: 'member-101', directoryContactName: 'Rep. Ada Byron' },
      { directoryContactId: 'clientperson:abc', directoryContactName: 'Someone Else' },
    ];
    renderBrowser();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Favorites \(1\)/ })).toBeInTheDocument(),
    );
  });
});
