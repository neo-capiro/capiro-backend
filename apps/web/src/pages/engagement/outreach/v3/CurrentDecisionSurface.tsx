import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CircleHelp,
  Loader2,
  Pencil,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { DecisionSurfaces, type DecisionSurfacesProps } from './DecisionSurfaces.js';
import type {
  OutreachV3Command,
  OutreachV3Proposal,
  OutreachV3SessionEnvelope,
  OutreachV3Stage,
} from './contracts.js';

export interface CurrentDecisionSurfaceProps extends DecisionSurfacesProps {
  onSelectStage: (stage: OutreachV3Stage) => void;
}

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function commandStage(type: string): OutreachV3Stage {
  if (
    type === 'SET_GOAL' ||
    type === 'SET_OBJECTIVE' ||
    type === 'SET_TOPIC' ||
    type === 'SET_DESIRED_OUTCOME' ||
    type === 'SET_ASK' ||
    type === 'CLEAR_ASK' ||
    type === 'SET_WHY_NOW'
  ) {
    return 'goal';
  }
  if (type === 'SET_SPONSOR_SCOPE') return 'sponsor';
  if (
    type === 'SET_TARGET_CRITERIA' ||
    type === 'ADD_TARGET_REFS' ||
    type === 'REMOVE_TARGET_REFS' ||
    type === 'REJECT_TARGET_RECOMMENDATION'
  ) {
    return 'targets';
  }
  if (type === 'SET_DELIVERY_PATTERN' || type === 'SET_PERSONALIZATION') {
    return 'delivery';
  }
  if (type === 'ACCEPT_CONTEXT_REFS' || type === 'EXCLUDE_CONTEXT_REFS') {
    return 'context';
  }
  return 'strategy';
}

function commandLabel(command: OutreachV3Command): string {
  const labels: Record<string, string> = {
    SET_GOAL: 'Campaign goal',
    SET_OBJECTIVE: 'Objective',
    SET_TOPIC: 'Topic',
    SET_DESIRED_OUTCOME: 'Desired outcome',
    SET_ASK: 'Explicit ask',
    CLEAR_ASK: 'Ask',
    SET_WHY_NOW: 'Why now',
    SET_SPONSOR_SCOPE: 'Sponsor scope',
    SET_TARGET_CRITERIA: 'Target criteria',
    ADD_TARGET_REFS: 'Add target',
    REMOVE_TARGET_REFS: 'Remove target',
    REJECT_TARGET_RECOMMENDATION: 'Dismiss recommendation',
    ACCEPT_CONTEXT_REFS: 'Accept context',
    EXCLUDE_CONTEXT_REFS: 'Exclude context',
    SET_DELIVERY_PATTERN: 'Delivery pattern',
    SET_PERSONALIZATION: 'Personalization',
    SET_CAMPAIGN_ANGLE: 'Campaign angle',
    SET_TONE: 'Tone',
    SET_LENGTH: 'Length',
  };
  return labels[command.type] ?? sentence(command.type);
}

function proposedValue(command: OutreachV3Command): string {
  const payload = command.payload as Record<string, unknown>;
  if (typeof payload.value === 'string') return sentence(payload.value);
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.kind === 'string') return sentence(payload.kind);
  if (Array.isArray(payload.clientRefs)) {
    return `${payload.clientRefs.length} client${payload.clientRefs.length === 1 ? '' : 's'}`;
  }
  if (Array.isArray(payload.refs)) {
    return `${payload.refs.length} reference${payload.refs.length === 1 ? '' : 's'}`;
  }
  if (Array.isArray(payload.targetKeys)) {
    return `${payload.targetKeys.length} target${payload.targetKeys.length === 1 ? '' : 's'}`;
  }
  if (Array.isArray(payload.selections)) {
    return `${payload.selections.length} context selection${payload.selections.length === 1 ? '' : 's'}`;
  }
  if (payload.mode === 'none') return 'No formal ask';
  return 'Update campaign state';
}

