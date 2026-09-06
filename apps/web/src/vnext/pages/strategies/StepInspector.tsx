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
  useAddNode,
  useAssistant,
  useCreateMission,
  useMissions,
  usePlanExecution,
  useUpdateMission,
  useDismissContextGap,
  useRecordArtifact,
  useStrategyConversation,
  useTenantMembers,
  useUpdateNode,
} from './strategies-api.js';
import { EXECUTION_MISSION_NAME, findExecutionMission } from '../../../pages/strategy/agents/agent-utils.js';
import type { ArtifactType, StrategyNode } from '../../../pages/strategy/types.js';
import {
  CLIENT_EXPORT_READY_STATUSES,
  clientExportStatusLabel,
  isClientExportReadyStatus,
  type ClientExportReadyStatus,
} from './lib/step-review.js';
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
  step,
  isNew,
  tab,
  onTabChange,
  onClose,
}: {
  strategyId: string;
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

  const send = (text?: string) => {
    const instruction = (text ?? draft).trim();
    if (!instruction || assistant.isPending || sending.current) return;
    sending.current = true;
    onTabChange('meri');
    assistant.mutate({
      scope: nodeId ? 'node' : 'strategy',
      nodeId: nodeId ?? undefined,
      instruction,
      clientMessageId: `vnext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }, {
      onSuccess: () => {
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
            onChange={(e) => setDraft(e.target.value)}
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
            Meri could not respond. {(assistant.error as Error)?.message || 'Please try again.'}
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
  strategyId,
  step,
  isNew,
  ownerName,
}: {
  strategyId: string;
  step: StrategyNode | null;
  isNew: boolean;
  ownerName: string;
}) {
  const navigate = useNavigate();
  const updateNode = useUpdateNode(strategyId);
  if (isNew) {
    return <NewStepForm strategyId={strategyId} />;
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
                step.status === 'active' ? 'Active' : 'In progress'
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
          <dd>{evidence.length > 0 ? `${evidence.length} attached` : 'None attached'}</dd>
        </div>
      </dl>

      <p className="st-section-label">Linked evidence</p>
      {evidence.length === 0 ? (
        <p className="st-inspector__empty">No linked evidence. Link a context document, Workspace draft, or outreach record to ground this step.</p>
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

      <ExecutionActions strategyId={strategyId} step={step} />

      <RecordArtifactSection strategyId={strategyId} step={step} />

      <MeriSuggestionCard strategyId={strategyId} step={step} />
    </div>
  );
}

/* ------------------------------------------------------- Workspace / outreach */

function ExecutionActions({ strategyId, step }: { strategyId: string; step: StrategyNode }) {
  const navigate = useNavigate();
  const missions = useMissions(strategyId, false);
  const createMission = useCreateMission();
  const updateMission = useUpdateMission();
  const plan = usePlanExecution();
  const stagingRef = useRef(false);
  const [staging, setStaging] = useState<'workspace' | 'outreach' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stage = async (kind: 'workspace' | 'outreach') => {
    if (stagingRef.current) return;
    stagingRef.current = true;
    setStaging(kind);
    setError(null);
    try {
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
      const run = await plan.mutateAsync({ missionId: mission.id, strategyId, nodeId: step.id, kind });
      if (!run) throw new Error('No execution plan was returned. Please try again.');
      // This only prepares the existing execution plan. Its review page shows any waiting reason.
      navigate(`/strategies/agents/runs?strategyId=${encodeURIComponent(strategyId)}`);
    } catch (err) {
      setError((err as Error)?.message || 'The execution plan could not be prepared. Please try again.');
    } finally {
      stagingRef.current = false;
      setStaging(null);
    }
  };

  return (
    <>
      <div className="st-inspector__actions">
        <CapiroButton disabled={staging !== null} loading={staging === 'workspace'} onClick={() => void stage('workspace')}>
          Prepare in Workspace
        </CapiroButton>
        <CapiroButton variant="primary" disabled={staging !== null} loading={staging === 'outreach'} onClick={() => void stage('outreach')}>
          Stage outreach
        </CapiroButton>
      </div>
      {error ? <p className="st-modal__alert" role="alert">{error}</p> : null}
    </>
  );
}

/* ------------------------------------------------------------ Meri suggestion */

function RecordArtifactSection({ strategyId, step }: { strategyId: string; step: StrategyNode }) {
  const recordArtifact = useRecordArtifact(strategyId);
  const [artifactType, setArtifactType] = useState<ArtifactType>('workspace_draft');
  const [artifactRef, setArtifactRef] = useState('');
  const [recorded, setRecorded] = useState(false);

  const submit = () => {
    const ref = artifactRef.trim();
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
      <p className="st-section-label">Record evidence artifact</p>
      <p className="st-inspector__empty" style={{ marginBottom: 8 }}>
        Link a Workspace draft or Outreach record to this step as a grounding back-link.
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
          Reference
          <input
            value={artifactRef}
            onChange={(e) => { setArtifactRef(e.target.value); setRecorded(false); }}
            disabled={recordArtifact.isPending}
            placeholder="Artifact reference id"
            style={{ fontSize: 12 }}
          />
        </label>
        <CapiroButton
          size="compact"
          variant="secondary"
          disabled={!artifactRef.trim() || recordArtifact.isPending}
          loading={recordArtifact.isPending}
          onClick={submit}
        >
          Record
        </CapiroButton>
      </div>
      {recorded ? (
        <p className="st-inspector__empty" style={{ color: 'var(--st-success-fg, #12b76a)', marginTop: 4 }}>
          Artifact recorded. The back-link is now on this step.
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

function NewStepForm({ strategyId }: { strategyId: string }) {
  const navigate = useNavigate();
  const addNode = useAddNode(strategyId);
  const [kind, setKind] = useState<StrategyNode['kind']>('action');
  const [title, setTitle] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const valid = title.trim().length > 0 && startsOn.length > 0;
  return (
    <div className="st-inspector__body">
      <form
        className="st-newstep"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || addNode.isPending) return;
          addNode.mutate(
            { kind, subject: 'deliverable', title: title.trim(), startsOn },
            { onSuccess: () => navigate(`/strategies/${strategyId}`) },
          );
        }}
      >
        <label>
          Kind
          <select disabled={addNode.isPending} value={kind} onChange={(e) => setKind(e.target.value as StrategyNode['kind'])}>
            <option value="action">Action</option>
            <option value="gate">Gate</option>
            <option value="milestone">Milestone</option>
            <option value="decision">Decision</option>
            <option value="risk">Risk</option>
          </select>
        </label>
        <label>
          Title
          <input disabled={addNode.isPending} maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Step title" />
        </label>
        <label>
          Start date
          <input type="date" disabled={addNode.isPending} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <CapiroButton type="submit" variant="primary" disabled={!valid || addNode.isPending} loading={addNode.isPending}>
          Add step
        </CapiroButton>
        {addNode.isError ? (
          <p className="st-modal__alert" role="alert">
            The step could not be added. {(addNode.error as Error)?.message || 'Please try again.'}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

