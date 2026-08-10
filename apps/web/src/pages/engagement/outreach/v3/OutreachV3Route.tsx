import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import type { Client } from '../../../clients/clientTypes.js';
import { CampaignBrief } from './CampaignBrief.js';
import { CurrentDecisionSurface } from './CurrentDecisionSurface.js';
import { OutreachConversation } from './OutreachConversation.js';
import type {
  OutreachV3DeliveryPattern,
  OutreachV3Personalization,
  OutreachV3Stage,
  OutreachV3StrategyData,
} from './contracts.js';
import { useOutreachV3Session } from './useOutreachV3Session.js';
import './outreach-v3.css';

export interface OutreachV3RouteProps {
  clients: Client[];
  selectedClientId: string | null;
  onCancel: () => void;
  onComplete: () => void;
  onOpenClassic: () => void;
}

const STAGES: Array<{ key: OutreachV3Stage; label: string; shortLabel: string }> = [
  { key: 'goal', label: 'Goal', shortLabel: 'Goal' },
  { key: 'sponsor', label: 'Sponsor', shortLabel: 'Sponsor' },
  { key: 'targets', label: 'Targets', shortLabel: 'Targets' },
  { key: 'delivery', label: 'Delivery', shortLabel: 'Delivery' },
  { key: 'context', label: 'Context', shortLabel: 'Context' },
  { key: 'strategy', label: 'Strategy', shortLabel: 'Strategy' },
];

const STAGE_INDEX: Record<OutreachV3Stage, number> = {
  goal: 0,
  sponsor: 1,
  targets: 2,
  delivery: 3,
  context: 4,
  strategy: 5,
  ready_for_generation: 6,
};

const REVIEW_BEFORE_CONTINUE = new Set<OutreachV3Stage>(['targets', 'context']);

type StrategyProjection = OutreachV3StrategyData & {
  recommendedPattern?: OutreachV3DeliveryPattern;
  recommendedPersonalization?: OutreachV3Personalization;
};

function campaignTitle(topic: string | null | undefined, fallback: string | null | undefined): string {
  return topic?.trim() || fallback?.trim() || 'New outreach campaign';
}

function stageLabel(stage: OutreachV3Stage): string {
  if (stage === 'ready_for_generation') return 'Planning complete';
  return STAGES.find((entry) => entry.key === stage)?.label ?? stage;
}

