import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DistrictNexusDrawerVNext } from '../DistrictNexusDrawerVNext.js';
import { DistrictMeetingPrepPanelVNext } from './DistrictMeetingPrepPanelVNext.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), enabled: false }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: mocks.get, post: mocks.post, patch: mocks.patch }) }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({ useIntelFeatureEnabled: (key: string) => key === 'district_nexus_r5_meeting_prep' && mocks.enabled }));
vi.mock('react-router-dom', () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
const path = '/api/intelligence/district-nexus/r5/meeting-prep';
const prep = { id: 'prep-1', meetingId: 'meeting-1', status: 'generated',
  agenda: [{ text: 'Site: unknown', factIds: ['f1'] }], talkingPoints: [], followUps: [], risks: [{ text: 'No feed', factIds: [] }],
  generatedFrom: { kind: 'district_nexus_r5', clientId: 'client-1', state: 'TX', district: '08', factIds: ['f1'],
    questions: [], attendeesTargets: ['Attendee'], contextGeneratedAt: '2026-01-01T00:00:00Z',
    evidence: [{ id: 'f1', source: { label: 'Facility' }, asOf: {}, basis: 'verified_client_nexus',
      freshness: { unavailable: true }, coverage: 'partial', geography: { scope: 'district' } }] } };
function mount(child: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{child}</QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled = false;
  mocks.get.mockImplementation(async (url: string) => {
    if (url === `${path}/meetings`) return { data: [{ id: 'meeting-1', subject: 'Planning', startsAt: '2030-01-01T00:00:00Z', attendees: ['Attendee'] }] };
    throw new Error('detail unavailable');
  });
  mocks.post.mockResolvedValue({ data: prep }); mocks.patch.mockResolvedValue({ data: { ...prep, status: 'reviewed' } });
});
describe('District meeting prep', () => {
  it('makes no meeting prep request with flag off', async () => {
    mount(<DistrictNexusDrawerVNext districtKey="TX-08" clientId="client-1" onClose={() => {}} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.get.mock.calls.some(([url]) => String(url).includes('/r5/meeting-prep'))).toBe(false);
    expect(screen.queryByText('District meeting prep (R5)')).not.toBeInTheDocument();
  });
  it('lists existing meetings, generates and saves edited items with fact references', async () => {
    mount(<DistrictMeetingPrepPanelVNext clientId="client-1" state="TX" district="08" />);
    fireEvent.change(await screen.findByLabelText('Existing meeting'), { target: { value: 'meeting-1' } });
    fireEvent.click(screen.getByText('Generate'));
    expect(await screen.findByText('Facility · verified client nexus · freshness unknown · partial coverage')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('agenda 1'), { target: { value: 'Updated objective' } });
    fireEvent.click(screen.getByText('Save edits'));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(`${path}/prep-1`, expect.objectContaining({
      agenda: [{ text: 'Updated objective', factIds: ['f1'] }], reviewed: false,
    })));
  });
  it('shows empty state linking to existing meetings', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    mount(<DistrictMeetingPrepPanelVNext clientId="client-1" state="TX" district="08" />);
    expect(await screen.findByText('Open existing meetings')).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