function currentValue(session: OutreachV3SessionEnvelope, command: OutreachV3Command): string {
  const spec = session.spec;
  switch (command.type) {
    case 'SET_GOAL':
      return spec.goal.goal || 'Not set';
    case 'SET_OBJECTIVE':
      return spec.goal.objective || 'Not set';
    case 'SET_TOPIC':
      return spec.goal.topic || 'Not set';
    case 'SET_DESIRED_OUTCOME':
      return spec.goal.desiredOutcome || 'Not set';
    case 'SET_ASK':
    case 'CLEAR_ASK':
      return spec.goal.ask.mode === 'none' ? 'No formal ask' : spec.goal.ask.text || 'Undecided';
    case 'SET_WHY_NOW':
      return spec.goal.whyNow || 'Not set';
    case 'SET_SPONSOR_SCOPE':
      return sentence(spec.sponsor.kind);
    case 'SET_TARGET_CRITERIA':
      return spec.targeting.criteria?.notes || 'Not set';
    case 'ADD_TARGET_REFS':
    case 'REMOVE_TARGET_REFS':
      return `${spec.targeting.selectedTargetRefs.length} selected`;
    case 'REJECT_TARGET_RECOMMENDATION':
      return `${spec.targeting.rejectedRecommendationRefs.length} dismissed`;
    case 'SET_DELIVERY_PATTERN':
      return sentence(spec.delivery.pattern);
    case 'SET_PERSONALIZATION':
      return sentence(spec.delivery.personalization);
    case 'ACCEPT_CONTEXT_REFS':
      return `${acceptedContextCount(session)} accepted`;
    case 'EXCLUDE_CONTEXT_REFS':
      return `${spec.context.excludedRefs.length} excluded`;
    case 'SET_CAMPAIGN_ANGLE':
      return spec.strategy.campaignAngle || 'Not set';
    case 'SET_TONE':
      return spec.strategy.tone || 'Not set';
    case 'SET_LENGTH':
      return sentence(spec.strategy.length);
    default:
      return 'Current Campaign Spec';
  }
}

function acceptedContextCount(session: OutreachV3SessionEnvelope): number {
  const context = session.spec.context;
  return (
    context.requiredPolicyRefs.length +
    context.writingGuidanceRefs.length +
    context.campaignFactRefs.length +
    context.targetSpecificRefs.length +
    context.groupSafeRefs.length
  );
}