export function OutreachV3Route({
  clients,
  selectedClientId,
  onCancel,
  onComplete,
  onOpenClassic,
}: OutreachV3RouteProps) {
  const controller = useOutreachV3Session({ title: 'New outreach campaign' });
  const [viewStage, setViewStage] = useState<OutreachV3Stage>('goal');

  useEffect(() => {
    setViewStage((current) => {
      const currentIndex = STAGE_INDEX[current];
      const canonicalIndex = STAGE_INDEX[controller.stage];
      if (currentIndex > canonicalIndex) return controller.stage;
      if (REVIEW_BEFORE_CONTINUE.has(current) && canonicalIndex > currentIndex) return current;
      return controller.stage;
    });
  }, [controller.stage]);

  const session = controller.session;
  const title = useMemo(
    () => campaignTitle(session?.spec.goal.topic, session?.session.title),
    [session?.session.title, session?.spec.goal.topic],
  );
  const decisionSession = useMemo(() => {
    if (!session || viewStage !== 'delivery') return session;
    const projection = controller.strategy?.data as StrategyProjection | undefined;
    const recommendedPattern = projection?.recommendedPattern;
    const recommendedPersonalization = projection?.recommendedPersonalization;
    if (!recommendedPattern && !recommendedPersonalization) return session;
    const pattern =
      session.spec.delivery.pattern === 'undecided' && recommendedPattern
        ? recommendedPattern
        : session.spec.delivery.pattern;
    const personalization =
      session.spec.delivery.personalization === 'undecided' && recommendedPersonalization
        ? recommendedPersonalization
        : session.spec.delivery.personalization;
    if (
      pattern === session.spec.delivery.pattern &&
      personalization === session.spec.delivery.personalization
    ) {
      return session;
    }
    return {
      ...session,
      spec: {
        ...session.spec,
        delivery: { pattern, personalization },
      },
    };
  }, [controller.strategy?.data, session, viewStage]);

  if (controller.isBootstrapping) {
    return (
      <div className="ov3-root ov3-bootstrap" aria-busy="true">
        <div className="ov3-bootstrap__mark">
          <Sparkles size={22} aria-hidden="true" />
        </div>
        <div>
          <span className="ov3-eyebrow">Outreach V3</span>
          <h2>Creating a governed campaign workspace</h2>
          <p>Preparing the canonical Campaign Spec and conversational planning surface…</p>
        </div>
        <Loader2 className="ov3-spin" size={22} aria-hidden="true" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="ov3-root ov3-fatal-state" role="alert">
        <CircleAlert size={28} aria-hidden="true" />
        <div>
          <span className="ov3-eyebrow">Outreach V3 unavailable</span>
          <h2>The preview workspace could not open</h2>
          <p>{controller.errorMessage ?? 'The canonical Outreach session is unavailable.'}</p>
          <div className="ov3-fatal-state__actions">
            <button type="button" className="ov3-button is-secondary" onClick={onOpenClassic}>
              Open Classic Outreach
            </button>
            <button type="button" className="ov3-button is-primary" onClick={() => void controller.startNewSession()}>
              <RotateCcw size={16} aria-hidden="true" />
              Try a new V3 session
            </button>
          </div>
        </div>
      </div>
    );
  }

  const canonicalIndex = STAGE_INDEX[controller.stage];
  const selectedIndex = STAGE_INDEX[viewStage];
  const canOpenStage = (stage: OutreachV3Stage) => STAGE_INDEX[stage] <= canonicalIndex;
  const hasUnsavedMutation = controller.applyingCommands || controller.proposalBusy;
  const reviewCanContinue = selectedIndex < canonicalIndex;
  const deliberateReviewHold = REVIEW_BEFORE_CONTINUE.has(viewStage) && reviewCanContinue;

  return (
    <div className="ov3-root" aria-busy={hasUnsavedMutation || controller.isRefreshing}>
      <header className="ov3-toolbar">
        <div className="ov3-toolbar__identity">
          <button type="button" className="ov3-icon-button" onClick={onCancel} aria-label="Close Outreach workspace">
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <div className="ov3-toolbar__mark" aria-hidden="true">
            <Sparkles size={17} />
          </div>
          <div>
            <span className="ov3-eyebrow">Conversational Outreach · preview</span>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="ov3-toolbar__context" aria-label="Campaign context">
          <span><small>State</small>V{session.currentStateVersion}</span>
          <span><small>Sponsor</small>{session.spec.sponsor.kind === 'undecided' ? 'Undecided' : session.spec.sponsor.kind.replaceAll('_', ' ')}</span>
          <span><small>Targets</small>{session.spec.targeting.selectedTargetRefs.length}</span>
        </div>
        <div className="ov3-toolbar__actions">
          <span className="ov3-save-state" role="status">
            {hasUnsavedMutation || controller.isRefreshing ? (
              <><Loader2 className="ov3-spin" size={14} /> Saving…</>
            ) : (
              <><Save size={14} /> Autosaved</>
            )}
          </span>
          <button type="button" className="ov3-button is-quiet" onClick={onOpenClassic}>
            Classic Outreach
          </button>
          <button
            type="button"
            className="ov3-button is-secondary"
            onClick={() => {
              if (window.confirm('Archive this V3 session and start a new campaign?')) {
                void controller.startNewSession();
              }
            }}
          >
            New campaign
          </button>
          <button type="button" className="ov3-button is-primary" onClick={onComplete}>
            Finish later
          </button>
          <button type="button" className="ov3-icon-button" onClick={onCancel} aria-label="Close">
            <X size={18} />
          </button>
        </div>
      </header>

      <nav className="ov3-stage-rail" aria-label="Campaign planning stages">
        {STAGES.map((stage, index) => {
          const complete = index < canonicalIndex;
          const current = stage.key === controller.stage;
          const selected = stage.key === viewStage;
          const enabled = canOpenStage(stage.key);
          return (
            <button
              key={stage.key}
              type="button"
              disabled={!enabled}
              className={selected ? 'is-selected' : current ? 'is-current' : complete ? 'is-complete' : ''}
              aria-current={current ? 'step' : undefined}
              onClick={() => enabled && setViewStage(stage.key)}
            >
              <span className="ov3-stage-rail__index">
                {complete ? <Check size={15} aria-hidden="true" /> : index + 1}
              </span>
              <span>
                <strong>{stage.label}</strong>
                <small>{current ? 'Now' : complete ? 'Done' : selected ? 'Review' : 'Next'}</small>
              </span>
              {index < STAGES.length - 1 ? <ChevronRight className="ov3-stage-rail__arrow" size={14} /> : null}
            </button>
          );
        })}
        {controller.stage === 'ready_for_generation' ? (
          <span className="ov3-stage-rail__ready">
            <Check size={15} /> Planning complete
          </span>
        ) : null}
      </nav>

      {reviewCanContinue && viewStage !== 'ready_for_generation' ? (
        <div className="ov3-review-banner" role="status">
          <span>
            {deliberateReviewHold
              ? `${stageLabel(viewStage)} changes are saved. Keep reviewing here or continue when you are ready.`
              : 'Reviewing a completed stage. Saving a change creates a new Campaign Spec version and may invalidate downstream readiness.'}
          </span>
          <button type="button" onClick={() => setViewStage(controller.stage)}>
            {deliberateReviewHold ? 'Continue to' : 'Return to'} {stageLabel(controller.stage)}{' '}
            <ChevronRight size={14} />
          </button>
        </div>
      ) : null}

      <main className="ov3-workspace">
        <OutreachConversation
          title={title}
          stage={controller.stage}
          turns={controller.turns}
          unavailable={controller.reasoningUnavailable}
          unavailableMessage={controller.reasoningErrorMessage}
          sending={controller.sendingTurn}
          onSend={controller.sendTurn}
          onRetry={() => controller.retryReasoning()}
        />

        <div className="ov3-workspace__decision">
          <CurrentDecisionSurface
            session={decisionSession ?? session}
            stage={viewStage}
            clients={clients}
            selectedClientId={selectedClientId}
            busy={controller.applyingCommands}
            applyCommands={controller.applyCommands}
            pendingProposals={controller.pendingProposals}
            proposalBusy={controller.proposalBusy}
            applyProposal={controller.applyProposal}
            rejectProposal={controller.rejectProposal}
            searchTargets={controller.searchTargets}
            targetCandidates={controller.targetCandidates}
            targetSearchPending={controller.targetSearchPending}
            targetSearchError={controller.targetSearchError}
            getTargetProfile={controller.getTargetProfile}
            targetProfile={controller.targetProfile}
            targetProfilePending={controller.targetProfilePending}
            coverage={controller.coverage}
            coveragePending={controller.coveragePending}
            searchContext={controller.searchContext}
            contextCandidates={controller.contextCandidates}
            contextSearchPending={controller.contextSearchPending}
            contextSearchError={controller.contextSearchError}
            contextReview={controller.contextReview}
            contextReviewPending={controller.contextReviewPending}
            contextReviewError={controller.contextReviewError}
            strategy={controller.strategy}
            strategyPending={controller.strategyPending}
            strategyError={controller.strategyError}
            onFinish={onComplete}
            onSelectStage={setViewStage}
          />
        </div>

        <CampaignBrief session={session} clients={clients} currentStage={controller.stage} />
      </main>
    </div>
  );
}