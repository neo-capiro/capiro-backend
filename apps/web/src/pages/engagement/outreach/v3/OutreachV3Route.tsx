import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
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
import type { OutreachV3Stage } from './contracts.js';
import { useOutreachV3Session } from './useOutreachV3Session.js';
import './outreach-v3.css';
import './outreach-v3-standalone.css';

export interface OutreachV3RouteProps {
  clients: Client[];
  selectedClientId: string | null;
  onCancel: () => void;
  onComplete: () => void;
  onOpenClassic: () => void;
}

type VisibleStageKey = 'goal' | 'targets' | 'delivery' | 'context' | 'drafts' | 'send';

interface VisibleStage {
  key: VisibleStageKey;
  label: string;
  entry: OutreachV3Stage | null;
  members: OutreachV3Stage[];
  future?: boolean;
}

/**
 * The standalone prototype deliberately exposes six user-visible stages while
 * keeping the richer internal checkpoint machine. Sponsor is part of Goal;
 * strategy/planning is the Phase 6 portion of Drafts; Send remains locked until
 * its deterministic backend exists.
 */
const VISIBLE_STAGES: VisibleStage[] = [
  { key: 'goal', label: 'Goal', entry: 'goal', members: ['goal', 'sponsor'] },
  { key: 'targets', label: 'Targets', entry: 'targets', members: ['targets'] },
  { key: 'delivery', label: 'Delivery', entry: 'delivery', members: ['delivery'] },
  { key: 'context', label: 'Context', entry: 'context', members: ['context'] },
  {
    key: 'drafts',
    label: 'Drafts',
    entry: 'strategy',
    members: ['strategy', 'ready_for_generation'],
  },
  { key: 'send', label: 'Send', entry: null, members: [], future: true },
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

function campaignTitle(topic: string | null | undefined, fallback: string | null | undefined): string {
  return topic?.trim() || fallback?.trim() || 'New outreach campaign';
}

function internalStageLabel(stage: OutreachV3Stage): string {
  switch (stage) {
    case 'goal': return 'Goal';
    case 'sponsor': return 'Sponsor';
    case 'targets': return 'Targets';
    case 'delivery': return 'Delivery';
    case 'context': return 'Context';
    case 'strategy': return 'Strategy';
    case 'ready_for_generation': return 'Planning complete';
  }
}

function visibleStageIndex(stage: OutreachV3Stage): number {
  const index = VISIBLE_STAGES.findIndex((group) => group.members.includes(stage));
  return index < 0 ? 0 : index;
}

function stageForGroup(group: VisibleStage, canonical: OutreachV3Stage): OutreachV3Stage | null {
  if (group.future || !group.entry) return null;
  if (group.members.includes(canonical)) return canonical;
  return group.entry;
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

  const startNew = async () => {
    try {
      await controller.startNewSession();
    } catch {
      // The hook preserves the current session and exposes safe visible error copy.
    }
  };

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
          <h2>The workspace could not open</h2>
          <p>{controller.errorMessage ?? 'The canonical Outreach session is unavailable.'}</p>
          <div className="ov3-fatal-state__actions">
            <button type="button" className="ov3-button is-secondary" onClick={onOpenClassic}>
              Open Classic Outreach
            </button>
            <button
              type="button"
              className="ov3-button is-primary"
              disabled={controller.startingNewSession}
              onClick={() => void startNew()}
            >
              {controller.startingNewSession ? (
                <Loader2 className="ov3-spin" size={16} aria-hidden="true" />
              ) : (
                <RotateCcw size={16} aria-hidden="true" />
              )}
              Try a new V3 session
            </button>
          </div>
        </div>
      </div>
    );
  }

  const canonicalIndex = STAGE_INDEX[controller.stage];
  const selectedIndex = STAGE_INDEX[viewStage];
  const canonicalVisibleIndex = visibleStageIndex(controller.stage);
  const canOpenInternalStage = (stage: OutreachV3Stage) => STAGE_INDEX[stage] <= canonicalIndex;
  const hasUnsavedMutation =
    controller.applyingCommands || controller.proposalBusy || controller.startingNewSession;
  const reviewCanContinue = selectedIndex < canonicalIndex;
  const deliberateReviewHold = REVIEW_BEFORE_CONTINUE.has(viewStage) && reviewCanContinue;

  return (
    <div className="ov3-root ov3-root--standalone" aria-busy={hasUnsavedMutation || controller.isRefreshing}>
      <header className="ov3-toolbar">
        <div className="ov3-toolbar__identity">
          <button type="button" className="ov3-icon-button" onClick={onCancel} aria-label="Close Outreach workspace">
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <div className="ov3-toolbar__mark" aria-hidden="true">
            <Sparkles size={17} />
          </div>
          <div>
            <span className="ov3-eyebrow">Outreach · conversational campaign</span>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="ov3-toolbar__context" aria-label="Campaign context">
          <span><small>State</small>V{session.currentStateVersion}</span>
          <span><small>Decision</small>{internalStageLabel(controller.stage)}</span>
          <span><small>Targets</small>{session.spec.targeting.selectedTargetRefs.length}</span>
        </div>
        <div className="ov3-toolbar__actions">
          <span className="ov3-save-state" role="status">
            {hasUnsavedMutation || controller.isRefreshing ? (
              <><Loader2 className="ov3-spin" size={14} /> Saving…</>
            ) : (
              <><Save size={14} /> Saved</>
            )}
          </span>
          <button type="button" className="ov3-button is-quiet" onClick={onOpenClassic}>
            Classic
          </button>
          <button
            type="button"
            className="ov3-button is-secondary"
            disabled={controller.startingNewSession}
            onClick={() => {
              if (window.confirm('Archive this V3 session and start a new campaign?')) {
                void startNew();
              }
            }}
          >
            {controller.startingNewSession ? <Loader2 className="ov3-spin" size={15} /> : null}
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

      <nav className="ov3-stage-rail ov3-stage-rail--six" aria-label="Campaign stages">
        {VISIBLE_STAGES.map((group, index) => {
          const future = Boolean(group.future);
          const complete =
            index < canonicalVisibleIndex ||
            (group.key === 'drafts' && controller.stage === 'ready_for_generation');
          const current =
            index === canonicalVisibleIndex && controller.stage !== 'ready_for_generation';
          const selected = group.members.includes(viewStage);
          const targetStage = stageForGroup(group, controller.stage);
          const enabled = !future && Boolean(targetStage) && index <= canonicalVisibleIndex;
          const status = future
            ? 'Locked'
            : complete
              ? group.key === 'drafts' && controller.stage === 'ready_for_generation'
                ? 'Plan ready'
                : 'Done'
              : current
                ? 'Now'
                : selected
                  ? 'Review'
                  : 'Next';
          return (
            <button
              key={group.key}
              type="button"
              disabled={!enabled}
              className={selected ? 'is-selected' : current ? 'is-current' : complete ? 'is-complete' : future ? 'is-future' : ''}
              aria-current={current ? 'step' : undefined}
              onClick={() => {
                if (targetStage && canOpenInternalStage(targetStage)) setViewStage(targetStage);
              }}
            >
              <span className="ov3-stage-rail__index">
                {complete ? <Check size={14} aria-hidden="true" /> : index + 1}
              </span>
              <span>
                <strong>{group.label}</strong>
                <small>{status}</small>
              </span>
            </button>
          );
        })}
      </nav>

      {controller.lifecycleErrorMessage ? (
        <div className="ov3-recovery is-danger ov3-lifecycle-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <div>
            <strong>The current campaign was not archived</strong>
            <p>{controller.lifecycleErrorMessage}</p>
          </div>
        </div>
      ) : null}

      {reviewCanContinue && viewStage !== 'ready_for_generation' ? (
        <div className="ov3-review-banner" role="status">
          <span>
            {deliberateReviewHold
              ? `${internalStageLabel(viewStage)} changes are saved. Keep reviewing here or continue when you are ready.`
              : 'Reviewing a completed checkpoint. Saving a change creates a new Campaign Spec version and may invalidate downstream readiness.'}
          </span>
          <button type="button" onClick={() => setViewStage(controller.stage)}>
            {deliberateReviewHold ? 'Continue to' : 'Return to'} {internalStageLabel(controller.stage)}
          </button>
        </div>
      ) : null}

      <main className="ov3-workbench">
        <CampaignBrief
          session={session}
          clients={clients}
          currentStage={controller.stage}
          onSelectStage={(stage) => {
            if (canOpenInternalStage(stage)) setViewStage(stage);
          }}
        />

        <section className="ov3-workbench__surface" aria-label={`${internalStageLabel(viewStage)} work surface`}>
          <CurrentDecisionSurface
            session={session}
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
        </section>

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
      </main>
    </div>
  );
}
