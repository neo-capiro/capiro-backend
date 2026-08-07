import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  activateEngagementPreview,
  ENGAGEMENT_PREVIEW_STORAGE_KEY,
} from '../../lib/engagement-api-preview.js';
import { markEngagementResponseData } from '../../lib/engagement-preview-cache.js';
import { EngagementPreviewBoundary } from './EngagementPreviewBoundary.js';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function renderBoundary(initialEntry: string, client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <EngagementPreviewBoundary />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EngagementPreviewBoundary mode transitions', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('activation clears only Engagement-owned cache before consuming its parameter', async () => {
    const client = new QueryClient();
    const engagement = { rows: ['meeting'] };
    const directory = { rows: ['person'] };
    client.setQueryData(['mixed-engagement-data'], engagement);
    client.setQueryData(['directory-members'], directory);
    markEngagementResponseData(engagement);

    renderBoundary('/engagement/meetings?meetingId=m1&engagement-api-preview=v3&detail=notes#focus', client);

    await waitFor(() => expect(window.sessionStorage.getItem(ENGAGEMENT_PREVIEW_STORAGE_KEY)).toBe('v3'));
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent(
        '/engagement/meetings?meetingId=m1&detail=notes#focus',
      ),
    );
    expect(client.getQueryData(['mixed-engagement-data'])).toBeUndefined();
    expect(client.getQueryData(['directory-members'])).toBe(directory);
    expect(screen.getByLabelText('Engagement API preview status')).toBeInTheDocument();
  });

  test('deactivation clears preview Engagement cache and preserves non-Engagement cache', async () => {
    activateEngagementPreview();
    const client = new QueryClient();
    const engagement = { rows: ['preview-meeting'] };
    const workspace = { rows: ['document'] };
    client.setQueryData(['cross-surface-engagement'], engagement);
    client.setQueryData(['workspace-documents'], workspace);
    markEngagementResponseData(engagement);

    renderBoundary('/settings/integrations?clientId=c1&engagement-api-preview=off', client);

    await waitFor(() => expect(window.sessionStorage.getItem(ENGAGEMENT_PREVIEW_STORAGE_KEY)).toBeNull());
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent('/settings/integrations?clientId=c1'),
    );
    expect(client.getQueryData(['cross-surface-engagement'])).toBeUndefined();
    expect(client.getQueryData(['workspace-documents'])).toBe(workspace);
    expect(screen.queryByLabelText('Engagement API preview status')).toBeNull();
  });

  test('unknown activation is consumed without changing mode or evicting cache', async () => {
    const client = new QueryClient();
    const engagement = { rows: ['main-meeting'] };
    client.setQueryData(['mixed-engagement-data'], engagement);
    markEngagementResponseData(engagement);

    renderBoundary('/engagement/meetings?engagement-api-preview=V3&keep=1', client);

    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent('/engagement/meetings?keep=1'),
    );
    expect(window.sessionStorage.getItem(ENGAGEMENT_PREVIEW_STORAGE_KEY)).toBeNull();
    expect(client.getQueryData(['mixed-engagement-data'])).toBe(engagement);
  });
});
