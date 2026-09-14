import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FolderImportReview } from './FolderImportReview.js';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant-a:user-a' }));
vi.mock('../../../components/overlays/index.js', () => ({
  CapiroModal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./FolderReportPreview.js', () => ({ FolderReportPreview: () => null }));
beforeEach(() => {
  mocks.get.mockReset();
});
afterEach(cleanup);
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FolderImportReview onClose={() => {}} />
    </QueryClientProvider>,
  );
}

test('a network failure is not presented as an administrator denial and can be retried', async () => {
  mocks.get.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ data: [] });
  mount();
  await screen.findByText('Import runs could not be loaded. Retry to check the service again.');
  expect(screen.queryByText(/requires a verified tenant administrator/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry import review' }));
  await screen.findByText(/No import runs are available/);
  expect(mocks.get).toHaveBeenCalledTimes(2);
});

test('a real forbidden response explains verified membership instead of an empty import state', async () => {
  mocks.get.mockRejectedValue({ response: { status: 403 } });
  mount();
  await screen.findByText(/requires a verified tenant administrator/);
  expect(screen.queryByText(/No import runs are available/)).toBeNull();
});
