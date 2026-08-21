import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Clock3,
  Loader2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { CampaignBrief } from '../../../pages/engagement/outreach/v3/CampaignBrief.js';
import { OutreachConversation } from '../../../pages/engagement/outreach/v3/OutreachConversation.js';
import type {
  OutreachV3CampaignSpec,
  OutreachV3Command,
  OutreachV3Proposal,
  OutreachV3Stage,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import {
  VNextOutreachWorkspace,
  type EngagementOutreachStep,
} from './VNextOutreachWorkspace.js';
import './outreach-meri-operator.css';

interface IntegrationConnection {
  id: string;
  provider: string;
  status: string;
  accountEmail?: string | null;
  displayName?: string | null;
}

export interface VNextOutreachOperatorWorkspaceProps {
  sessionId: string;
  clients: Client[];
  selectedClientId: string | null;
  integrations: IntegrationConnection[];
  step: EngagementOutreachStep;
  onStepChange: (step: EngagementOutreachStep) => void;
  onExit: () => void;
}

export interface OutreachProposalPreview {
  title: string;
  step: EngagementOutreachStep;
  before: string[];
  after: string[];
  commandCount: number;
}

interface ProposalReceipt extends OutreachProposalPreview {
  id: string;
  outcome: 'applied' | 'discarded';
  recordedAt: string;
}

const STEP_LABEL: Record<EngagementOutreachStep, string> = {
  goal: 'Goal',
  targets: 'Targets',
  delivery: 'Delivery',
  context: 'Context',
  samples: 'Examples',
  drafts: 'Drafts',
  send: 'Send',
};

const COMMAND_STEP: Record<string, EngagementOutreachStep> = {
  SET_GOAL: 'goal',
  SET_OBJECTIVE: 'goal',
  SET_TOPIC: 'goal',
  SET_DESIRED_OUTCOME: 'goal',
  SET_ASK: 'goal',
  SET_WHY_NOW: 'goal',
  SET_SPONSOR_SCOPE: 'goal',
  SET_TARGET_CRITERIA: 'targets',
  ADD_TARGET_REFS: 'targets',
  REMOVE_TARGET_REFS: 'targets',
  REJECT_TARGET_RECOMMENDATION: 'targets',
  SET_DELIVERY_PATTERN: 'delivery',
  SET_PERSONALIZATION: 'delivery',
  ACCEPT_CONTEXT_REFS: 'context',
  EXCLUDE_CONTEXT_REFS: 'context',
  SET_CAMPAIGN_ANGLE: 'drafts',
  SET_TONE: 'drafts',
  SET_LENGTH: 'drafts',
  ADD_STYLE_SAMPLES: 'samples',
  REMOVE_STYLE_SAMPLES: 'samples',
};

const FIELD_LABEL: Record<string, string> = {
  SET_GOAL: 'Goal',
  SET_OBJECTIVE: 'Objective',
  SET_TOPIC: 'Topic',
  SET_DESIRED_OUTCOME: 'Desired outcome',
  SET_WHY_NOW: 'Why now',
  SET_CAMPAIGN_ANGLE: 'Campaign angle',
  SET_TONE: 'Tone',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, fallback = 'Not set'): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function truncate(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function acceptedContextCount(spec: OutreachV3CampaignSpec): number {
  return (
    spec.context.requiredPolicyRefs.length +
    spec.context.writingGuidanceRefs.length +
    spec.context.campaignFactRefs.length +
    spec.context.targetSpecificRefs.length +
    spec.context.groupSafeRefs.length
  );
}

function sponsorLabel(value: unknown): string {
  const sponsor = asRecord(value);
  const kind = cleanText(sponsor.kind, 'undecided').replaceAll('_', ' ');
  const label = cleanText(sponsor.label, '');
  const clientCount = listLength(sponsor.clientRefs);
  if (kind === 'client') return `${clientCount || 1} client`;
  if (kind === 'multi client') return `${clientCount} clients`;
  if (kind === 'coalition' && label) return `Coalition · ${label}`;
  return kind === 'undecided' ? 'Not selected' : kind;
}

function askLabel(value: unknown): string {
  const ask = asRecord(value);
  if (ask.mode === 'none') return 'Informational update only';
  if (ask.mode === 'explicit') return cleanText(ask.text, 'Explicit ask');
  return 'Not set';
}

function criteriaLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Not set';
  const criteria = asRecord(value);
  const notes = cleanText(criteria.notes, '');
  if (notes) return truncate(notes);
  const filters = [
    ...((Array.isArray(criteria.committees) ? criteria.committees : []) as unknown[]),
    ...((Array.isArray(criteria.agencies) ? criteria.agencies : []) as unknown[]),
    ...((Array.isArray(criteria.states) ? criteria.states : []) as unknown[]),
    ...((Array.isArray(criteria.chambers) ? criteria.chambers : []) as unknown[]),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return filters.length ? filters.slice(0, 4).join(', ') : 'General audience criteria';
}

function currentFieldValue(spec: OutreachV3CampaignSpec, commandType: string): string {
  switch (commandType) {
    case 'SET_GOAL':
      return cleanText(spec.goal.goal);
    case 'SET_OBJECTIVE':
      return cleanText(spec.goal.objective);
    case 'SET_TOPIC':
      return cleanText(spec.goal.topic);
    case 'SET_DESIRED_OUTCOME':
      return cleanText(spec.goal.desiredOutcome);
    case 'SET_WHY_NOW':
      return cleanText(spec.goal.whyNow);
    case 'SET_CAMPAIGN_ANGLE':
      return cleanText(spec.strategy.campaignAngle);
    case 'SET_TONE':
      return cleanText(spec.strategy.tone);
    default:
      return 'Current campaign state';
  }
}

function commandChange(
  command: OutreachV3Command,
  spec: OutreachV3CampaignSpec,
  stateVersion: number,
): { before: string; after: string } {
  const payload = asRecord(command.payload);
  const fieldLabel = FIELD_LABEL[command.type];
  if (fieldLabel) {
    return {
      before: `${fieldLabel}: ${currentFieldValue(spec, command.type)}`,
      after: `${fieldLabel}: ${truncate(cleanText(payload.value))}`,
    };
  }

  switch (command.type) {
    case 'SET_ASK':
      return {
        before: `Ask: ${askLabel(spec.goal.ask)}`,
        after: `Ask: ${askLabel(payload)}`,
      };
    case 'SET_SPONSOR_SCOPE':
      return {
        before: `Sponsor: ${sponsorLabel(spec.sponsor)}`,
        after: `Sponsor: ${sponsorLabel(payload)}`,
      };
    case 'SET_TARGET_CRITERIA':
      return {
        before: `Target criteria: ${criteriaLabel(spec.targeting.criteria)}`,
        after: `Target criteria: ${criteriaLabel(payload.value)}`,
      };
    case 'ADD_TARGET_REFS': {
      const added = listLength(payload.refs);
      return {
        before: `Targets: ${spec.targeting.selectedTargetRefs.length} selected`,
        after: `Targets: add ${added} governed selection${added === 1 ? '' : 's'}`,
      };
    }
    case 'REMOVE_TARGET_REFS': {
      const removed = listLength(payload.targetKeys);
      return {
        before: `Targets: ${spec.targeting.selectedTargetRefs.length} selected`,
        after: `Targets: remove ${removed} selection${removed === 1 ? '' : 's'}`,
      };
    }
    case 'REJECT_TARGET_RECOMMENDATION':
      return {
        before: 'Recommendation: available for review',
        after: `Recommendation: reject as ${cleanText(payload.reason, 'not relevant').replaceAll('_', ' ')}`,
      };
    case 'SET_DELIVERY_PATTERN':
      return {
        before: `Delivery: ${spec.delivery.pattern.replaceAll('_', ' ')}`,
        after: `Delivery: ${cleanText(payload.value).replaceAll('_', ' ')}`,
      };
    case 'SET_PERSONALIZATION':
      return {
        before: `Personalization: ${spec.delivery.personalization}`,
        after: `Personalization: ${cleanText(payload.value)}`,
      };
    case 'ACCEPT_CONTEXT_REFS': {
      const added = listLength(payload.selections);
      return {
        before: `Context: ${acceptedContextCount(spec)} accepted`,
        after: `Context: add ${added} governed source${added === 1 ? '' : 's'}`,
      };
    }
    case 'EXCLUDE_CONTEXT_REFS': {
      const excluded = listLength(payload.refs);
      return {
        before: `Excluded context: ${spec.context.excludedRefs.length}`,
        after: `Excluded context: add ${excluded} source${excluded === 1 ? '' : 's'}`,
      };
    }
    case 'SET_LENGTH': {
      const length = cleanText(payload.value).replaceAll('_', ' ');
      const custom = cleanText(payload.customInstruction, '');
      return {
        before: `Length: ${spec.strategy.length.replaceAll('_', ' ')}`,
        after: `Length: ${length}${custom ? ` · ${truncate(custom)}` : ''}`,
      };
    }
    case 'ADD_STYLE_SAMPLES': {
      const added = listLength(payload.samples);
      return {
        before: `Examples: ${spec.styleSamples?.length ?? 0}`,
        after: `Examples: add ${added} sample${added === 1 ? '' : 's'}`,
      };
    }
    case 'REMOVE_STYLE_SAMPLES': {
      const removed = listLength(payload.sampleKeys);
      return {
        before: `Examples: ${spec.styleSamples?.length ?? 0}`,
        after: `Examples: remove ${removed} sample${removed === 1 ? '' : 's'}`,
      };
    }
    default:
      return {
        before: `Campaign Spec: V${stateVersion}`,
        after: `Apply governed command: ${command.type.replaceAll('_', ' ').toLowerCase()}`,
      };
  }
}

export function outreachStepForStage(stage: OutreachV3Stage): EngagementOutreachStep {
  switch (stage) {
    case 'goal':
    case 'sponsor':
      return 'goal';
    case 'targets':
      return 'targets';
    case 'delivery':
      return 'delivery';
    case 'context':
      return 'context';
    case 'strategy':
    case 'ready_for_generation':
      return 'drafts';
  }
}

export function describeOutreachProposal(
  proposal: OutreachV3Proposal,
  spec: OutreachV3CampaignSpec,
  stateVersion: number,
): OutreachProposalPreview {
  const steps = unique(
    proposal.commands.map((command) => COMMAND_STEP[command.type] ?? 'goal'),
  ) as EngagementOutreachStep[];
  const step = steps[0] ?? 'goal';
  const changes = proposal.commands.map((command) => commandChange(command, spec, stateVersion));
  const title =
    steps.length > 1
      ? 'Update campaign plan'
      : `Update ${STEP_LABEL[step].toLowerCase()}`;
  return {
    title,
    step,
    before: unique(changes.map((change) => change.before)),
    after: unique(changes.map((change) => change.after)),
    commandCount: proposal.commands.length,
  };
}

function campaignTitle(spec: OutreachV3CampaignSpec, fallback?: string | null): string {
  return spec.goal.topic?.trim() || fallback?.trim() || 'Outreach campaign';
}

function ProposalCard({
  proposal,
  preview,
  currentStateVersion,
  busy,
  error,
  onApply,
  onDiscard,
}: {
  proposal: OutreachV3Proposal;
  preview: OutreachProposalPreview;
  currentStateVersion: number;
  busy: boolean;
  error: string | null;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const stale = proposal.expectedStateVersion !== currentStateVersion;
  return (
    <article className={`uui-meri-proposal ${stale ? 'is-stale' : ''}`}>
      <header>
        <div>
          <span className="uui-meri-proposal__eyebrow">
            {STEP_LABEL[preview.step]} · {preview.commandCount} governed change
            {preview.commandCount === 1 ? '' : 's'}
          </span>
          <h4>{preview.title}</h4>
        </div>
        <span className="uui-meri-proposal__version">
          V{proposal.expectedStateVersion} → V{proposal.expectedStateVersion + 1}
        </span>
      </header>

      <div className="uui-meri-proposal__diff" aria-label="Proposed before and after changes">
        <div>
          <span>Before</span>
          <ul>
            {preview.before.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <ArrowRight size={17} aria-hidden="true" />
        <div>
          <span>After</span>
          <ul>
            {preview.after.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>

      {stale ? (
        <p className="uui-meri-proposal__warning" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          This proposal was prepared for V{proposal.expectedStateVersion}. The campaign is now V
          {currentStateVersion}; ask Meri to restate the change against the current brief.
        </p>
      ) : null}
      {error ? <p className="uui-meri-proposal__error" role="alert">{error}</p> : null}

      <footer>
        <p>
          Applying updates the canonical Campaign Spec. It does not generate drafts, approve them, or send email.
        </p>
        <div>
          <button type="button" className="uui-meri-proposal__discard" disabled={busy} onClick={onDiscard}>
            <X size={14} aria-hidden="true" />
            Discard
          </button>
          <button
            type="button"
            className="uui-meri-proposal__apply"
            disabled={busy || stale}
            onClick={onApply}
          >
            {busy ? <Loader2 className="ov3-spin" size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            Apply change
          </button>
        </div>
      </footer>
    </article>
  );
}

export function VNextOutreachOperatorWorkspace({
  sessionId,
  clients,
  selectedClientId,
  integrations,
  step,
  onStepChange,
  onExit,
}: VNextOutreachOperatorWorkspaceProps) {
  const controller = useOutreachV3Session({ sessionId });
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [proposalErrors, setProposalErrors] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<ProposalReceipt[]>([]);

  const session = controller.session;
  const proposalPreviews = useMemo(() => {
    if (!session) return new Map<string, OutreachProposalPreview>();
    return new Map(
      controller.pendingProposals.map((proposal) => [
        proposal.id,
        describeOutreachProposal(proposal, session.spec, session.currentStateVersion),
      ]),
    );
  }, [controller.pendingProposals, session]);

  const recordReceipt = (
    proposal: OutreachV3Proposal,
    preview: OutreachProposalPreview,
    outcome: ProposalReceipt['outcome'],
  ) => {
    setReceipts((current) => [
      {
        id: `${proposal.id}:${outcome}:${Date.now()}`,
        outcome,
        recordedAt: new Date().toISOString(),
        ...preview,
      },
      ...current,
    ].slice(0, 4));
  };

  const applyProposal = async (proposal: OutreachV3Proposal, preview: OutreachProposalPreview) => {
    setBusyProposalId(proposal.id);
    setProposalErrors((current) => ({ ...current, [proposal.id]: '' }));
    try {
      await controller.applyProposal(proposal);
      recordReceipt(proposal, preview, 'applied');
      onStepChange(preview.step);
    } catch (error) {
      setProposalErrors((current) => ({
        ...current,
        [proposal.id]: error instanceof Error ? error.message : 'The proposal could not be applied.',
      }));
    } finally {
      setBusyProposalId(null);
    }
  };

  const discardProposal = async (proposal: OutreachV3Proposal, preview: OutreachProposalPreview) => {
    setBusyProposalId(proposal.id);
    setProposalErrors((current) => ({ ...current, [proposal.id]: '' }));
    try {
      await controller.rejectProposal(proposal);
      recordReceipt(proposal, preview, 'discarded');
    } catch (error) {
      setProposalErrors((current) => ({
        ...current,
        [proposal.id]: error instanceof Error ? error.message : 'The proposal could not be discarded.',
      }));
    } finally {
      setBusyProposalId(null);
    }
  };

  return (
    <div className="uui-outreach-operator" aria-label="Meri campaign operator">
      <section className="uui-outreach-operator__bar" aria-label="Meri operator status">
        <div className="uui-outreach-operator__identity">
          <span aria-hidden="true"><Sparkles size={17} /></span>
          <div>
            <strong>Meri campaign operator</strong>
            <p>Ask, review the proposed state change, then apply it. The governed workbench remains the execution authority.</p>
          </div>
        </div>
        <div className="uui-outreach-operator__guardrail">
          <ShieldCheck size={15} aria-hidden="true" />
          Human approval required
          {controller.pendingProposals.length ? (
            <b>{controller.pendingProposals.length} pending</b>
          ) : null}
        </div>
      </section>

      {session ? (
        <div className="uui-outreach-operator__brief">
          <CampaignBrief
            session={session}
            clients={clients}
            currentStage={controller.stage}
            onSelectStage={(stage) => onStepChange(outreachStepForStage(stage))}
          />
        </div>
      ) : controller.isBootstrapping ? (
        <div className="uui-outreach-operator__loading" role="status">
          <Loader2 className="ov3-spin" size={16} aria-hidden="true" />
          Loading the canonical campaign brief…
        </div>
      ) : controller.errorMessage ? (
        <div className="uui-outreach-operator__loading is-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {controller.errorMessage}
        </div>
      ) : null}

      {session && controller.pendingProposals.length ? (
        <section className="uui-outreach-operator__proposals" aria-label="Meri proposed changes">
          <header>
            <div>
              <span>Decision queue</span>
              <h3>Review Meri’s proposed changes</h3>
            </div>
            <p>Nothing below changes campaign state until you apply it.</p>
          </header>
          <div className="uui-outreach-operator__proposal-list">
            {controller.pendingProposals.map((proposal) => {
              const preview = proposalPreviews.get(proposal.id);
              if (!preview) return null;
              return (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  preview={preview}
                  currentStateVersion={session.currentStateVersion}
                  busy={busyProposalId === proposal.id || controller.proposalBusy}
                  error={proposalErrors[proposal.id] || null}
                  onApply={() => void applyProposal(proposal, preview)}
                  onDiscard={() => void discardProposal(proposal, preview)}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {receipts.length ? (
        <section className="uui-outreach-operator__receipts" aria-label="Recent Meri decision receipts">
          <header>
            <Clock3 size={15} aria-hidden="true" />
            Recent decisions
          </header>
          <div>
            {receipts.map((receipt) => (
              <article key={receipt.id} data-outcome={receipt.outcome}>
                <span>{receipt.outcome === 'applied' ? <Check size={13} /> : <X size={13} />}</span>
                <div>
                  <strong>{receipt.outcome === 'applied' ? 'Applied' : 'Discarded'} · {receipt.title}</strong>
                  <p>{receipt.outcome === 'applied' ? receipt.after.join(' · ') : 'Canonical campaign state was not changed.'}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="uui-outreach-operator__workbench">
        <VNextOutreachWorkspace
          sessionId={sessionId}
          clients={clients}
          selectedClientId={selectedClientId}
          integrations={integrations}
          step={step}
          onStepChange={onStepChange}
          onExit={onExit}
        />
      </div>

      {session ? (
        <div className="uui-outreach-operator__conversation">
          <OutreachConversation
            title={campaignTitle(session.spec, session.session.title)}
            stage={controller.stage}
            turns={controller.turns}
            unavailable={controller.reasoningUnavailable}
            unavailableMessage={controller.reasoningErrorMessage}
            sending={controller.sendingTurn}
            onSend={controller.sendTurn}
            onRetry={() => controller.retryReasoning()}
          />
        </div>
      ) : null}
    </div>
  );
}
