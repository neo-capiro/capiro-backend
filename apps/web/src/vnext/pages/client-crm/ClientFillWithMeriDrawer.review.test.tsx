import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientFillWithMeriDrawer } from './ClientFillWithMeriDrawer.js';
import type { FillFinding } from '../../adapters/legacy/useClientFillWithMeri.js';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

const finding = (overrides: Record<string, unknown> = {}): FillFinding => ({
  id: 'finding-1', runId: 'run-1', kind: 'advocacy_record', targetKey: 'testimony:1',
  source: 'testimony', factKind: 'fact', currentValue: null,
  proposedValue: {
    title: 'Congressional testimony', sourceType: 'testimony',
    sourceUrl: 'https://example.org/hearings/1',
    metadata: { witness: 'Brian Harrison, Department of Housing and Urban Development', clientMatch: { method: 'name_similarity' } },
  },
  evidence: [], confidence: 0.79, status: 'pending', appliedAt: null, createdAt: '',
  ...overrides,
});

function renderRun(findings: ReturnType<typeof finding>[], status = 'partial') {
  const run = {
    id: 'run-1', clientId: 'client-1', requestedSources: [], sourceStates: {}, summary: {}, error: null,
    startedAt: '2026-09-01T12:00:00.000Z', completedAt: '2026-09-01T12:01:00.000Z',
    status, findings,
  };
  getMock.mockImplementation(async (url: string) => ({ data: url.includes('advocacy-matters') ? [] : structuredClone(run) }));
  const rendered = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ClientFillWithMeriDrawer clientId="client-1" clientName="L3 Harris" open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return { ...rendered, run };
}

beforeEach(() => { getMock.mockReset(); postMock.mockReset(); });

describe('Meri durable review and attribution evidence', () => {
  it('reloads durable findings after an apply request fails after saving an update', async () => {
    const { run } = renderRun([
      finding({ id: 'description', kind: 'profile_field', targetKey: 'description', source: 'public_web', proposedValue: 'Communications technology' }),
      finding({ id: 'website', kind: 'profile_field', targetKey: 'website', source: 'public_web', proposedValue: 'https://example.org' }),
    ], 'completed');
    postMock.mockImplementation(async () => {
      run.findings[0] = { ...run.findings[0]!, status: 'accepted', appliedAt: '2026-09-01T12:02:00.000Z' };
      throw new Error('The remaining update could not be saved');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Accept all safe changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 updates' }));
    expect(await screen.findByText(/The remaining update could not be saved/)).toBeInTheDocument();
    expect(await screen.findByText('Applied')).toBeInTheDocument();
    expect(screen.getByText(/1 update has already been applied from this run/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply 1 update' })).toBeEnabled();
  });

  it('clears pending selection when a real apply refresh returns the finding as accepted', async () => {
    const { run } = renderRun([finding({
      id: 'description-1', kind: 'profile_field', targetKey: 'description', source: 'public_web',
      proposedValue: 'Communications and space technology',
      evidence: [{ label: 'Company overview' }],
    })], 'completed');
    postMock.mockImplementation(async (url: string) => {
      if (!url.endsWith('/runs/run-1/apply')) throw new Error(`Unexpected POST ${url}`);
      // This is the server state that the hook's post-apply GET must reconcile.
      // Local selected IDs are still present when this response arrives.
      run.findings = run.findings.map((item) => ({ ...item, status: 'accepted', appliedAt: '2026-09-01T12:02:00.000Z' }));
      return { data: { applied: 1, failed: 0 } };
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(screen.getByText('Accepted for apply')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 update' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/clients/client-1/fill-with-meri/runs/run-1/apply', { findingIds: ['description-1'] },
    ));
    expect(await screen.findByText('Applied')).toBeInTheDocument();
    expect(screen.getByText(/1 update has already been applied from this run/)).toBeInTheDocument();
    expect(screen.queryByText('Accepted for apply')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply 1 update' })).not.toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply 0 updates' });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('reports already applied findings when a partial run is reopened', async () => {
    renderRun([
      finding({ id: 'saved', status: 'accepted', appliedAt: '2026-09-01T12:02:00.000Z' }),
      finding(),
    ]);
    expect(await screen.findByText(/1 update has already been applied from this run/)).toBeInTheDocument();
    expect(screen.queryByText(/No updates from this run have been applied yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/Attaching advocacy to a matter applies it immediately/)).toBeInTheDocument();
  });

  it('shows the actual witness affiliation and explains that a score is not identity proof', async () => {
    renderRun([finding()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Evidence' }));
    expect(screen.getAllByText('L3 Harris')).toHaveLength(2);
    expect(screen.getByText('Brian Harrison, Department of Housing and Urban Development')).toBeInTheDocument();
    expect(screen.getByText('Name similarity only')).toBeInTheDocument();
    expect(screen.getByText('Needs identity verification')).toBeInTheDocument();
    expect(screen.getByText(/not proof of identity/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open original source' })).toHaveAttribute('href', 'https://example.org/hearings/1');
  });

  it('explains a confirmed FARA mapping using registrant and represented-organization evidence', async () => {
    renderRun([finding({
      source: 'fara',
      proposedValue: {
        title: 'Registration', sourceType: 'fara', sourceUrl: 'https://example.org/fara/1',
        metadata: { registrantName: 'Registered Agent LLC', foreignPrincipal: 'L3 Harris', clientMatch: { method: 'confirmed_client_intel_mapping', matchedRole: 'foreign_principal' } },
      },
    })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Evidence' }));
    expect(screen.getByText('Confirmed client-to-source mapping')).toBeInTheDocument();
    expect(screen.getByText('Registered Agent LLC')).toBeInTheDocument();
    expect(screen.getByText('Field used for the match')).toBeInTheDocument();
    expect(screen.queryByText('Needs identity verification')).not.toBeInTheDocument();
  });

  it('exposes missing attribution evidence and does not render unsafe source URLs', async () => {
    renderRun([finding({
      proposedValue: { title: 'Registration', sourceType: 'fara', sourceUrl: 'javascript:alert(1)' },
      evidence: [{ label: 'Unsupported link', url: 'javascript:alert(1)' }],
    })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Evidence' }));
    expect(screen.getByText('No client-matching explanation was provided')).toBeInTheDocument();
    expect(screen.getByText(/No source link was provided/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it.each(['failed', 'cancelled'])('keeps saved findings reviewable after a %s run', async (status) => {
    renderRun([finding({ status: 'accepted', appliedAt: '2026-09-01T12:02:00.000Z' })], status);
    expect(await screen.findByText(/1 update has already been applied from this run/)).toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.queryByText('Meri finished the first pass')).not.toBeInTheDocument();
  });

  it('keeps the original-source link when it also appears beyond the visible evidence limit', async () => {
    renderRun([finding({ evidence: [
      ...Array.from({ length: 4 }, (_, i) => ({ label: `Evidence ${i}` })),
      { label: 'Fifth source', url: 'https://example.org/hearings/1' },
    ] })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Evidence' }));
    expect(screen.getByRole('link', { name: 'Open original source' })).toHaveAttribute('href', 'https://example.org/hearings/1');
  });
});
