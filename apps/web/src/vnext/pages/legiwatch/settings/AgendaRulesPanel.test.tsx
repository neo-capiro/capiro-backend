import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AgendaRulesPanel } from './AgendaRulesPanel.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), admin: false }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant-a:user-a' }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  AGENDA_ALERTS_FEATURE: 'agenda',
  useIntelFeatureEnabled: () => true,
}));
vi.mock('../reports/ReportWorkspace.js', () => ({
  RuleEditor: () => <div aria-label="Agenda rule editor">Editable rule</div>,
}));
beforeEach(() => {
  mocks.admin = false;
  mocks.get.mockReset();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/capabilities')) return { data: { canPromote: mocks.admin } };
    if (url.endsWith('/staged')) throw { response: { status: 403 } };
    if (url.endsWith('/folders')) return { data: [] };
    return { data: [{ id: 'rule-a', name: 'My agenda rule', state: 'draft' }] };
  });
});
afterEach(cleanup);
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AgendaRulesPanel />
    </QueryClientProvider>,
  );
}

test('ordinary users can load and edit their rules without requesting administrator captures', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'My agenda rule · draft' }));
  await screen.findByLabelText('Agenda rule editor');
  await screen.findByText('Captured definitions can be reconciled by a tenant administrator.');
  expect(mocks.get.mock.calls.some(([url]) => url.endsWith('/staged'))).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a staged-record denial does not hide the working rules and has an isolated retry', async () => {
  mocks.admin = true;
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'My agenda rule · draft' }));
  await screen.findByLabelText('Agenda rule editor');
  fireEvent.click(screen.getByText('Captured definitions awaiting reconciliation'));
  const retry = await screen.findByRole('button', { name: 'Retry captured definitions' });
  expect(screen.getByText(/Administrator access could not be verified/)).toBeTruthy();
  const before = mocks.get.mock.calls.filter(([url]) => url.endsWith('/staged')).length;
  fireEvent.click(retry);
  await waitFor(() =>
    expect(mocks.get.mock.calls.filter(([url]) => url.endsWith('/staged')).length).toBe(before + 1),
  );
  expect(screen.getByLabelText('Agenda rule editor')).toBeTruthy();
});

test('failed folder targets prevent editing with an empty replacement list', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation((url: string) =>
    url.endsWith('/folders') ? Promise.reject(new Error('offline')) : original(url),
  );
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'My agenda rule · draft' }));
  await screen.findByRole('button', { name: 'Retry folder targets' });
  expect(screen.queryByLabelText('Agenda rule editor')).toBeNull();
});
