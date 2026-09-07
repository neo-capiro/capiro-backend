import {
  mayResumeResearch,
  researchRecoveryLabel,
  type MeriRecoveredResearch,
} from '../../components/chat/meri-research-recovery.js';

export function MeriResearchRecovery({
  research,
  error,
  busy,
  onResume,
  onStop,
}: {
  research: MeriRecoveredResearch | null | undefined;
  error: string | null | undefined;
  busy: boolean;
  onResume: () => void;
  onStop: () => void;
}) {
  if (!research) return error ? <p role="status">{error}</p> : null;
  if (research.run.phase === 'research' && research.run.status === 'complete' && !error)
    return null;
  const resumable =
    mayResumeResearch(research.run) ||
    (research.run.status === 'awaiting_clarification' && research.questions.length === 0);
  return (
    <div className="vnext-meri__research-offer" aria-label="Saved research">
      <p role="status">
        {error ||
          (research.run.status === 'awaiting_clarification' && research.questions.length === 0
            ? 'Your research plan is ready to continue.'
            : researchRecoveryLabel(research.run))}
      </p>
      {resumable ? (
        <button
          type="button"
          className="vnext-meri__research-offer-btn"
          onClick={onResume}
          disabled={busy}
        >
          Resume research
        </button>
      ) : null}
      {research.run.status === 'running' ? (
        <button
          type="button"
          className="vnext-meri__research-offer-btn"
          onClick={onStop}
          disabled={busy}
        >
          Stop research
        </button>
      ) : null}
    </div>
  );
}
