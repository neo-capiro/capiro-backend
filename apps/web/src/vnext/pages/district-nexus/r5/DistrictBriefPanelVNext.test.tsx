import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DistrictBriefPanelVNext } from './DistrictBriefPanelVNext.js';
import { DistrictNexusDrawerVNext } from '../DistrictNexusDrawerVNext.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), flag: { enabled: false } }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: mocks.get, post: mocks.post }) }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({ useIntelFeatureEnabled: (key: string) => key === 'district_nexus_r5_brief' && mocks.flag.enabled }));
vi.mock('react-router-dom', () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));

const brief = {
  clientId: 'client-1', clientName: 'Client', state: 'WY', district: '00',
  sections: [{ key: 'verified_footprint', title: 'Verified Footprint', paragraphs: ['Draft copy'], factIds: ['f1'] }],
  facts: [{ id: 'f1', section: 'footprint', label: 'Factory', value: 2, unit: 'people', amountStage: null,
    basis: 'verified_client_nexus', source: { type: 'facility', label: 'Client facility', recordId: 'f1', url: null },
    asOf: { date: null, fiscalYear: null, sourceYear: null }, geography: { state: 'WY', district: '00', scope: 'district', basis: 'facility', boundaryCongress: null },
    freshness: { lastSyncedAt: null, stale: false, unavailable: true }, coverage: 'partial', caveats: [] }],
  gaps: [], sourceHealth: [], generatedAt: '2026-09-20T00:00:00Z',
};
function withQueries(child: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{child}</QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.enabled = false;
  mocks.get.mockImplementation(async (path: string) => {
    if (path.includes('/r5/brief')) return { data: brief };
    throw new Error('detail unavailable');
  });
  mocks.post.mockImplementation(async (path: string) => ({ data: path.endsWith('/save')
    ? { attachmentId: 'attachment-1', fileName: 'brief.docx' } : new Blob(['docx']) }));
});

describe('District Brief', () => {
  it('does not mount or request the brief when the flag is off', async () => {
    withQueries(<DistrictNexusDrawerVNext districtKey="WY-00" clientId="client-1" onClose={() => {}} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(screen.queryByText('District Brief (R5)')).not.toBeInTheDocument();
    expect(mocks.get.mock.calls.some(([path]) => String(path).includes('/r5/brief'))).toBe(false);
  });
  it('renders sections, provenance chips, edits then exports edited content', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:brief');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    withQueries(<DistrictBriefPanelVNext clientId="client-1" state="WY" district="00" />);
    expect(await screen.findByText('Draft copy')).toBeInTheDocument();
    expect(screen.getByText(/Client facility.*partial.*verified client nexus/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Edit Verified Footprint'), { target: { value: 'Edited copy' } });
    fireEvent.click(screen.getByText('Export .docx'));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      expect.stringContaining('/export'), expect.objectContaining({ sections: [expect.objectContaining({ paragraphs: ['Edited copy'] })] }),
      { responseType: 'blob' },
    ));
    create.mockRestore(); revoke.mockRestore(); click.mockRestore();
  });
  it('shows save success', async () => {
    withQueries(<DistrictBriefPanelVNext clientId="client-1" state="WY" district="00" />);
    await screen.findByText('Draft copy');
    fireEvent.click(screen.getByText('Save to client'));
    expect(await screen.findByText(/brief.docx/)).toBeInTheDocument();
  });
  it('distinguishes a failed request from an empty brief', async () => {
    mocks.get.mockRejectedValueOnce(new Error('down'));
    withQueries(<DistrictBriefPanelVNext clientId="client-1" state="WY" district="00" />);
    expect(await screen.findByText('District Brief could not load')).toBeInTheDocument();
  });
});
