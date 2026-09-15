import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FolderReportPreview } from './FolderReportPreview.js';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant-a:user-a' }));
vi.mock('../../../components/overlays/index.js', () => ({
  CapiroModal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
beforeEach(() => {
  mocks.get.mockReset();
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-09-15T12:00:00.000Z');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(reportId = '77120') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FolderReportPreview runId="run-1" reportId={reportId} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

const REPORT_URL = '/intel-api/legiwatch/folder-imports/run-1/report/77120';
const report = {
  name: 'Weekly folder report',
  asOf: '2026-09-15',
  fromDate: '2026-09-11',
  dateSemantics:
    'Legislative date-only values; inclusive five-calendar-day action window. No audit timestamp timezone is inferred.',
  expectedAssignments: 1,
  complete: true,
  exceptions: [],
  rows: [
    {
      id: 'fl-hb-64',
      number: 'HB 64',
      title: 'Spaceport territory',
      sponsor: 'D. Alvarez',
      currentPublicStatus: 'In committee',
      folderName: 'Kela Systems',
      sourceUrl: 'https://example.gov/hb64',
      summary: 'A real summary',
      lastActionAt: '2026-09-14',
      actions: [{ date: '2026-09-14', text: 'Referred to committee' }],
      reportCommentObservation: null,
    },
  ],
};

test('the cutoff defaults to the real current date and drives the report request', async () => {
  mocks.get.mockResolvedValue({ data: report });
  const { container } = mount();
  const input = container.querySelector('input[type="date"]') as HTMLInputElement;
  expect(input.value).toBe('2026-09-15');
  await screen.findByText('Weekly folder report');
  expect(mocks.get).toHaveBeenCalledWith(REPORT_URL, { params: { asOf: '2026-09-15' } });
  expect(screen.queryByText(/Qualification cutoff/)).toBeNull();
});

test('a failed preview is retried against the same run and report identifiers', async () => {
  mocks.get
    .mockRejectedValueOnce({ response: { status: 500, data: { message: 'REPORT_UNAVAILABLE' } } })
    .mockResolvedValue({ data: report });
  mount();
  await screen.findByText('report unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
  await screen.findByText('Weekly folder report');
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(mocks.get).toHaveBeenNthCalledWith(2, REPORT_URL, { params: { asOf: '2026-09-15' } });
});

test('an incomplete preview shows captured exceptions and blocks download', async () => {
  mocks.get.mockResolvedValue({
    data: {
      ...report,
      complete: false,
      exceptions: [{ sourceId: 'folder-9', reason: 'Captured 12 assignments; import contains 9' }],
    },
  });
  mount();
  await screen.findByText(/Incomplete preview/);
  await screen.findByText('folder-9: Captured 12 assignments; import contains 9');
  expect(screen.getByRole('button', { name: 'Download preview' })).toBeDisabled();
});
