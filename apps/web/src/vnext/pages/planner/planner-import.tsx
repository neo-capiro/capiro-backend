import { useState } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import type { PlannerBootstrap, PlannerProject, PlannerTaskData } from '@capiro/strategy-verifier';
import { usePlannerMutations, plannerError } from './planner-api.js';
import { importPlannerCsv } from './planner-csv.js';
export function PlannerImport({
  bootstrap,
  project,
  onClose,
}: {
  bootstrap: PlannerBootstrap;
  project?: PlannerProject;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<PlannerTaskData[]>([]);
  const [error, setError] = useState<unknown>();
  const [completed, setCompleted] = useState(0);
  const [running, setRunning] = useState(false);
  const actions = usePlannerMutations();
  const run = async () => {
    setError(null);
    setRunning(true);
    try {
      for (let i = completed; i < tasks.length; i++) {
        await actions.task.mutateAsync({ data: tasks[i]! });
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
              YYYY-MM-DD. Columns: Task, Description, Assignee, Start date, Due date, Priority,
              Status, Section.
            </p>
            <label className="planner-field">
              <span>CSV file</span>
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={running || completed > 0}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setError(null);
                  setTasks([]);
                  try {
                    if (file.size > 2_000_000) throw new Error('Choose a CSV smaller than 2 MB.');
                    setTasks(importPlannerCsv(await file.text(), bootstrap.people, project));
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
                <table className="planner-import-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Assignee</th>
                      <th>Due date</th>
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
              disabled={!tasks.length || running || completed === tasks.length}
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
