import { useEffect, useRef, useState } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import {
  plannerCalendarDate,
  plannerWeekDate,
  type PlannerTimeExportEntry,
  type PlannerTimeExportPage,
} from '@capiro/strategy-verifier';
import { useApi } from '../../../lib/use-api.js';
import { plannerError, usePlannerKey } from './planner-api.js';
import { plannerCsvCell } from './planner-csv.js';

type Target =
  | { scope: 'personal'; userId: string }
  | { scope: 'review' }
  | { scope: 'organization' }
  | { scope: 'project'; projectId: string };
export function plannerTimeRangeCsv(entries: PlannerTimeExportEntry[]) {
  return [
    [
      'Task',
      'Hours',
      'Work date',
      'Submitter',
      'Task ID',
      'Project ID',
      'Task status',
      'Entry ID',
      'Project',
      'Minutes',
      'Billable',
      'Category',
      'Time zone',
      'Description',
      'Submitter ID',
      'Edited by ID',
    ],
    ...entries.map((e) => [
      e.taskName,
      (e.minutes ?? 0) / 60,
      e.time.workedOn,
      e.submitterName,
      e.taskId,
      e.time.projectId,
      e.taskStatus,
      e.id,
      e.projectName,
      e.minutes,
      e.time.billable ? 'Yes' : 'No',
      e.time.category,
      e.time.timeZone,
      e.text,
      e.actorId,
      e.editedBy,
    ]),
  ]
    .map((row) => row.map(plannerCsvCell).join(','))
    .join('\r\n');
}
/** Start fresh, consume every page and verify the full revision immediately before downloading. */
export async function plannerLoadTimeRange(
  load: (paging?: { cursor?: string; revision: string }) => Promise<PlannerTimeExportPage>,
) {
  const first = await load(),
    entries = [...first.items],
    cursors = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor) {
    if (cursors.has(cursor)) throw Error('Time export pagination repeated');
    cursors.add(cursor);
    const page = await load({ cursor, revision: first.revision });
    if (page.revision !== first.revision || page.matched !== first.matched)
      throw Error('Time changed during export');
    entries.push(...page.items);
    cursor = page.nextCursor;
  }
  if (entries.length !== first.matched || new Set(entries.map((e) => e.id)).size !== first.matched)
    throw Error('Time export is incomplete. Start a new export.');
  const verified = await load({ revision: first.revision });
  if (verified.revision !== first.revision || verified.matched !== first.matched)
    throw Error('Time changed during export');
  return { ...first, items: entries };
}
export function PlannerTimeExportButton({
  target,
  week,
  label,
  buttonLabel = 'Export date range',
}: {
  target: Target;
  week: string;
  label: string;
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {buttonLabel}
      </button>
      {open && (
        <PlannerTimeExportDialog
          target={target}
          week={week}
          label={label}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function PlannerTimeExportDialog({
  target,
  week,
  label,
  onClose,
}: {
  target: Target;
  week: string;
  label: string;
  onClose: () => void;
}) {
  const api = useApi(),
    scope = JSON.stringify(usePlannerKey()),
    selection = JSON.stringify(target);
  const [fromOn, setFromOn] = useState(week),
    [throughOn, setThroughOn] = useState(plannerWeekDate(week, 6));
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setPending(false);
    setError(null);
    setMessage('');
    return () => controller.current?.abort();
  }, [scope, selection, fromOn, throughOn]);
  const valid =
    plannerCalendarDate(fromOn) && plannerCalendarDate(throughOn) && fromOn <= throughOn;
  const download = async () => {
    if (!valid || pending) return;
    const active = new AbortController();
    controller.current = active;
    setPending(true);
    setError(null);
    setMessage('');
    try {
      const result = await plannerLoadTimeRange(
        async (paging) =>
          (
            await api.get<PlannerTimeExportPage>('/strategy-api/planner/time/entries', {
              params: { ...target, fromOn, throughOn, ...paging },
              signal: active.signal,
            })
          ).data,
      );
      if (active.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([plannerTimeRangeCsv(result.items)], { type: 'text/csv;charset=utf-8;' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `planner-time-${target.scope}-${fromOn}-${throughOn}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        `Exported ${result.matched} entries.${result.unavailableEntries ? ' Some work is unavailable under your current access.' : ''}`,
      );
    } catch (e) {
      if (!active.signal.aborted) setError(e);
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setPending(false);
      }
    }
  };
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label="Export time entries">
          <header className="planner-dialog-head">
            <Heading slot="title">Export time entries</Heading>
            <button type="button" aria-label="Close Export time entries" onClick={onClose}>
              ×
            </button>
          </header>
          <div className="planner-dialog-body">
            <p>{label}</p>
            <p>
              Export entries for these work dates, including corrections, billable time and task and
              project IDs. The file includes work you can currently access.
            </p>
            <div className="planner-config-grid">
              <label className="planner-field">
                <span>From</span>
                <input
                  type="date"
                  aria-label="Export from date"
                  value={fromOn}
                  disabled={pending}
                  onInput={(e) => setFromOn(e.currentTarget.value)}
                  onChange={(e) => setFromOn(e.currentTarget.value)}
                />
              </label>
              <label className="planner-field">
                <span>Through</span>
                <input
                  type="date"
                  aria-label="Export through date"
                  value={throughOn}
                  disabled={pending}
                  onInput={(e) => setThroughOn(e.currentTarget.value)}
                  onChange={(e) => setThroughOn(e.currentTarget.value)}
                />
              </label>
            </div>
            {!valid && <p role="alert">Choose valid dates with the start before the end.</p>}
            {error != null && (
              <p role="alert" className="planner-error">
                {plannerError(error)}
              </p>
            )}
            {message && <p role="status">{message}</p>}
            <div className="planner-actions">
              {pending ? (
                <button type="button" onClick={() => controller.current?.abort()}>
                  Cancel export
                </button>
              ) : (
                <button type="button" disabled={!valid} onClick={() => void download()}>
                  Download CSV
                </button>
              )}
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
