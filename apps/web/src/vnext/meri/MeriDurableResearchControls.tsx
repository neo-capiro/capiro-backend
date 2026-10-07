import { useEffect, useMemo, useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { isMeriDurableTerminal } from '../../components/chat/meri-durable-research.js';
import { MeriJobDeliverables } from './MeriJobDeliverables.js';
import { useMeriDurableResearch } from './useMeriDurableResearch.js';

function outcomeLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

/** Release D: how often a job waiting on an approval card re-checks its state. */
export const APPROVAL_WAIT_REFRESH_MS = 15_000;

export function MeriDurableResearchControls({
  controller,
  researchId,
  onOpenApprovals,
}: {
  controller: MeriChatController;
  researchId: string | null;
  /** Opens the Approvals panel, where the job's card is approved or dismissed. */
  onOpenApprovals?: () => void;
}) {
  const durable = useMeriDurableResearch(researchId, controller.authHeaders);
  const [direction, setDirection] = useState('');
  const snapshot = durable.snapshot;

  useEffect(() => setDirection(''), [researchId, controller.authHeaders]);

  const currentSteps = useMemo(
    () =>
      snapshot?.coordinator.steps.filter(
        (step) => step.goalRevision === snapshot.coordinator.goalRevision,
      ) ?? [],
    [snapshot],
  );
  // A posted, undecided proposal card on a current approval step (Release D).
  const approvalWaiting = currentSteps.some(
    (step) =>
      step.outcome === 'waiting_for_approval' &&
      step.operationRefs.some((ref) => /^proposal:[^:]+$/.test(ref)),
  );
  const { refresh } = durable;
  useEffect(() => {
    if (!approvalWaiting) return;
    const timer = setInterval(() => void refresh(), APPROVAL_WAIT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [approvalWaiting, refresh]);
  if (!researchId || (!snapshot && !durable.error)) return null;

  if (!snapshot) {
    return (
      <section className="vnext-meri__durable-controls" aria-label="Durable research task">
        <p className="vnext-meri__durable-error" role="alert">
          {durable.error}
        </p>
      </section>
    );
  }

  const runStatus =
    snapshot.run?.status ??
    (snapshot.coordinator.cancellation.state === 'observed' ? 'cancelled' : 'complete');
  const terminal = !snapshot.run || isMeriDurableTerminal(runStatus);
  const stopping =
    runStatus === 'cancel_requested' || snapshot.coordinator.cancellation.state === 'requested';
  const completed = currentSteps.filter((step) => step.outcome === 'completed').length;
  const priorEffects = snapshot.coordinator.steps.filter(
    (step) => step.outcome === 'completed' && (step.sourceRefs.length || step.operationRefs.length),
  );
  const mayReconnect =
    snapshot.run?.status === 'interrupted' &&
    snapshot.run.readyToStart === true &&
    controller.researchRecovery?.id === researchId;

  const sendDirection = async () => {
    const accepted = await durable.sendSteering(direction);
    if (accepted) setDirection('');
  };

  return (
    <section className="vnext-meri__durable-controls" aria-label="Durable research task">
      <div className="vnext-meri__durable-head">
        <div>
          <span className="vnext-meri__durable-kicker">DURABLE RESEARCH TASK</span>
          <h3>{snapshot.coordinator.goal.objective}</h3>
        </div>
        <span
          className={`vnext-meri__durable-status is-${terminal && approvalWaiting ? 'waiting_for_approval' : runStatus}`}
        >
          {stopping
            ? 'Stopping…'
            : terminal && approvalWaiting
              ? 'approval needed'
              : outcomeLabel(runStatus)}
        </span>
      </div>

      <div className="vnext-meri__durable-meta">
        <span>Goal revision {snapshot.coordinator.goalRevision}</span>
        <span>Plan {snapshot.coordinator.planVersion}</span>
        <span>
          {completed} of {currentSteps.length} current steps complete
        </span>
      </div>
      <p className="vnext-meri__durable-stage" role="status">
        {stopping
          ? 'Cancel requested. Waiting for the worker to confirm termination.'
          : (snapshot.run?.stage ?? 'The durable research task is complete.')}
      </p>
      {terminal && approvalWaiting ? (
        <div className="vnext-meri__durable-approval" role="status">
          <p>
            Approval needed. Meri prepared an action from this task; nothing happens until you
            approve it.
          </p>
          {onOpenApprovals ? (
            <button type="button" className="vnext-meri__durable-send" onClick={onOpenApprovals}>
              Review it
            </button>
          ) : null}
        </div>
      ) : null}
      {terminal ? (
        <MeriJobDeliverables
          researchId={researchId}
          authHeaders={controller.authHeaders}
          refreshKey={runStatus}
        />
      ) : null}
      {runStatus === 'running' ? (
        <p className="vnext-meri__durable-background">
          This durable task continues in the background if you close or leave this thread.
        </p>
      ) : null}

      {snapshot.coordinator.goal.constraints.length > 0 ? (
        <p className="vnext-meri__durable-constraints">
          <strong>Current constraints:</strong> {snapshot.coordinator.goal.constraints.join(' · ')}
        </p>
      ) : null}

      {currentSteps.length > 0 ? (
        <ol className="vnext-meri__durable-steps" aria-label="Durable task progress">
          {currentSteps.map((step) => (
            <li key={`${step.goalRevision}:${step.id}`}>
              <span>{step.objective}</span>
              <small>{outcomeLabel(step.outcome)}</small>
            </li>
          ))}
        </ol>
      ) : null}

      {priorEffects.length > 0 ? (
        <details className="vnext-meri__durable-effects">
          <summary>Committed work remains visible ({priorEffects.length})</summary>
          <ul>
            {priorEffects.map((step) => (
              <li key={`effect:${step.goalRevision}:${step.id}`}>
                {step.objective}
                {step.sourceRefs.length ? ` · ${step.sourceRefs.length} source receipt(s)` : ''}
                {step.operationRefs.length
                  ? ` · ${step.operationRefs.length} operation receipt(s)`
                  : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {durable.acceptedDirection ? (
        <p className="vnext-meri__durable-accepted" role="status">
          Direction accepted. Goal revision {durable.acceptedDirection.goalRevision} is{' '}
          {durable.acceptedDirection.state === 'applied'
            ? 'applied.'
            : 'queued for the next safe boundary.'}
        </p>
      ) : null}
      {durable.steeringConflictRevision !== null ? (
        <p className="vnext-meri__durable-error" role="alert">
          The goal changed to revision {durable.steeringConflictRevision}. The task was refreshed;
          review your direction and press Send again.
        </p>
      ) : null}
      {durable.error ? (
        <p className="vnext-meri__durable-error" role="alert">
          {durable.error}
        </p>
      ) : null}

      {!terminal && !stopping ? (
        <div className="vnext-meri__durable-steer">
          <label htmlFor={`meri-steer-${researchId}`}>Update the research direction</label>
          <textarea
            id={`meri-steer-${researchId}`}
            value={direction}
            rows={2}
            maxLength={4000}
            disabled={durable.steeringSending}
            placeholder="Add a constraint, change emphasis, or revise the deliverable…"
            onChange={(event) => setDirection(event.target.value)}
          />
          <div className="vnext-meri__durable-actions">
            <button
              type="button"
              className="vnext-meri__durable-send"
              disabled={!direction.trim() || durable.steeringSending}
              onClick={() => void sendDirection()}
            >
              {durable.steeringSending
                ? 'Sending…'
                : durable.steeringTransportUncertain
                  ? 'Retry same direction'
                  : 'Send direction'}
            </button>
            <button
              type="button"
              className="vnext-meri__durable-stop"
              disabled={stopping}
              onClick={controller.handleStop}
            >
              Stop
            </button>
          </div>
        </div>
      ) : null}

      {stopping ? (
        <button type="button" className="vnext-meri__durable-stop" disabled>
          Stopping…
        </button>
      ) : null}
      {mayReconnect ? (
        <button
          type="button"
          className="vnext-meri__durable-send"
          disabled={controller.isStreaming}
          onClick={() => void controller.resumeResearch()}
        >
          Reconnect to this run
        </button>
      ) : null}
    </section>
  );
}
