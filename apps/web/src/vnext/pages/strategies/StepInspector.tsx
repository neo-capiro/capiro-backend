/*
 * Step inspector — ?step=:stepId (STRATEGIES-HANDOFF §7.4).
 *
 * One inspector, two tabs (Step · Meri) — one selection model (§4.1 #3).
 *
 * Governance (§7.4 must-nots, §11):
 *  - Meri can apply edits to the working plan. Meri-authored additions begin as
 *    Suggested; a person reviews them here and explicitly promotes them before
 *    they can appear in a client-ready export.
 *  - "Prepare in Workspace" / "Stage outreach" create STAGED records only; neither
 *    sends anything externally (Stage H gates the send path — §7.9).
 *  - Dismiss suppresses a suggestion until the step changes.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroButton, CapiroIconButton } from '../../components/actions/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import {
  memberName,
  useAssistant,
  useCreateMission,
  useMissions,
  usePlanExecution,
  useExecutionPreflight,
  useUpdateMission,
  useDismissContextGap,
  useRecordArtifact,
  useStrategyConversation,
  useTenantMembers,
  useUpdateNode,
} from './strategies-api.js';
import { EXECUTION_MISSION_NAME, findExecutionMission } from '../../../pages/strategy/agents/agent-utils.js';
import type { ArtifactType, StrategyNode, StrategyNodeArtifact } from '../../../pages/strategy/types.js';
import {
  CLIENT_EXPORT_READY_STATUSES,
  clientExportStatusLabel,
  isClientExportReadyStatus,
  type ClientExportReadyStatus,
} from './lib/step-review.js';
import { StepDetailsForm } from './StepDetailsForm.js';
import { strategyArtifactHref, strategyArtifactReference } from './lib/artifact-link.js';
import { errorMessage } from '../../../lib/error-message.js';
import './step-inspector.css';

const KIND_LABEL: Record<string, string> = {
  action: 'Action',
  gate: 'Gate',
  milestone: 'Milestone',
  decision: 'Decision',
  risk: 'Risk',
};

// Step-kind → pill tone (design handoff "Pill tone table" + "Step-kind table";
// strategies-tokens.css's purple note). `gate` has no modifier — the base
// `.st-pill` already IS the tone table's "gray" row. `decision` isn't in the
// handoff's step-kind table at all (strategies-tokens.css: it "keeps mapping
// to the accent-focus shade under the new ramp, same relative role it had
// under navy") and there's no dedicated pill bucket for it, so it shares
// Action's brand/accent tone rather than inventing a new one.
const KIND_PILL_TONE: Record<string, string> = {
  action: 'st-pill--accent',
  gate: '',
  milestone: 'st-pill--purple',
  decision: 'st-pill--accent',
  risk: 'st-pill--error',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_progress: 'In progress',
  internal_review: 'Internal review',
  active: 'Active',
  suggested: 'Suggested',
  completed: 'Completed',
};

// Status → pill tone. The design fixture varies its state-pill tone per
// literal fixture string ("In progress" reads brand, "Monitoring"/"Proposed"
// read warning, "Not started"/"Staged" read gray) rather than by our actual
// five-value NodeStatus enum, so this reapplies that same pattern onto the
// real enum: in-progress mirrors the fixture's brand "In progress", suggested
// (an unreviewed AI proposal) and internal_review (a pending gate) read as
// warning like the fixture's "Proposed"/"Monitoring" states, active reads
// success, and draft is the tone table's default gray.
const STATUS_PILL_TONE: Record<string, string> = {
  draft: '',
  in_progress: 'st-pill--accent',
  internal_review: 'st-pill--warning',
  active: 'st-pill--success',
  completed: 'st-pill--success',
  suggested: 'st-pill--warning',
};

/*
 * Local "send" glyph (composer send action). The shared icon set
 * (../../components/icons/index.tsx) has no send/paper-plane entry, and
 * adding one there is out of scope for this pass — that file may be touched
 * by another concurrent Strategies agent. Mirrors StrategiesModalShell.tsx's
 * own CloseGlyph precedent for the identical situation: a small,
 * self-contained, view-local glyph matching the shared set's stroke
 * conventions (24x24 viewBox, currentColor, 1.75 stroke, round caps/joins).
 */
function SendGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12h15.5M13 5.5L19.5 12 13 18.5" />
    </svg>
  );
}

/*
 * Grounded-prompt suggestion chips (§7.4 spec: a small set of suggested
 * prompts near the composer). Generic and step-agnostic by design so the
 * same three read sensibly whether a step is open or this is the
 * strategy-level thread.
 */
const SUGGESTED_PROMPTS = [
  'What evidence is missing before the next gate?',
  'Which steps still need an owner?',
  'Draft the next update from approved facts only.',
];

export function StepInspector({
  strategyId,
  clientId,
  nodes = [],
  artifacts = [],
  step,
  isNew,
  tab,
  onTabChange,
  onClose,
}: {
  strategyId: string;
  clientId?: string;
  nodes?: StrategyNode[];
  artifacts?: StrategyNodeArtifact[];
  step: StrategyNode | null;
  isNew: boolean;
  tab: 'step' | 'meri';
  onTabChange: (tab: 'step' | 'meri') => void;
  onClose: () => void;
}) {
  const members = useTenantMembers();

  // Composer (input + send + its draft state), lifted out of MeriTab so it
  // stays mounted — and the draft survives — across Step/Meri tab switches.
  // Previously this lived entirely inside MeriTab: switching to the Step tab
  // unmounted it, and switching back remounted a fresh, empty draft (a real
  // behavioral regression, not just a visual one).
  const nodeId = step?.id ?? null;
  const assistant = useAssistant(strategyId);
  const [draft, setDraft] = useState('');
  const sending = useRef(false);
  const sendAttempt = useRef<{ instruction: string; clientMessageId: string } | null>(null);

  const send = (text?: string) => {
    const instruction = (text ?? draft).trim();
    if (!instruction || assistant.isPending || sending.current) return;
    const attempt = sendAttempt.current?.instruction === instruction ? sendAttempt.current : { instruction, clientMessageId: globalThis.crypto.randomUUID() };
    sendAttempt.current = attempt;
    sending.current = true;
    onTabChange('meri');
    assistant.mutate({
      scope: nodeId ? 'node' : 'strategy',
      nodeId: nodeId ?? undefined,
      instruction,
      clientMessageId: attempt.clientMessageId,
    }, {
      onSuccess: () => {
        if (sendAttempt.current?.clientMessageId === attempt.clientMessageId) sendAttempt.current = null;
        // Preserve text typed while a request was in flight and keep failed drafts retryable.
        if (text === undefined) setDraft((current) => current.trim() === instruction ? '' : current);
      },
      onSettled: () => { sending.current = false; },
    });
  };

  return (
    <aside className="st-inspector" aria-label="Step inspector">
      <div className="st-inspector__head">
        <div>
          <p className="st-eyebrow">{isNew ? 'New step' : step ? 'Selected step' : 'Strategy assistant'}</p>
          <h2 className="st-inspector__title">{isNew ? 'Add a step' : step?.title ?? 'Ask Meri'}</h2>
        </div>
        <button type="button" className="st-inspector__close" aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="st-inspector__tabs" role="tablist" aria-label="Inspector tabs">
        <button
          role="tab"
          aria-selected={tab === 'step'}
          className={tab === 'step' ? 'is-active' : ''}
          onClick={() => onTabChange('step')}
          disabled={!step && !isNew}
        >
          Step
        </button>
        <button
          role="tab"
          aria-selected={tab === 'meri'}
          className={tab === 'meri' ? 'is-active' : ''}
          onClick={() => onTabChange('meri')}
        >
          Meri
        </button>
      </div>

      {step || isNew ? (
        <div hidden={tab !== 'step'}>
          <StepTab
            strategyId={strategyId}
            clientId={clientId}
            siblings={nodes}
            artifacts={artifacts.filter((artifact) => artifact.nodeId === step?.id)}
            onClose={onClose}
            step={step}
            isNew={isNew}
            ownerName={step ? memberName(members.data, step.ownerUserId) : 'Unassigned'}
          />
        </div>
      ) : null}
      {tab === 'meri' ? <MeriTab strategyId={strategyId} step={step} /> : null}

      {/* Composer pinned across tabs: rendered once, outside the tab ternary
          above, so it never unmounts on a tab switch. Sticky to the bottom of
          the inspector's own scrollport (step-inspector.css: .st-inspector is
          the overflow-y:auto element). */}
      <div className="st-inspector__composer">
        <div className="st-meri-chips" role="group" aria-label="Suggested prompts">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="st-meri-chip"
              onClick={() => send(prompt)}
              disabled={assistant.isPending}
            >
              {prompt}
            </button>
          ))}
        </div>
        <div className="st-meri-composer">
          <CapiroInput
            label="Ask Meri"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (sendAttempt.current?.instruction !== e.target.value.trim()) sendAttempt.current = null;
            }}
            placeholder={`Ask Meri about this ${nodeId ? 'step' : 'strategy'}…`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <CapiroIconButton
            label="Send"
            icon={<SendGlyph />}
            className="st-meri-send"
            onClick={() => send()}
            disabled={!draft.trim() || assistant.isPending}
            aria-busy={assistant.isPending || undefined}
          />
        </div>
        {assistant.isError ? (
          <p className="st-modal__alert" role="alert">
            Meri could not respond. {errorMessage(assistant.error, 'Please try again.')}
          </p>
        ) : null}
        <p className="st-meri-hint">
          Meri can update the working plan. Review changed steps here, then mark
          them In progress or Active when they are ready for client reports.
        </p>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ Step tab */

function StepTab({
  clientId, siblings, artifacts, onClose,
  strategyId,
  step,
  isNew,
  ownerName,
}: {
  strategyId: string;
  clientId?: string;
  siblings: StrategyNode[];
  artifacts: StrategyNodeArtifact[];
  onClose: () => void;
  step: StrategyNode | null;
  isNew: boolean;
  ownerName: string;
}) {
  const navigate = useNavigate();
  const updateNode = useUpdateNode(strategyId);
  const [editing, setEditing] = useState(false);
  if (isNew || editing) {
    return <div className="st-inspector__body"><StepDetailsForm strategyId={strategyId} clientId={clientId} step={step} siblings={siblings} onDone={() => { if (isNew) onClose(); else setEditing(false); }} /></div>;
  }
  if (!step) {
    return <div className="st-inspector__body"><CapiroSkeleton height={200} /></div>;
  }
  const evidence = step.provenance?.sources ?? [];
  const clientExportReady = isClientExportReadyStatus(step.status);
  const pendingStatus = updateNode.isPending
    ? (updateNode.variables?.input.status as
        | ClientExportReadyStatus
        | undefined)
    : undefined;

  const markClientExportReady = (status: ClientExportReadyStatus) => {
    updateNode.mutate({
      nodeId: step.id,
      input: {
        status,
        changeNote:
          status === 'active'
            ? 'Reviewed and marked active for client reporting.'
            : 'Reviewed and marked in progress for client reporting.',
      },
    });
  };

  return (
    <div className="st-inspector__body">
      <div className="st-inspector__pills">
        <span className={`st-pill${KIND_PILL_TONE[step.kind] ? ` ${KIND_PILL_TONE[step.kind]}` : ''}`}>
          {KIND_LABEL[step.kind] ?? step.kind}
        </span>
        <span className={`st-pill${STATUS_PILL_TONE[step.status] ? ` ${STATUS_PILL_TONE[step.status]}` : ''}`}>
          {STATUS_LABEL[step.status] ?? step.status}
        </span>
      </div>

      <section
        className={`st-inspector__client-review${
          clientExportReady ? ' is-ready' : ''
        }`}
        aria-labelledby="step-client-export-heading"
        aria-live="polite"
      >
        <div className="st-inspector__client-review-head">
          <div>
            <p className="st-section-label" id="step-client-export-heading">
              Client export status
            </p>
            <strong>{clientExportStatusLabel(step.status)}</strong>
          </div>
          <span
            className={`st-pill${
              clientExportReady ? ' st-pill--success' : ' st-pill--warning'
            }`}
          >
            {STATUS_LABEL[step.status] ?? step.status}
          </span>
        </div>
        <p className="st-inspector__client-review-copy">
          {clientExportReady
            ? `This step is included in client-ready reports because it is ${
                STATUS_LABEL[step.status] ?? step.status
              }.`
            : 'Client-ready reports omit Suggested, Draft and Internal review steps. Review this step, then include it by marking it In progress or Active.'}
        </p>
        {!clientExportReady ? (
          <div
            className="st-inspector__client-review-actions"
            role="group"
            aria-label="Mark step ready for client reports"
          >
            {CLIENT_EXPORT_READY_STATUSES.map((status) => (
              <CapiroButton
                key={status}
                size="compact"
                variant={status === 'active' ? 'primary' : 'secondary'}
                disabled={updateNode.isPending}
                loading={pendingStatus === status}
                onClick={() => markClientExportReady(status)}
              >
                {status === 'active' ? 'Mark active' : 'Mark in progress'}
              </CapiroButton>
            ))}
          </div>
        ) : null}
        {updateNode.isError ? (
          <p className="st-inspector__client-review-error" role="alert">
            The status could not be updated.{' '}
            {(updateNode.error as Error)?.message || 'Please try again.'}
          </p>
        ) : null}
      </section>

      {step.note ? (
        <>
          <p className="st-section-label">Description</p>
          <p className="st-inspector__note">{step.note}</p>
        </>
      ) : null}

      <dl className="st-inspector__fields">
        <div><dt>Owner</dt><dd>{ownerName}</dd></div>
        <div>
          <dt>Window</dt>
          <dd>
            {formatDate(step.startsOn)} – {step.openEnded ? 'Open' : formatDate(step.endsOn ?? step.startsOn)}
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{evidence.length + artifacts.length > 0 ? `${evidence.length} sources · ${artifacts.length} linked outputs` : 'None attached'}</dd>
        </div>
      </dl>

      <CapiroButton onClick={() => setEditing(true)}>Edit step</CapiroButton>
      <p className="st-section-label">Linked outputs</p>
      {artifacts.length > 0 ? <ul className="st-inspector__evidence">{artifacts.map((artifact) => <li key={artifact.id}><a href={strategyArtifactHref(artifact.artifactType, artifact.artifactRef)}>{artifact.artifactType === 'workspace_draft' ? 'Open Workspace draft' : 'Open outreach record'}</a></li>)}</ul> : <p className="st-inspector__empty">No outputs linked yet.</p>}
      <p className="st-section-label">Evidence sources</p>
      {evidence.length === 0 ? (
        <p className="st-inspector__empty">No provenance sources recorded. Linked outputs are listed separately above.</p>
      ) : (
        <ul className="st-inspector__evidence">
          {evidence.map((s, i) => {
            // Stage E citation format (api-strategy meri.types.ts: Meri is
            // instructed to cite grounded steps with ref 'fact:<id>'). That's
            // the only shape with somewhere real to go — the Steward review's
            // existing ?fact=<id> deep-link (StewardReviewVNext.tsx) already
            // highlights the row and surfaces its source document, the same
            // mapping the canonical app's NodeRail.tsx uses for this identical
            // data shape. A non-fact ref (or none at all) has no id to
            // navigate to, so it stays inert, same as NodeRail's fallback.
            const factId = s.ref?.startsWith('fact:') ? s.ref.slice(5) : null;
            const open = () => {
              if (factId) navigate(`/strategies/context/steward?fact=${encodeURIComponent(factId)}`);
            };
            return (
              <li
                key={`${s.section}-${i}`}
                className={factId ? 'st-inspector__evidence-link' : undefined}
                onClick={factId ? open : undefined}
                onKeyDown={
                  factId
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          open();
                        }
                      }
                    : undefined
                }
                tabIndex={factId ? 0 : undefined}
                role={factId ? 'link' : undefined}
                aria-label={factId ? `Open ${s.section} in Steward review` : undefined}
              >
                <span className="st-inspector__evidence-title">{s.section}</span>
                {s.ref ? <span className="st-mono st-inspector__evidence-ref">{s.ref}</span> : null}
              </li>
            );
          })}
        </ul>
      )}

      <ExecutionActions strategyId={strategyId} step={step} onEdit={() => setEditing(true)} />

      <RecordArtifactSection strategyId={strategyId} step={step} />

      <MeriSuggestionCard strategyId={strategyId} step={step} />
    </div>
  );
}

