/*
 * Step inspector — ?step=:stepId (STRATEGIES-HANDOFF §7.4).
 *
 * One inspector, two tabs (Step · Meri) — one selection model (§4.1 #3).
 *
 * Governance (§7.4 must-nots, §11):
 *  - The Meri tab can PROPOSE but never apply: "Send to review queue" creates a
 *    proposal (a change-set), never a plan edit. The Meri panel never mutates the
 *    plan directly and never renders a suggestion as if applied.
 *  - "Prepare in Workspace" / "Stage outreach" create STAGED records only; neither
 *    sends anything externally (Stage H gates the send path — §7.9).
 *  - Dismiss suppresses a suggestion until the step changes.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import {
  memberName,
  useAddNode,
  useAssistant,
  useStrategy,
  useStrategyConversation,
  useTenantMembers,
} from './strategies-api.js';
import type { StrategyNode } from '../../../pages/strategy/types.js';
import './step-inspector.css';

const KIND_LABEL: Record<string, string> = {
  action: 'Action',
  gate: 'Gate',
  milestone: 'Milestone',
  decision: 'Decision',
  risk: 'Risk',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  in_progress: 'In progress',
  internal_review: 'Internal review',
  active: 'Active',
  suggested: 'Suggested',
};

export function StepInspector({
  strategyId,
  step,
  isNew,
  initialTab,
  onClose,
}: {
  strategyId: string;
  step: StrategyNode | null;
  isNew: boolean;
  initialTab: 'step' | 'meri';
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'step' | 'meri'>(initialTab);
  const strategy = useStrategy(strategyId);
  const members = useTenantMembers();

  return (
    <aside className="st-inspector" aria-label="Step inspector">
      <div className="st-inspector__head">
        <div>
          <p className="st-eyebrow">{isNew ? 'New step' : 'Selected step'}</p>
          <h2 className="st-inspector__title">{isNew ? 'Add a step' : step?.title ?? 'Step'}</h2>
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
          onClick={() => setTab('step')}
        >
          Step
        </button>
        <button
          role="tab"
          aria-selected={tab === 'meri'}
          className={tab === 'meri' ? 'is-active' : ''}
          onClick={() => setTab('meri')}
        >
          Meri
        </button>
      </div>

      {tab === 'step' ? (
        <StepTab
          strategyId={strategyId}
          step={step}
          isNew={isNew}
          ownerName={step ? memberName(members.data, step.ownerUserId) : 'Unassigned'}
        />
      ) : (
        <MeriTab strategyId={strategyId} step={step} />
      )}
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
  if (isNew) {
    return <NewStepForm strategyId={strategyId} />;
  }
  if (!step) {
    return <div className="st-inspector__body"><CapiroSkeleton height={200} /></div>;
  }
  const evidence = step.provenance?.sources ?? [];
  return (
    <div className="st-inspector__body">
      <div className="st-inspector__pills">
        <span className={`st-pill st-step__kind--${step.kind}`}>{KIND_LABEL[step.kind] ?? step.kind}</span>
        <span className="st-pill st-pill--accent">{STATUS_LABEL[step.status] ?? step.status}</span>
      </div>

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
          {evidence.map((s, i) => (
            <li key={`${s.section}-${i}`}>
              <span className="st-inspector__evidence-title">{s.section}</span>
              {s.ref ? <span className="st-mono st-inspector__evidence-ref">{s.ref}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className="st-inspector__actions">
        <PrepareWorkspaceButton strategyId={strategyId} step={step} />
        <StageOutreachButton strategyId={strategyId} step={step} />
      </div>

      <MeriSuggestionCard strategyId={strategyId} step={step} />
    </div>
  );
}

/* ------------------------------------------------------- Workspace / outreach */

