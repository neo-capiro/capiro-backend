import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BillImpactDraft } from './BillImpactDraft.js';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get, post }) }));
vi.mock('../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant:user' }));
const lifecycle = {
  title: 'Test bill',
  latestAction: 'Laid on table; companion SB 474 became law.',
  actionDate: '2026-04-01',
  sourceUrl: 'https://flsenate.gov/bill',
};
const version = {
  id: 'v1',
  revision: 'hash1',
  label: 'Introduced',
  publishedDate: '2026-01-01',
  sourceUrl: 'https://flsenate.gov/text',
  unavailableReason: null as string | null,
};
const options = () => ({
  client: { id: 'client-a', name: 'Client A' },
  lifecycle,
  contextUnavailable: null as string | null,
  versions: [{ ...version }],
});
const draft = {
  client: { id: 'client-a', name: 'Client A' },
  version,
  lifecycle,
  coverage: 'Complete selected text supplied.',
  limitations: 'One version only.',
  impacts: [
    {
      possibleImplication: 'The client might qualify.',
      assumptions: 'Eligibility needs review.',
      verificationStep: 'Check criteria.',
      evidence: [{ id: 'E1', locator: 'Section 1', text: 'This does not appropriate funds.' }],
      clientBasis: [
        { id: 'C1', label: 'Client description', text: 'Manufactures aircraft structures.' },
      ],
    },
  ],
};
beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: options() });
  post.mockReset().mockResolvedValue({ data: draft });
});
afterEach(cleanup);
it('shows no supported connection without claiming the bill has no impact', async () => {
  post.mockResolvedValue({ data: { ...draft, impacts: [] } });
  mount();
  await screen.findByRole('combobox');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate impact draft' }));
  expect(await screen.findByText(/This is not proof of no impact/)).toBeTruthy();
});
it('renders federal text-version codes as readable labels', async () => {
  const value = options();
  value.versions[0]!.label = 'ih';
  get.mockResolvedValue({ data: value });
  mount();
  expect(await screen.findByRole('option', { name: /Introduced in House/ })).toBeTruthy();
});
it('does not display an earlier client response that completes after a scope change', async () => {
  let resolve!: (result: unknown) => void;
  post.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const result = mount();
  await screen.findByRole('combobox');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate impact draft' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  result.rerender(result.view('client-b'));
  await act(async () => {
    resolve({ data: draft });
    await Promise.resolve();
  });
  expect(screen.queryByText('The client might qualify.')).toBeNull();
});
function mount(clientId: string | null = 'client-a') {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (client: string | null) => (
    <QueryClientProvider client={query}>
      <BillImpactDraft billId="fl-2026-hb1211" clientId={client} />
    </QueryClientProvider>
  );
  return { ...render(view(clientId)), view };
}
it('requires a client before requesting private impact data', () => {
  mount(null);
  expect(screen.getByText(/Select a client/)).toBeTruthy();
  expect(get).not.toHaveBeenCalled();
});
it('requires explicit version selection and posts only its exact identity', async () => {
  mount();
  const button = await screen.findByRole('button', { name: 'Generate impact draft' });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1' } });
  fireEvent.click(button);
  await screen.findByRole('heading', { name: 'Draft for review — Client A' });
  expect(post).toHaveBeenCalledWith(
    '/legiwatch/bills/fl-2026-hb1211/impact',
    { clientId: 'client-a', versionId: 'v1', revision: 'hash1' },
    { timeout: 165000 },
  );
  expect(screen.getByText('This does not appropriate funds.')).toBeTruthy();
  expect(screen.getByText(/Laid on table/)).toBeTruthy();
  expect(screen.getByText(/Jan 1, 2026/, { selector: 'option' })).toBeTruthy();
});
it.each(['source', 'context'])(
  'disables generation and shows actionable %s reason',
  async (kind) => {
    const value = options();
    if (kind === 'source') value.versions[0]!.unavailableReason = 'Complete text unavailable.';
    else value.contextUnavailable = 'Add products and services.';
    get.mockResolvedValue({ data: value });
    mount();
    await screen.findByRole('combobox');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1' } });
    expect(screen.getByRole('button', { name: 'Generate impact draft' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        kind === 'source' ? /Complete text unavailable/ : /Add products and services/,
      ),
    ).toBeTruthy();
  },
);
it('shows missing retained text honestly without a generate action', async () => {
  const value = options();
  value.versions = [];
  get.mockResolvedValue({ data: value });
  mount();
  await screen.findByText(/No retained text versions/);
  expect(screen.queryByRole('button')).toBeNull();
});
it('withholds prior draft after changing client scope', async () => {
  const result = mount();
  await screen.findByRole('combobox');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate impact draft' }));
  await screen.findByText('The client might qualify.');
  result.rerender(result.view('client-b'));
  expect(screen.queryByText('The client might qualify.')).toBeNull();
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith(expect.any(String), { params: { clientId: 'client-b' } }),
  );
});
it('shows verification failure without a partial draft', async () => {
  post.mockRejectedValue({
    response: { data: { message: 'The impact draft could not be verified. No draft was saved.' } },
  });
  mount();
  await screen.findByRole('combobox');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'v1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate impact draft' }));
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Impact draft for review')).toBeNull();
});