/* ------------------------------------------------------- Workspace / outreach */

function ExecutionActions({ strategyId, step, onEdit }: { strategyId: string; step: StrategyNode; onEdit: () => void }) {
  const navigate = useNavigate();
  const missions = useMissions(strategyId, false);
  const createMission = useCreateMission();
  const updateMission = useUpdateMission();
  const plan = usePlanExecution();
  const readiness = useExecutionPreflight(strategyId, step.id, step.updatedAt);
  const stagingRef = useRef(false);
  const [staging, setStaging] = useState<'workspace' | 'outreach' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unavailableStatus = (readiness.error as { response?: { status?: number } } | null)?.response?.status;

  const stage = async (kind: 'workspace' | 'outreach') => {
    if (stagingRef.current || readiness.isFetching || !readiness.data?.[kind].eligible) return;
    stagingRef.current = true;
    setStaging(kind);
    setError(null);
    try {
      // Refresh the authoritative check before creating or activating a mission.
      const checked = await readiness.refetch();
      if (checked.isError || !checked.data) throw checked.error ?? new Error('Readiness could not be checked.');
      if (!checked.data[kind].eligible) throw new Error(checked.data[kind].reasons.map(readinessReason).join(' '));
      if (!checked.data.nodeUpdatedAt) throw new Error('This step has no current revision. Reload the strategy and try again.');
      // Always check current missions before creating one. A failed list is not an empty list.
      const result = await missions.refetch();
      if (result.isError || !result.data) throw result.error ?? new Error('Execution missions could not be loaded.');
      const mission = findExecutionMission(result.data, strategyId)
        ?? await createMission.mutateAsync({ strategyId, name: EXECUTION_MISSION_NAME });
      if (!mission) throw new Error('Could not prepare an execution mission.');
      if (mission.state !== 'active') {
        const activated = await updateMission.mutateAsync({ id: mission.id, input: { state: 'active' } });
        if (activated?.state !== 'active') throw new Error('The execution mission could not be activated.');
      }
      const run = await plan.mutateAsync({
        missionId: mission.id, strategyId, nodeId: step.id, kind,
        pinnedVersionId: checked.data.headVersionId ?? undefined,
        expectedNodeUpdatedAt: checked.data.nodeUpdatedAt,
      });
      if (!run) throw new Error('No execution plan was returned. Please try again.');
      // This only prepares the existing execution plan. Its review page shows any waiting reason.
      navigate(`/strategies/agents/runs?strategyId=${encodeURIComponent(strategyId)}`);
    } catch (err) {
      setError(errorMessage(err, 'The execution plan could not be prepared. Please try again.'));
    } finally {
      stagingRef.current = false;
      setStaging(null);
    }
  };

  return (
    <section aria-label="Preparation readiness" aria-live="polite">
      <p className="st-section-label">Prepare work</p>
      <p className="st-inspector__empty">Check this step’s requirements before preparing a draft for review.</p>
      {readiness.isLoading || readiness.isFetching ? <p>Checking readiness…</p> : null}
      {readiness.isError ? <div role="alert"><p>{unavailableStatus === 403 ? 'Preparation is unavailable for your team or account. Ask your team administrator.' : unavailableStatus === 404 ? 'This strategy or step is no longer available. Reload the strategy before preparing work.' : 'Readiness could not be checked. Try again before preparing work.'}</p><CapiroButton size="compact" onClick={() => void readiness.refetch()}>Retry readiness check</CapiroButton></div> : null}
      {readiness.data && !readiness.isError ? (['workspace', 'outreach'] as const).map((kind) => (
        <div key={kind}>
          <strong>{kind === 'workspace' ? 'Workspace draft' : 'Outreach record'}: {readiness.data[kind].eligible ? 'Ready to prepare' : 'Needs attention'}</strong>
          {readiness.data[kind].reasons.length ? <ul>{readiness.data[kind].reasons.map((reason) => <li key={reason}>{readinessReason(reason)}</li>)}</ul> : null}
        </div>
      )) : null}
      {readiness.data && (!readiness.data.workspace.eligible || !readiness.data.outreach.eligible) ? <CapiroButton size="compact" onClick={onEdit}>Update step details</CapiroButton> : null}
      <div className="st-inspector__actions">
        <CapiroButton disabled={staging !== null || readiness.isFetching || readiness.isError || !readiness.data?.workspace.eligible} loading={staging === 'workspace'} onClick={() => void stage('workspace')}>
          Prepare in Workspace
        </CapiroButton>
        <CapiroButton variant="primary" disabled={staging !== null || readiness.isFetching || readiness.isError || !readiness.data?.outreach.eligible} loading={staging === 'outreach'} onClick={() => void stage('outreach')}>
          Stage outreach
        </CapiroButton>
      </div>
      {error ? <p className="st-modal__alert" role="alert">{error}</p> : null}
    </section>
  );
}