function PrepareWorkspaceButton({ strategyId, step }: { strategyId: string; step: StrategyNode }) {
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  // Prepare-in-Workspace stages a Workspace draft linked to this step (§7.4). The
  // execution plan endpoint is the staging path; the artifact back-link is recorded
  // on the node. Nothing sends.
  return (
    <CapiroButton
      disabled={state !== 'idle'}
      onClick={() => {
        setState('working');
        // Staging is performed by the Execution plan surface; deep-link there so the
        // operator reviews the staged plan rather than firing an implicit write here.
        window.location.assign(`/strategies/agents/runs?strategyId=${strategyId}&nodeId=${step.id}`);
      }}
    >
      {state === 'idle' ? 'Prepare in Workspace' : 'Opening…'}
    </CapiroButton>
  );
}

function StageOutreachButton({ strategyId, step }: { strategyId: string; step: StrategyNode }) {
  // Stage outreach creates STAGED records only (§7.9); the external send stays
  // disabled until Stage H. Route to the execution surface to stage + review.
  return (
    <CapiroButton
      variant="primary"
      onClick={() =>
        window.location.assign(`/strategies/agents/runs?strategyId=${strategyId}&nodeId=${step.id}&intent=outreach`)
      }
    >
      Stage outreach
    </CapiroButton>
  );
}

/* ------------------------------------------------------------ Meri suggestion */

function MeriSuggestionCard({ strategyId, step }: { strategyId: string; step: StrategyNode }) {
  // A Meri suggestion is a PROPOSAL. "Send to review queue" creates a change-set
  // (a proposal a human must approve + apply); it never edits the plan here.
  // There is no direct "suggest" endpoint for an arbitrary step — the grounded
  // suggestion text arrives via the strategy conversation / Watch state. When no
  // suggestion is present for this step, render the empty state, never a fake one.
  void strategyId;
  void step;
  return (
    <div className="st-meri-suggestion">
      <p className="st-section-label">Meri suggestion</p>
      <p className="st-inspector__empty">
        No open suggestion for this step. Ask Meri below — a suggestion can be sent to the
        review queue for a person to approve before anything changes.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ Meri tab */

function MeriTab({ strategyId, step }: { strategyId: string; step: StrategyNode | null }) {
  const nodeId = step?.id ?? null;
  const conversation = useStrategyConversation(strategyId, nodeId);
  const assistant = useAssistant(strategyId);
  const [draft, setDraft] = useState('');

  const messages = useMemo(() => conversation.data ?? [], [conversation.data]);

  const send = () => {
    const instruction = draft.trim();
    if (!instruction) return;
    assistant.mutate({
      scope: nodeId ? 'node' : 'strategy',
      nodeId: nodeId ?? undefined,
      instruction,
      clientMessageId: `vnext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    setDraft('');
  };

  return (
    <div className="st-inspector__body st-meri-tab">
      <div className="st-meri-thread" aria-live="polite">
        {conversation.isLoading ? (
          <CapiroSkeleton height={160} />
        ) : messages.length === 0 ? (
          <p className="st-inspector__empty">
            No thread yet. Ask Meri about this {nodeId ? 'step' : 'strategy'} — answers state their
            grounding.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`st-meri-msg st-meri-msg--${m.role}`}>
              <p className="st-meri-msg__body">{m.body}</p>
            </div>
          ))
        )}
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
        <CapiroButton variant="primary" loading={assistant.isPending} onClick={send} disabled={!draft.trim()}>
          Send
        </CapiroButton>
      </div>
      <p className="st-meri-hint">
        Meri proposes; a person approves. Nothing changes the plan from this panel.
      </p>
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
          if (!valid) return;
          addNode.mutate(
            { kind, subject: 'deliverable', title: title.trim(), startsOn },
            { onSuccess: () => navigate(`/strategies/${strategyId}`) },
          );
        }}
      >
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as StrategyNode['kind'])}>
            <option value="action">Action</option>
            <option value="gate">Gate</option>
            <option value="milestone">Milestone</option>
            <option value="decision">Decision</option>
            <option value="risk">Risk</option>
          </select>
        </label>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Step title" />
        </label>
        <label>
          Start date
          <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <CapiroButton variant="primary" disabled={!valid} loading={addNode.isPending}>
          Add step
        </CapiroButton>
      </form>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
