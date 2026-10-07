import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import {
  PLANNER_DEFAULT_REPORT_CHART,
  PLANNER_DEFAULT_PROJECT,
  type PlannerReportWidget,
  type PlannerResource,
  type PlannerBootstrap,
} from '@capiro/strategy-verifier';
import {
  PlannerReporting,
  PlannerDashboardEditor,
  PlannerReportChartEditor,
  PlannerReportGraphic,
  plannerReportCsv,
} from './planner-reporting.js';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  resources: [] as PlannerResource[],
  report: {} as any,
  rows: {} as any,
  get: vi.fn(),
}));
vi.mock('./planner-api.js', () => ({
  usePlannerResources: () => ({ data: mocks.resources, isPending: false, isError: false }),
  usePlannerMutations: () => ({ resource: { isPending: false, mutateAsync: mocks.save } }),
  usePlannerReport: () => mocks.report,
  usePlannerReportRows: () => mocks.rows,
  usePlannerKey: () => ['planner', 'org_qa', 'owner', null],
  plannerError: String,
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: mocks.get }) }));
const widget = (): Extract<PlannerReportWidget, { kind: 'chart' }> => ({
  id: '40000000-0000-4000-8000-000000000001',
  kind: 'chart',
  title: 'Task progress',
  style: 'bar',
  labels: true,
  chart: structuredClone(PLANNER_DEFAULT_REPORT_CHART),
});
const bootstrap: PlannerBootstrap = {
  me: { id: 'owner', name: 'Owner' },
  people: [
    { id: 'owner', name: 'Owner' },
    { id: 'viewer', name: 'Viewer' },
  ],
  projects: [
    {
      ...PLANNER_DEFAULT_PROJECT,
      id: 'project-one',
      name: 'Launch',
      ownerId: 'owner',
      version: 1,
      archived: false,
      access: 'admin',
      createdAt: '2026-10-07T12:00:00Z',
      updatedAt: '2026-10-07T12:00:00Z',
    },
  ],
};
const dashboard = (): PlannerResource => ({
  id: 'dashboard-one',
  kind: 'dashboard',
  projectId: null,
  ownerId: 'owner',
  name: 'Launch overview',
  data: { description: '', privacy: 'private', members: [], widgets: [widget()] },
  version: 7,
  archived: false,
  access: 'admin',
});
const result = () => ({
  total: 127,
  matched: 127,
  unit: 'items' as const,
  buckets: [
    { key: 'todo', label: 'To do', value: 105, count: 105 },
    { key: 'done', label: 'Done', value: 22, count: 22 },
  ],
  overlapping: false,
  unavailableSources: false,
  unavailableFields: false,
  dashboardVersion: 7,
  revision: 'a'.repeat(64),
});
function view(node: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.save.mockResolvedValue({ ...dashboard(), id: 'saved-dashboard' });
  mocks.resources = [dashboard()];
  mocks.report = { data: result(), isPending: false, isError: false };
  mocks.rows = {
    data: {
      pages: [
        {
          ...result(),
          items: [
            {
              id: 'task-one',
              entity: 'tasks',
              name: 'Visible result',
              status: 'todo',
              personName: null,
              dueOn: null,
              value: 1,
            },
          ],
          nextCursor: null,
        },
      ],
    },
    isPending: false,
    isError: false,
    hasNextPage: false,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Saved Planner dashboards', () => {
  it('exports every page with the authorized revision and abandons the file if the next page loses access', async () => {
    const create = vi.fn((_blob: Blob | MediaSource) => 'blob:synthetic-report');
    const nativeURL = URL;
    class TestURL extends nativeURL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', TestURL);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const row = (i: number) => ({
      id: `task-${i}`,
      entity: 'tasks',
      name: `Export row ${i}`,
      status: 'todo',
      personName: null,
      dueOn: null,
      value: 1,
    });
    mocks.get.mockImplementation(async (_path, config) => ({
      data: {
        ...result(),
        items: config.params.cursor
          ? [row(100), row(101)]
          : Array.from({ length: 100 }, (_, i) => row(i)),
        nextCursor: config.params.cursor ? null : 'next-row',
      },
    }));
    view(<PlannerReporting bootstrap={bootstrap} selectedId="dashboard-one" onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View matching work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export all matching rows' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(mocks.get.mock.calls[1]![1].params).toMatchObject({
      cursor: 'next-row',
      version: '7',
      revision: 'a'.repeat(64),
    });
    const exported = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(create.mock.calls[0]![0] as Blob);
    });
    expect(exported.split('\r\n')).toHaveLength(103);
    expect(exported).toContain('Export row 101');
    create.mockClear();
    mocks.get.mockImplementation(async (_path, config) => {
      if (config.params.cursor) throw new Error('Access changed; refresh the report.');
      return { data: { ...result(), items: [row(0)], nextCursor: 'next-row' } };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Export all matching rows' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Access changed'));
    expect(create).not.toHaveBeenCalled();
  });
  it('saves project dashboards privately with task-bound source criteria and native date changes', async () => {
    view(
      <PlannerDashboardEditor
        bootstrap={bootstrap}
        resources={[]}
        projectId="project-one"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.input(screen.getByLabelText('From date'), { target: { value: '2044-01-02' } });
    fireEvent.input(screen.getByLabelText('Through date'), { target: { value: '2044-01-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    const saved = mocks.save.mock.calls[0]![0];
    expect(saved).toMatchObject({
      kind: 'dashboard',
      projectId: 'project-one',
      data: { privacy: 'private', members: [] },
    });
    expect(saved.data.widgets[0].chart.filters).toMatchObject({
      source: { kind: 'projects', ids: ['project-one'] },
      from: '2044-01-02',
      through: '2044-01-03',
    });
    expect(screen.getByLabelText('Report on')).toBeDisabled();
  });
  it('preserves unavailable criteria on ordinary editor title changes and captures the opening version', async () => {
    const d = dashboard(),
      w = widget();
    w.chart.group = 'custom';
    w.chart.groupFieldId = null;
    w.chart.filters.source = { kind: 'projects', ids: [] };
    d.data.widgets = [w];
    d.access = 'editor';
    d.reportWarnings = [{ widgetId: w.id, unavailableFields: true, unavailableSources: true }];
    view(
      <PlannerDashboardEditor
        resource={d}
        bootstrap={bootstrap}
        resources={[d]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Grouping field')).not.toBeRequired();
    fireEvent.change(screen.getByLabelText('Widget title'), {
      target: { value: 'A visible title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    const saved = mocks.save.mock.calls[0]![0];
    expect(saved).toMatchObject({ id: d.id, version: 7 });
    expect(saved.data).not.toHaveProperty('privacy');
    expect(saved.data).not.toHaveProperty('members');
    expect(saved.data.widgets[0]).toMatchObject({
      title: 'A visible title',
      chart: { groupFieldId: null, filters: { source: { kind: 'projects', ids: [] } } },
    });
  });
  it('keeps selected source kind explicit and adjusts date grouping for line and number charts', () => {
    function Editor() {
      const [w, setW] = useState<PlannerReportWidget>(widget());
      return w.kind === 'chart' ? (
        <PlannerReportChartEditor widget={w} bootstrap={bootstrap} resources={[]} onChange={setW} />
      ) : null;
    }
    view(<Editor />);
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'projects' } });
    expect(screen.getByLabelText('Source projects')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Chart style'), { target: { value: 'line' } });
    expect(screen.getByLabelText('Group by')).toHaveValue('created');
    fireEvent.change(screen.getByLabelText('Chart style'), { target: { value: 'number' } });
    expect(screen.getByLabelText('Group by')).toHaveValue('none');
    expect(screen.getByLabelText('Group by')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Report on'), { target: { value: 'goals' } });
    expect(screen.getByLabelText('Source')).toHaveValue('projects');
    expect(screen.getByRole('option', { name: 'Average progress' })).toBeInTheDocument();
  });
  it('opens authorized drill-down links and suppresses retained cached data after errors', () => {
    const props = { bootstrap, selectedId: 'dashboard-one', onSelect: vi.fn() };
    const rendered = view(<PlannerReporting {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'View matching work' }));
    expect(screen.getByRole('link', { name: 'Visible result' })).toHaveAttribute(
      'href',
      '/planner?scope=all&task=task-one',
    );
    mocks.rows = { ...mocks.rows, isError: true, error: 'Access changed', refetch: vi.fn() };
    rendered.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <PlannerReporting {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Visible result' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export all matching rows' })).toBeDisabled();
    mocks.report = {
      ...mocks.report,
      isError: true,
      error: 'Dashboard access revoked',
      refetch: vi.fn(),
    };
    rendered.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <PlannerReporting {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'View matching work' })).not.toBeInTheDocument();
    expect(screen.queryByText('127')).not.toBeInTheDocument();
  });
  it('renders unavailable metrics separately from zero and exposes no drill-down', () => {
    mocks.report.data = {
      ...result(),
      total: null,
      matched: null,
      buckets: [],
      unavailableFields: true,
    };
    view(<PlannerReporting bootstrap={bootstrap} selectedId="dashboard-one" onSelect={vi.fn()} />);
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'View matching work' })).not.toBeInTheDocument();
  });
  it('paginates chart groups while retaining full totals and supports negative numeric values', () => {
    const w = widget();
    w.style = 'donut';
    view(
      <PlannerReportGraphic
        widget={w}
        result={{
          ...result(),
          buckets: Array.from({ length: 25 }, (_, i) => ({
            key: String(i),
            label: `Category ${i}`,
            value: i - 5,
            count: 1,
          })),
        }}
        onBucket={vi.fn()}
      />,
    );
    expect(screen.getByText(/a donut needs positive totals/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'View Category 0: -5' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next groups' }));
    expect(screen.getByRole('button', { name: 'View Category 24: 19' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'View Category 0: -5' })).not.toBeInTheDocument();
  });
  it('exports readable row identities and escapes spreadsheet formula inputs', () => {
    const csv = plannerReportCsv(
      [
        {
          id: 'one',
          entity: 'goals',
          name: '=HYPERLINK("unsafe")',
          status: 'on_track',
          personName: 'Owner',
          dueOn: null,
          value: 80,
        },
      ],
      'percent',
    );
    expect(csv).toContain('"\'=HYPERLINK(""unsafe"")"');
    expect(csv).toContain('/planner?scope=goals&goal=one');
    expect(csv).toContain('Value (percent)');
  });
});