/** Translate the canonical gate's technical field names for the planning team. */
function readinessReason(reason: string): string {
  if (reason.startsWith('node kind must')) return 'Choose Action as the step type to prepare a Workspace draft.';
  if (reason.startsWith('node subject must') && reason.includes('workspace execution')) return 'Choose Deliverable or Submission as the subject to prepare a Workspace draft.';
  if (reason.startsWith('node subject must') && reason.includes('outreach execution')) return 'Choose Member, Committee, or Agency as the subject to stage outreach.';
  if (reason.startsWith('node has no owner')) return 'Assign an owner in the step details.';
  if (reason.startsWith('node has no target date')) return 'Set a start date or deadline in the step details.';
  if (reason === 'caller has no workspace access') return 'Workspace access is required. Ask your team administrator.';
  if (reason.startsWith('strategy has') && reason.includes('open material conflict')) return 'Resolve conflicting information in Context review before preparing this work.';
  if (reason.startsWith('required client context is missing')) {
    return 'Upload the required client context (strategy brief and client constraints) in Context review before preparing this work.';
  }
  if (reason.startsWith('step is completed')) return 'Reopen this completed step before preparing more work.';
  return reason;
}

/* ------------------------------------------------------------ Meri suggestion */

function RecordArtifactSection({ strategyId, step }: { strategyId: string; step: StrategyNode }) {
  const recordArtifact = useRecordArtifact(strategyId);
  const [artifactType, setArtifactType] = useState<ArtifactType>('workspace_draft');
  const [artifactRef, setArtifactRef] = useState('');
  const [recorded, setRecorded] = useState(false);
  const parsedReference = strategyArtifactReference(artifactType, artifactRef, window.location.origin);

  const submit = () => {
    const ref = parsedReference;
    if (!ref || recordArtifact.isPending) return;
    setRecorded(false);
    recordArtifact.mutate(
      { nodeId: step.id, input: { artifactType, artifactRef: ref } },
      {
        onSuccess: () => {
          setArtifactRef('');
          setRecorded(true);
        },
      },
    );
  };

  return (
    <div className="st-inspector__artifact-section">
      <p className="st-section-label">Link existing work</p>
      <p className="st-inspector__empty" style={{ marginBottom: 8 }}>
        Open the existing Workspace draft or outreach record, copy its link, and paste it here to associate the work with this step. This links the work; it does not verify the claims inside it.
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
          Type
          <select
            value={artifactType}
            onChange={(e) => { setArtifactType(e.target.value as ArtifactType); setRecorded(false); }}
            disabled={recordArtifact.isPending}
            style={{ fontSize: 12 }}
          >
            <option value="workspace_draft">Workspace draft</option>
            <option value="outreach_record">Outreach record</option>
          </select>
        </label>
        <label style={{ fontSize: 12, flex: 1, minWidth: 120, display: 'flex', flexDirection: 'column', gap: 2 }}>
          Link or reference
          <input
            value={artifactRef}
            onChange={(e) => { setArtifactRef(e.target.value); setRecorded(false); }}
            disabled={recordArtifact.isPending}
            placeholder="Paste a Capiro draft or outreach link"
            style={{ fontSize: 12 }}
          />
        </label>
        <CapiroButton
          size="compact"
          variant="secondary"
          disabled={!parsedReference || recordArtifact.isPending}
          loading={recordArtifact.isPending}
          onClick={submit}
        >
          Link work
        </CapiroButton>
      </div>
      {artifactRef.trim() && !parsedReference ? <p role="alert">Paste the Capiro link for the selected work type, or its reference.</p> : null}
      {recorded ? (
        <p className="st-inspector__empty" style={{ color: 'var(--st-success-fg, #12b76a)', marginTop: 4 }}>
          Work linked. You can open it from this step’s Linked outputs section.
        </p>
      ) : null}
      {recordArtifact.isError ? (
        <p className="st-modal__alert" role="alert" style={{ marginTop: 4 }}>
          Could not record artifact. {(recordArtifact.error as Error)?.message || 'Please try again.'}
        </p>
      ) : null}
    </div>
  );
}

