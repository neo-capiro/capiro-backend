import { useState } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeToday,
  type PlannerBootstrap,
  type PlannerProject,
} from '@capiro/strategy-verifier';
import { usePlannerMutations, plannerError } from './planner-api.js';
import { importPlannerCsv, plannerCsvTimeLabel, type PlannerCsvTask } from './planner-csv.js';
export function PlannerImport({
  bootstrap,
  project,
  onClose,
}: {
  bootstrap: PlannerBootstrap;
  project?: PlannerProject;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<(PlannerCsvTask & { importKey: string })[]>([]);
  const options = bootstrap.timeOptions ?? PLANNER_DEFAULT_TIME_OPTIONS;
  const [timeZone] = useState(options.timeZone);
  const [workedOn, setWorkedOn] = useState(() => plannerTimeToday(options.timeZone));
  const hasTime = tasks.some((t) => t.importedActualMinutes > 0);
  const [error, setError] = useState<unknown>();
  const [completed, setCompleted] = useState(0);
  const [running, setRunning] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const actions = usePlannerMutations();
  const run = async () => {
    setError(null);
    setRunning(true);
    setAttempted(true);
    try {
      for (let i = completed; i < tasks.length; i++) {
        const { importKey, importedActualMinutes, ...data } = tasks[i]!;
        await actions.importTask.mutateAsync({
          importKey,
          data,
          actualMinutes: importedActualMinutes,
          ...(hasTime ? { time: { workedOn, timeZone } } : {}),
        });
        setCompleted(i + 1);
      }
    } catch (error) {
      setError(error);
    } finally {
      setRunning(false);
    }
  };
  return (
    <ModalOverlay
      isOpen
      isDismissable={!running}
      onOpenChange={(open) => !open && !running && onClose()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label="Import tasks">
          <div className="planner-dialog-head">
            <Heading slot="title">Import tasks</Heading>
            <button disabled={running} onClick={onClose}>
              Close
            </button>
          </div>
          <div className="planner-dialog-body">
            <p>
              Import up to 100 tasks into {project?.name ?? 'your personal tasks'}. Dates use
              YYYY-MM-DD; optional times use HH:mm and an IANA time zone such as America/New_York.
              Columns: Task, Description, Assignee, Start date, Due date, Start time, Due time, Time
              zone, Priority, Status, Section, Estimated time, Actual time. Time values accept
              hh:mm, 1hr 30min, 1h 30m, or a number of hours; fractional hours round to the nearest
              minute.
            </p>
            <label className="planner-field">
              <span>CSV file</span>
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={running || attempted}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setError(null);
                  setTasks([]);
                  try {
                    if (file.size > 2_000_000) throw new Error('Choose a CSV smaller than 2 MB.');
                    setTasks(
                      importPlannerCsv(await file.text(), bootstrap.people, project).map((t) => ({
                        ...t,
                        importKey: crypto.randomUUID(),
                      })),
                    );
                    setCompleted(0);
                  } catch (error) {
                    setError(error);
                  }
                }}
              />
            </label>
            {Boolean(error) && (
              <p role="alert" className="planner-error">
                {plannerError(error)}
              </p>
            )}
            {tasks.length > 0 && (
              <>
                <h3>{tasks.length} tasks ready to import</h3>
                {hasTime && (
                  <>
                    <p>
                      Actual time totals will be logged by you on the selected work date in{' '}
                      {timeZone}, using the organization’s billable default. They do not recreate
                      the source’s daily time history. Each imported entry can be corrected or
                      removed in the task.
                    </p>
                    <label className="planner-field">
                      <span>Work date for imported time</span>
                      <input
                        aria-label="Work date for imported time"
                        type="date"
                        value={workedOn}
                        disabled={running || attempted}
                        onInput={(e) => setWorkedOn(e.currentTarget.value)}
                        onChange={(e) => setWorkedOn(e.currentTarget.value)}
                      />
                    </label>
                  </>
                )}
                <table className="planner-import-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Assignee</th>
                      <th>Due date</th>
                      <th>Estimated time</th>
                      <th>Actual time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.slice(0, 20).map((t, i) => (
                      <tr key={i}>
                        <td>{t.name}</td>
                        <td>
                          {bootstrap.people.find((p) => p.id === t.assigneeId)?.name ??
                            'Unassigned'}
                        </td>
                        <td>{t.dueOn ?? '—'}</td>
                        <td>{plannerCsvTimeLabel(t.estimateMinutes)}</td>
                        <td>{plannerCsvTimeLabel(t.importedActualMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tasks.length > 20 && <p>Preview shows the first 20 rows.</p>}
                <p role="status">
                  {completed} of {tasks.length} created{running ? '…' : ''}
                </p>
              </>
            )}
          </div>
          <footer className="planner-dialog-footer">
            <button disabled={running} onClick={onClose}>
              {completed === tasks.length && completed > 0 ? 'Done' : 'Cancel'}
            </button>
            <button
              className="planner-primary"
              disabled={
                !tasks.length || running || completed === tasks.length || (hasTime && !workedOn)
              }
              onClick={() => void run()}
            >
              {running
                ? 'Importing…'
                : completed
                  ? 'Resume remaining import'
                  : 'Import reviewed tasks'}
            </button>
          </footer>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
