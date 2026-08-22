import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutreachV3ResolvedTargetRef } from '../../../pages/engagement/outreach/v3/contracts.js';
import { SavedTargetListsPanel } from './outreach-v3-saved-target-lists.js';

const { api, calls } = vi.hoisted(() => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const api = {
    get: vi.fn(async (url: string) => {
      calls.push({ method: 'get', url });
      return {
        data: [
          {
            id: 'audience-1',
            kind: 'list',
            name: 'Defense Approps subcommittee',
            members: [
              {
                id: 'member-1',
                source: 'congress',
                sourceRefId: 'directory-9',
                name: 'Rep. Jamie Diaz',
                email: 'jamie@example.gov',
                title: 'Member',
                office: 'Office of Rep. Diaz',
              },
            ],
          },
          {
            id: 'audience-2',
            kind: 'group',
            name: 'A coalition group (not a list)',
            members: [],
          },
        ],
      };
    }),
    post: vi.fn(async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: { id: 'audience-new', kind: 'list', name: 'New list', members: [] } };
    }),
  };
  return { api, calls };
});
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

const targetA: OutreachV3ResolvedTargetRef = {
  targetKey: 'directory_member:a',
  locator: { source: 'directory_member', id: 'a' },
  displayName: 'Jordan Smith',
  title: 'Legislative Director',
  organization: 'Office of Representative Example',
  email: 'jordan@example.gov',
  clientId: null,
  roleStatus: 'current',
  snapshotHash: 'hash-a',
  jurisdiction: {
    governmentLevel: 'federal',
    chamber: 'house',
    state: 'VA',
    district: '01',
    committees: [],
    issueAreas: [],
  },
};

const targetNoEmail: OutreachV3ResolvedTargetRef = {
  ...targetA,
  targetKey: 'directory_member:b',
  locator: { source: 'directory_member', id: 'b' },
  displayName: 'Casey Doe',
  email: null,
};

function renderPanel(props: Partial<Parameters<typeof SavedTargetListsPanel>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onAddLocators = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SavedTargetListsPanel selected={[targetA]} busy={false} onAddLocators={onAddLocators} {...props} />
    </QueryClientProvider>,
  );
  return { onAddLocators };
}

describe('SavedTargetListsPanel', () => {
  it('loads only the list-kind saved audiences and adds every member as a target locator', async () => {
    const { onAddLocators } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /load a saved list/i }));

    expect(await screen.findByText('Defense Approps subcommittee')).toBeInTheDocument();
    expect(screen.queryByText('A coalition group (not a list)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add all/i }));

    expect(onAddLocators).toHaveBeenCalledTimes(1);
    const locators = onAddLocators.mock.calls[0]![0];
    expect(locators).toHaveLength(1);
    expect(locators[0]).toMatchObject({
      source: 'congress',
      id: 'directory-9',
      email: 'jamie@example.gov',
    });
  });

  it('saves the current selection as a new list, filtering out targets with no usable email', async () => {
    renderPanel({ selected: [targetA, targetNoEmail] });

    fireEvent.click(screen.getByRole('button', { name: /save current selection as a list/i }));
    expect(screen.getByText(/1 selected target has no usable email/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/defense appropriations subcommittee/i), {
      target: { value: 'My new list' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save 1 contact/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'post')).toBe(true));
    const postCall = calls.find((call) => call.method === 'post')!;
    expect(postCall.url).toBe('/api/engagement/outreach/audiences');
    expect(postCall.body).toEqual({
      kind: 'list',
      name: 'My new list',
      members: [
        {
          source: 'congress',
          sourceRefId: 'a',
          name: 'Jordan Smith',
          email: 'jordan@example.gov',
          title: 'Legislative Director',
          office: 'Office of Representative Example',
        },
      ],
    });
  });

  it('disables saving when nothing selected has a usable email', () => {
    renderPanel({ selected: [targetNoEmail] });
    fireEvent.click(screen.getByRole('button', { name: /save current selection as a list/i }));
    fireEvent.change(screen.getByPlaceholderText(/defense appropriations subcommittee/i), {
      target: { value: 'My new list' },
    });
    expect(screen.getByRole('button', { name: /save 0 contacts/i })).toBeDisabled();
  });

  it('disables the save action entirely when nothing is selected', () => {
    renderPanel({ selected: [] });
    expect(screen.getByRole('button', { name: /save current selection as a list/i })).toBeDisabled();
  });
});