function MeriSuggestionCard({ strategyId, step }: { strategyId: string; step: StrategyNode }) {
  // The assistant route can apply grounded edits to the working plan. New Meri
  // steps remain Suggested until a person promotes their status in the client
  // export review card above; this copy must not promise a separate queue that
  // this inspector does not use.
  void strategyId;
  void step;
  return (
    <div className="st-meri-suggestion">
      <p className="st-section-label">Meri-assisted changes</p>
      <p className="st-inspector__empty">
        Ask Meri below to update the working step. Review every change here;
        Meri-created steps remain Suggested until you mark them In progress or
        Active.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ Meri tab */

function MeriTab({ strategyId, step }: { strategyId: string; step: StrategyNode | null }) {
  const nodeId = step?.id ?? null;
  const conversation = useStrategyConversation(strategyId, nodeId);
  const dismissGap = useDismissContextGap(strategyId);
  const messages = useMemo(() => (conversation.data ?? []).filter((m) => m.state !== 'dismissed'), [conversation.data]);

  // The composer (input, send, its draft state, and the governance hint) now
  // lives in the parent StepInspector, pinned across both tabs — see the
  // "Composer pinned across tabs" comment there. This tab renders only the
  // thread itself.
  return (
    <div className="st-inspector__body st-meri-tab">
      <div className="st-meri-thread" aria-live="polite">
        {conversation.isLoading ? (
          <CapiroSkeleton height={160} />
        ) : conversation.isError ? (
          <div role="alert">
            <p>The conversation could not be loaded.</p>
            <CapiroButton onClick={() => void conversation.refetch()}>Retry conversation</CapiroButton>
          </div>
        ) : messages.length === 0 ? (
          <p className="st-inspector__empty">
            No thread yet. Ask Meri about this {nodeId ? 'step' : 'strategy'} — answers state their
            grounding.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`st-meri-msg st-meri-msg--${m.role}`}>
              {m.kind === 'context_gap' ? (
                <div className="st-meri-msg__context-gap">
                  <p className="st-meri-msg__body">{m.body}</p>
                  <button
                    type="button"
                    className="st-meri-msg__dismiss"
                    disabled={dismissGap.isPending}
                    onClick={() =>
                      dismissGap.mutate({ messageId: m.id, nodeId: nodeId })
                    }
                    aria-label="Dismiss this context gap notice"
                  >
                    Dismiss
                  </button>
                </div>
              ) : (
                <p className="st-meri-msg__body">{m.body}</p>
              )}
            </div>
          ))
        )}
      </div>
      {dismissGap.isError ? (
        <p className="st-modal__alert" role="alert" style={{ marginTop: 8 }}>
          Could not dismiss. {(dismissGap.error as Error)?.message || 'Please try again.'}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ utils */


function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

