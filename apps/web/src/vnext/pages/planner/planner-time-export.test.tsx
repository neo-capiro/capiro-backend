import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannerTimeExportEntry, PlannerTimeExportPage } from '@capiro/strategy-verifier';
import {
  PlannerTimeExportButton,
  plannerLoadTimeRange,
  plannerTimeRangeCsv,
} from './planner-time-export.js';
const mocks = vi.hoisted(() => ({ get: vi.fn(), scope: 'org-one' }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: mocks.get }) }));
vi.mock('./planner-api.js', () => ({
  usePlannerKey: () => ['planner', mocks.scope, 'owner'],
  plannerError: String,
}));
const entry = (id = 'entry-one'): PlannerTimeExportEntry => ({
  id,
  actorId: 'owner',
  submitterName: 'Jamie Lee',
  taskId: 'task-one',
  projectId: null,
  kind: 'time',
  text: 'Work',
  minutes: 90,
  createdAt: '2026-10-07T12:00:00Z',
  version: 1,
  time: {
    workedOn: '2026-10-07',
    timeZone: 'America/New_York',
    billable: true,
    projectId: 'project-one',
    category: 'Delivery',
  },
  taskName: 'Launch',
  taskStatus: 'Completed',
  projectName: 'Product',
  canEdit: false,
});
const page = (): PlannerTimeExportPage => ({
  fromOn: '2026-10-05',
  throughOn: '2026-10-11',
  revision: 'a'.repeat(64),
  matched: 1,
  totalMinutes: 90,
  billableMinutes: 90,
  unavailableEntries: false,
  items: [entry()],
  nextCursor: null,
});
let create: ReturnType<typeof vi.fn>, click: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue({ data: page() });
  mocks.scope = 'org-one';
  create = vi.fn(() => 'blob:time-export');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const node = (scope: 'personal' | 'review' | 'project' | 'organization' = 'personal') => (
  <PlannerTimeExportButton
    target={
      scope === 'personal'
        ? { scope, userId: 'owner' }
        : scope === 'project'
          ? { scope, projectId: 'project-one' }
          : { scope }
    }
    week="2026-10-05"
    label="Chosen time"
  />
);
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Export date range' }));
describe('Complete time range CSV and cancellation', () => {
  it('loads all pages and makes a final revision check before returning complete entries', async () => {
    const first = { ...page(), matched: 3, items: [entry('one'), entry('two')], nextCursor: 'two' };
    const load = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...first, items: [entry('three')], nextCursor: null })
      .mockResolvedValueOnce(first);
    expect((await plannerLoadTimeRange(load)).items.map((e) => e.id)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(load.mock.calls).toEqual([
      [],
      [{ cursor: 'two', revision: first.revision }],
      [{ revision: first.revision }],
    ]);
  });
  it('abandons exports after access or revision changes, including a change after the last page', async () => {
    const first = { ...page(), nextCursor: 'one', matched: 2 };
    await expect(
      plannerLoadTimeRange(
        vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(Error('Access revoked')),
      ),
    ).rejects.toThrow('Access revoked');
    await expect(
      plannerLoadTimeRange(
        vi
          .fn()
          .mockResolvedValueOnce(page())
          .mockResolvedValueOnce({ ...page(), revision: 'changed' }),
      ),
    ).rejects.toThrow('Time changed');
  });
  it('rejects repeating cursors, duplicate rows and incomplete pages', async () => {
    await expect(
      plannerLoadTimeRange(vi.fn().mockResolvedValue({ ...page(), nextCursor: 'one' })),
    ).rejects.toThrow('pagination repeated');
    await expect(
      plannerLoadTimeRange(
        vi.fn().mockResolvedValue({ ...page(), matched: 2, items: [entry(), entry()] }),
      ),
    ).rejects.toThrow('incomplete');
    await expect(
      plannerLoadTimeRange(vi.fn().mockResolvedValue({ ...page(), matched: 3 })),
    ).rejects.toThrow('incomplete');
  });
  it('includes exact attribution and status and escapes formulas, quotes and multiline descriptions', () => {
    const csv = plannerTimeRangeCsv([
      {
        ...entry(),
        taskName: '=HYPERLINK("bad")',
        text: 'line one\nline "two"',
        submitterName: '+Jamie',
      },
    ]);
    expect(csv).toContain('"Task ID","Project ID","Task status","Entry ID"');
    expect(csv).toContain(
      '"\'=HYPERLINK(""bad"")","1.5","2026-10-07","\'+Jamie","task-one","project-one","Completed","entry-one"',
    );
    expect(csv).toContain('"line one\nline ""two"""');
  });
  it.each(['personal', 'review', 'project', 'organization'] as const)(
    'downloads %s time for native date input changes only after final verification',
    async (scope) => {
      render(node(scope));
      open();
      fireEvent.input(screen.getByLabelText('Export from date'), {
        target: { value: '2026-10-01' },
      });
      fireEvent.change(screen.getByLabelText('Export through date'), {
        target: { value: '2026-10-31' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(mocks.get).toHaveBeenCalledTimes(2);
      expect(mocks.get.mock.calls[0]?.[1]?.params).toMatchObject({
        scope,
        fromOn: '2026-10-01',
        throughOn: '2026-10-31',
      });
      expect(mocks.get.mock.calls[1]?.[1]?.params.revision).toBe(page().revision);
      expect(await screen.findByRole('status')).toHaveTextContent('Exported 1 entries.');
    },
  );
  it('keeps invalid ranges editable and downloads no file on failed final access checks', async () => {
    render(node());
    open();
    fireEvent.change(screen.getByLabelText('Export through date'), {
      target: { value: '2026-10-01' },
    });
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Export through date'), {
      target: { value: '2026-10-31' },
    });
    mocks.get
      .mockResolvedValueOnce({ data: page() })
      .mockRejectedValueOnce(Error('Time or access changed'));
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Time or access changed');
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['scope', 'unmount', 'cancel'] as const)(
    'aborts unfinished work on %s without a late download',
    async (mode) => {
      let finish!: (value: unknown) => void;
      mocks.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const ui = render(node());
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
      const signal = mocks.get.mock.calls[0]?.[1]?.signal as AbortSignal;
      if (mode === 'scope') {
        mocks.scope = 'org-two';
        ui.rerender(node());
      } else if (mode === 'unmount') ui.unmount();
      else fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));
      expect(signal.aborted).toBe(true);
      // Simulate a late transport response despite cancellation, followed by verification.
      mocks.get.mockResolvedValue({ data: page() });
      await act(async () => {
        finish({ data: page() });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
});
