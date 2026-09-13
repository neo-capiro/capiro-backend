import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant:user' }));
import { HearingPublicationsPanel } from './HearingPublicationsPanel.js';
const evidence = {
  segmentId: 'final-one',
  text: 'The witness discussed bridge maintenance.',
  startMs: 1000,
  endMs: 5000,
  speakerLabel: '0',
};
const payload = {
  title: 'Transportation testimony',
  label: 'Unofficial transcript-based hearing update',
  clientId: 'client-one',
  evidence: [evidence],
  claims: [
    {
      id: 'claim-one',
      kind: 'observation',
      text: 'The witness discussed bridge maintenance.',
      evidenceIds: ['final-one'],
    },
  ],
  folders: [],
  coverage: {
    audio: 'partial',
    transcript: 'partial',
    missing: ['Recording has an interruption.'],
  },
};
let version: {
  id: string;
  version: number;
  status: string;
  contentHash: string;
  payload: typeof payload;
};
const preview = {
  approvalHash: 'exact-audience-hash',
  composition: {
    subject: 'Reviewed message',
    plainText: 'Frozen reviewed message',
    smsText: null,
    smsSize: null,
    recipients: [{ name: 'Alice', email: 'alice@example.invalid', role: 'to' }],
  },
};
beforeEach(() => {
  version = {
    id: 'version-one',
    version: 1,
    status: 'draft',
    contentHash: 'a'.repeat(64),
    payload,
  };
  mocks.get.mockReset().mockImplementation(async (url: string) => ({
    data: structuredClone(
      url.includes('/candidates')
        ? { evidence: [evidence], candidates: [] }
        : url.includes('/deliveries')
          ? []
          : url.endsWith('/recipients')
            ? {
                contacts: [
                  {
                    id: 'alice',
                    name: 'Alice',
                    email: 'alice@example.invalid',
                    active: true,
                    verified: true,
                    optedOut: false,
                  },
                  {
                    id: 'bob',
                    name: 'Bob',
                    email: 'bob@example.invalid',
                    active: true,
                    verified: true,
                    optedOut: false,
                  },
                ],
              }
            : url.includes('/publications')
              ? [version]
              : [],
    ),
  }));
  mocks.post.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/approve')) version = { ...version, status: 'approved' };
    return { data: url.endsWith('/delivery-preview') ? preview : version };
  });
});
afterEach(() => cleanup());
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <HearingPublicationsPanel
        sessionId="session-one"
        title="Transportation testimony"
        defaultClientId="client-one"
        clients={[
          { id: 'client-one', name: 'First client' },
          { id: 'client-two', name: 'Second client' },
        ]}
        updatesEnabled
        recapsEnabled
        smsEnabled={false}
        recapRequested={false}
        onRecapOpened={() => undefined}
        playEvidence={() => undefined}
      />
    </QueryClientProvider>,
  );
}
async function selectVersion() {
  await screen.findByRole('option', { name: /v1 ·/ });
  fireEvent.change(screen.getByLabelText('Saved version'), { target: { value: 'version-one' } });
}
describe('reviewed hearing publication controls', () => {
  it('requires content review and a separate audience preview before queuing a message', async () => {
    mount();
    await selectVersion();
    expect(screen.getByRole('button', { name: 'Approve this version' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I reviewed every claim/));
    fireEvent.click(screen.getByRole('button', { name: 'Approve this version' }));
    await screen.findByText('4. Preview delivery');
    expect(mocks.post.mock.calls.some(([url]) => String(url).endsWith('/deliveries'))).toBe(false);
    fireEvent.click(screen.getByLabelText(/Alice ·/));
    fireEvent.click(screen.getByRole('button', { name: 'Preview exact message and audience' }));
    await screen.findByText('Frozen reviewed message');
    expect(mocks.post.mock.calls.some(([url]) => String(url).endsWith('/deliveries'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Queue this reviewed message' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        '/intel-api/hearings/session-one/publications/version-one/deliveries',
        {
          channel: 'email',
          selection: [{ kind: 'contact', id: 'alice', role: 'to' }],
          approvalHash: 'exact-audience-hash',
        },
      ),
    );
  });
  it('discards an in-flight preview when the selected audience changes', async () => {
    version.status = 'approved';
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    await selectVersion();
    fireEvent.click(screen.getByLabelText(/Alice ·/));
    fireEvent.click(screen.getByRole('button', { name: 'Preview exact message and audience' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText(/Bob ·/));
    await act(async () => finish({ data: preview }));
    expect(screen.queryByText('Frozen reviewed message')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Queue this reviewed message' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'client-two' } });
    expect(screen.queryByText('4. Preview delivery')).not.toBeInTheDocument();
  });
  it('saves a quote draft using an explicit persisted final segment', async () => {
    mount();
    const source = await screen.findByLabelText(/0:00:01–0:00:05/);
    fireEvent.click(source);
    fireEvent.click(screen.getByRole('button', { name: 'Add transcript quote' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft version' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        '/intel-api/hearings/session-one/publications',
        expect.objectContaining({
          kind: 'live_update',
          clientId: 'client-one',
          evidenceIds: ['final-one'],
          claims: [
            expect.objectContaining({
              kind: 'quote',
              text: evidence.text,
              evidenceIds: ['final-one'],
            }),
          ],
        }),
      ),
    );
  });
});
