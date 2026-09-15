import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FolderImportReview } from './FolderImportReview.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), previewProps: [] as unknown[] }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant-a:user-a' }));
vi.mock('../../../components/overlays/index.js', () => ({
  CapiroModal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./FolderReportPreview.js', () => ({
  FolderReportPreview: (props: unknown) => {
    mocks.previewProps.push(props);
    return null;
  },
}));
beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.previewProps.length = 0;
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

const IMPORTS = '/intel-api/legiwatch/folder-imports';
const run = (id: string) => ({
  status: 'active',
  id,
  tenantId: 'tenant-a',
  sourceAccount: 'lobbytools',
  captureId: `cap-${id}`,
  mappingHash: 'mh1',
  createdAt: '2026-09-01T00:00:00.000Z',
});
const reconciliation = (runId: string, items: unknown[], nextOffset: number | null = null) => ({
  run: run(runId),
  counts: items.reduce((acc: Array<{ kind: string; status: string; _count: { _all: number } }>, i) => {
    const item = i as { kind: string; status: string };
    const found = acc.find((c) => c.kind === item.kind && c.status === item.status);
    if (found) found._count._all += 1;
    else acc.push({ kind: item.kind, status: item.status, _count: { _all: 1 } });
    return acc;
  }, []),
  items,
  nextOffset,
});
const reportItem = (sourceId: string, status = 'ready') => ({
  id: `item-${sourceId}`,
  kind: 'report',
  sourceId,
  status,
  reason: null,
});
const assignmentItem = (sourceId: string) => ({
  id: `item-${sourceId}`,
  kind: 'assignment',
  sourceId,
  status: 'ready',
  reason: null,
});

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

test('the report preview targets the captured report record of the selected run, never a fixed id', async () => {
  mocks.get.mockImplementation((url: string) => {
    if (url === IMPORTS) return Promise.resolve({ data: [run('run-1')] });
    if (url === `${IMPORTS}/run-1`)
      return Promise.resolve({
        data: reconciliation('run-1', [assignmentItem('a-1'), reportItem('77120')]),
      });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  mount();
  const button = await screen.findByRole('button', { name: 'Preview captured report 77120' });
  expect(screen.queryByRole('button', { name: /Acadia/ })).toBeNull();
  fireEvent.click(button);
  expect(mocks.previewProps).toEqual([
    expect.objectContaining({ runId: 'run-1', reportId: '77120' }),
  ]);
});

test('a run without captured report records states that instead of offering a preview', async () => {
  mocks.get.mockImplementation((url: string) => {
    if (url === IMPORTS) return Promise.resolve({ data: [run('run-1')] });
    if (url === `${IMPORTS}/run-1`)
      return Promise.resolve({ data: reconciliation('run-1', [assignmentItem('a-1')]) });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  mount();
  await screen.findByText('No captured report records in this import run.');
  expect(screen.queryByRole('button', { name: /Preview captured report/ })).toBeNull();
});

test('report records outside the current page are reported as paged away, not absent', async () => {
  mocks.get.mockImplementation((url: string) => {
    if (url === IMPORTS) return Promise.resolve({ data: [run('run-1')] });
    if (url === `${IMPORTS}/run-1`)
      return Promise.resolve({
        data: {
          ...reconciliation('run-1', [assignmentItem('a-1')]),
          counts: [
            { kind: 'assignment', status: 'ready', _count: { _all: 101 } },
            { kind: 'report', status: 'ready', _count: { _all: 1 } },
          ],
          nextOffset: 100,
        },
      });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  mount();
  await screen.findByText(/outside this page of results/);
  expect(screen.queryByText('No captured report records in this import run.')).toBeNull();
});

test('multiple captured reports are chosen from a record-derived list', async () => {
  mocks.get.mockImplementation((url: string) => {
    if (url === IMPORTS) return Promise.resolve({ data: [run('run-1')] });
    if (url === `${IMPORTS}/run-1`)
      return Promise.resolve({
        data: reconciliation('run-1', [reportItem('77120'), reportItem('88001')]),
      });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  mount();
  const select = await screen.findByLabelText('Preview captured report');
  fireEvent.change(select, { target: { value: '88001' } });
  expect(mocks.previewProps).toEqual([
    expect.objectContaining({ runId: 'run-1', reportId: '88001' }),
  ]);
});

test('switching the import run clears an open preview and shows the new run records', async () => {
  mocks.get.mockImplementation((url: string) => {
    if (url === IMPORTS) return Promise.resolve({ data: [run('run-1'), run('run-2')] });
    if (url === `${IMPORTS}/run-1`)
      return Promise.resolve({
        data: reconciliation('run-1', [reportItem('77120'), assignmentItem('a-1')]),
      });
    if (url === `${IMPORTS}/run-2`)
      return Promise.resolve({ data: reconciliation('run-2', [assignmentItem('b-1')]) });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Preview captured report 77120' }));
  expect(mocks.previewProps).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Import run'), { target: { value: 'run-2' } });
  await screen.findByText('No captured report records in this import run.');
  expect(mocks.previewProps).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /Preview captured report/ })).toBeNull();
});

test('an excluded report record is not offered for preview', async () => {
  mocks.get.mockImplementation((url: string) => {
    if (url === IMPORTS) return Promise.resolve({ data: [run('run-1')] });
    if (url === `${IMPORTS}/run-1`)
      return Promise.resolve({
        data: reconciliation('run-1', [reportItem('77120', 'excluded')]),
      });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  mount();
  await screen.findByText('Captured report records in this run are excluded and cannot be previewed.');
  expect(screen.queryByRole('button', { name: /Preview captured report/ })).toBeNull();
});
