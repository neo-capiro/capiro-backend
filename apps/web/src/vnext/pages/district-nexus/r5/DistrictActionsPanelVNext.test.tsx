import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, test, expect } from 'vitest';
import { DistrictActionsPanelVNext } from './DistrictActionsPanelVNext.js';
import { useApi } from '../../../../lib/use-api.js';

vi.mock('../../../../lib/use-api.js', () => ({ useApi: vi.fn() }));
test('shows source-backed candidate and stages only on user click', async () => {
  const post = vi.fn().mockResolvedValue({ data: { id: 'a' } });
  const get = vi.fn().mockResolvedValue({ data: { staged: [], candidates: [{
    key: 'candidate', id: 'candidate', actionType: 'district_one_pager', issueTitle: 'Prepare district brief',
    whatChanged: 'Verified site', whyItMatters: 'Review site', recommendedAction: 'Review evidence',
    targetAudience: [], ownerUserId: 'user-1', suggestedArtifactType: 'member_one_pager',
    priority: 80, confidence: { clientRelevance: 'high' }, uncertainty: null,
    evidence: [{ kind: 'source', note: 'source' }], facts: [{ id: 'facility:1', source: { label: 'Facility' }, basis: 'verified_client_nexus', coverage: 'complete', freshness: { stale: false } }],
  }] } });
  vi.mocked(useApi).mockReturnValue({ get, post } as never);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DistrictActionsPanelVNext clientId="client-1" state="TX" district="08" />
  </QueryClientProvider>);
  expect(await screen.findByText('Prepare district brief')).toBeInTheDocument();
  expect(screen.getByText(/Facility · verified client nexus/)).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(expect.stringContaining('/stage'), expect.objectContaining({ clientId: 'client-1', district: '08', key: 'candidate' })));
});