function ProposalSurface({
  proposal,
  session,
  proposalBusy,
  applyProposal,
  rejectProposal,
  onSelectStage,
}: Pick<
  CurrentDecisionSurfaceProps,
  'session' | 'proposalBusy' | 'applyProposal' | 'rejectProposal' | 'onSelectStage'
> & { proposal: OutreachV3Proposal }) {
  const stale = proposal.expectedStateVersion !== session.currentStateVersion;
  const [showWhy, setShowWhy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editStage = useMemo(
    () => commandStage(proposal.commands[0]?.type ?? 'SET_CAMPAIGN_ANGLE'),
    [proposal.commands],
  );

  const discard = async () => {
    setError(null);
    try {
      await rejectProposal(proposal);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The proposal could not be discarded.');
    }
  };

  const edit = async () => {
    setError(null);
    try {
      await rejectProposal(proposal);
      onSelectStage(editStage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The proposal could not be opened for editing.');
    }
  };

  const apply = async () => {
    setError(null);
    try {
      await applyProposal(proposal);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The proposal could not be applied.');
    }
  };

  return (
    <section className="ov3-decision-panel is-proposal">
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Proposal · state V{proposal.expectedStateVersion}</span>
          <h2>Review the exact campaign changes</h2>
          <p>
            Meri proposed a deterministic command batch. Nothing changes until you Apply it.
          </p>
        </div>
        <span className={`ov3-badge ${stale ? 'is-warning' : 'is-info'}`}>
          {stale ? 'Stale' : 'Pending'}
        </span>
      </header>

      <div className="ov3-proposal-banner">
        <Sparkles size={18} aria-hidden="true" />
        <div>
          <span className="ov3-eyebrow">Visible proposal, no hidden authority</span>
          <h3>{proposal.commands.length} proposed change{proposal.commands.length === 1 ? '' : 's'}</h3>
          <p>
            Apply commits the complete batch atomically. Discard changes only the proposal status.
          </p>
        </div>
      </div>

      {stale ? (
        <div className="ov3-recovery is-warning" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>This proposal cannot apply to the current campaign</strong>
            <p>
              It was based on state V{proposal.expectedStateVersion}; the campaign is now V
              {session.currentStateVersion}. Capiro will not auto-rebase it.
            </p>
          </div>
        </div>
      ) : null}

      <div className="ov3-proposal-list">
        {proposal.commands.map((command, index) => (
          <article key={`${command.type}-${index}`}>
            <header>
              <span className="ov3-eyebrow">{commandLabel(command)}</span>
              <code>{command.type}</code>
            </header>
            <div>
              <span>{currentValue(session, command)}</span>
              <ArrowRight size={17} aria-hidden="true" />
              <strong>{proposedValue(command)}</strong>
            </div>
          </article>
        ))}
      </div>

      <button
        type="button"
        className="ov3-button is-quiet"
        aria-expanded={showWhy}
        onClick={() => setShowWhy((value) => !value)}
      >
        <CircleHelp size={16} aria-hidden="true" />
        Why this proposal?
      </button>
      {showWhy ? (
        <div className="ov3-guidance-card">
          <Sparkles size={18} aria-hidden="true" />
          <span className="ov3-eyebrow">Inspectable rationale</span>
          <h3>The visible Meri response is the rationale</h3>
          <p>
            Capiro does not expose or rely on hidden chain-of-thought. The conversation explains
            the recommendation; this panel shows the exact state changes and their effects.
          </p>
          <ul>
            <li>Every command is allowlisted and validated by Capiro.</li>
            <li>Referenced targets and context are reauthorized when Apply runs.</li>
            <li>A concurrent campaign change makes the proposal stale instead of rebasing it.</li>
          </ul>
        </div>
      ) : null}

      <div className="ov3-recovery is-info">
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>State safety</strong>
          <p>No draft, approval, send intent, provider call, or memory commit is included.</p>
        </div>
      </div>

      {error ? (
        <div className="ov3-recovery is-danger" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>Proposal action failed</strong><p>{error}</p></div>
        </div>
      ) : null}

      <footer className="ov3-panel-footer">
        <span>
          Proposal {proposal.id.slice(0, 8)} · expected V{proposal.expectedStateVersion}
        </span>
        <div className="ov3-panel-footer__actions">
          <button
            type="button"
            className="ov3-button is-quiet"
            onClick={() => void discard()}
            disabled={proposalBusy}
          >
            Discard
          </button>
          <button
            type="button"
            className="ov3-button is-secondary"
            onClick={() => void edit()}
            disabled={proposalBusy}
          >
            <Pencil size={16} aria-hidden="true" />
            Edit manually
          </button>
          <button
            type="button"
            className="ov3-button is-primary"
            onClick={() => void apply()}
            disabled={proposalBusy || stale}
          >
            {proposalBusy ? <Loader2 className="ov3-spin" size={16} /> : null}
            Apply {proposal.commands.length}
          </button>
        </div>
      </footer>
    </section>
  );
}

/**
 * Canonical decision router. Proposal review is kept outside individual stage
 * components so every stage uses the same Apply/Edit/Discard contract.
 */
export function CurrentDecisionSurface(props: CurrentDecisionSurfaceProps) {
  const proposal = props.pendingProposals[0];
  if (proposal) {
    return <ProposalSurface {...props} proposal={proposal} />;
  }
  const { onSelectStage: _onSelectStage, ...decisionProps } = props;
  return <DecisionSurfaces {...decisionProps} pendingProposals={[]} />;
}