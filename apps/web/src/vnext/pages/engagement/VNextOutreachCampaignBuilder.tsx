/**
 * The Outreach campaign builder.
 *
 * Nine steps — Campaign type · Name · Template · Format · Targets · Context ·
 * Review · Drafts · Send — over one server-owned Campaign Spec. This is the
 * Engagement V2 prototype's live wizard, step for step; the step machine itself
 * is in `outreach-campaign-flow.ts` and the spec mapping in
 * `outreach-builder-model.ts`.
 *
 * It replaces `VNextOutreachWorkspace`'s seven-step planning rail (`goal ·
 * targets · delivery · context · examples · drafts · send`). That shape came
 * from `outreachVals()` in the same prototype export — a method the prototype's
 * markup never binds. It was dead code being treated as a specification.
 *
 * Two things the shell owns that no step does:
 *
 *  - **Step repair.** The Format step exists only for campaign types that are
 *    not a meeting request. Switching type while standing on Format would
 *    otherwise leave the builder on a step with no rail chip, so every render
 *    resolves the requested step through `resolveOutreachBuilderStep`.
 *  - **Rail reachability.** Every chip is clickable in both directions. The
 *    prototype has no forward gating and neither does this: the gates that
 *    matter are on the actions (generate, send), not on navigation, and a rail
 *    that refuses to move hides work the user has already done.
 */
import { useCallback, useMemo } from 'react';
import {
  Bookmark,
  CheckSquare,
  FileText,
  Filter,
  Flag,
  LayoutGrid,
  Mail,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import { outreachV3CampaignBucket } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import { useOutreachMeetingAutoContext } from './use-outreach-meeting-auto-context.js';
import { useEngagementToast } from './engagement-toast.js';
import { useRovingFocus } from './use-roving-focus.js';
import {
  OUTREACH_BUILDER_STEP_ICONS,
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  outreachBuilderNextStep,
  outreachBuilderPrimaryLabel,
  outreachBuilderSetupCount,
  outreachBuilderStepIndex,
  outreachBuilderSteps,
  outreachCampaignTypeLabel,
  outreachReadyRecipientCount,
  resolveOutreachBuilderStep,
  type OutreachBuilderStep,
  type OutreachBuilderStepIcon,
} from './outreach-campaign-flow.js';
import {
  outreachBlockedTargets,
  outreachCampaignTypeFromSpec,
  outreachSelectedTargets,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import { OutreachCampaignTypeStep } from './outreach-step-campaign-type.js';
import { OutreachNameStep } from './outreach-step-name.js';
import { OutreachTemplateStep } from './outreach-step-template.js';
import { OutreachFormatStep } from './outreach-step-format.js';
import { OutreachTargetsStep } from './outreach-step-targets.js';
import { OutreachContextStep } from './outreach-step-context.js';
import { OutreachReviewStep } from './outreach-step-review.js';
import { OutreachDraftsStep } from './outreach-step-drafts.js';
import { OutreachSendStep } from './outreach-step-send.js';
import './outreach-builder.css';
import './outreach-builder-shell.css';

const STEP_ICON_COMPONENTS: Record<OutreachBuilderStepIcon, LucideIcon> = {
  flag: Flag,
  bookmark: Bookmark,
  file: FileText,
  grid: LayoutGrid,
  users: Users,
  filter: Filter,
  'check-square': CheckSquare,
  mail: Mail,
  target: Target,
};

export interface VNextOutreachCampaignBuilderProps {
  sessionId: string;
  clients: Client[];
  selectedClientId: string | null;
  /** The connected sending mailbox, for the Send step's "From" row. */
  senderLabel: string | null;
  /** That mailbox's connection id — what the send settings are saved against. */
  senderConnectionId: string | null;
  step: OutreachBuilderStep;
  onStepChange: (step: OutreachBuilderStep) => void;
  onExit: () => void;
  /**
   * What the campaign was started from ("Firm Template" / "Capiro Template"),
   * carried from the home screen's chooser. Absent on a deep link, where it
   * genuinely is not known — the Name step's summary then reads "Not set"
   * rather than guessing.
   */
  startedFrom?: string;
}

/**
 * "New campaign · Firm Template" / "Campaign · last updated 21 Aug".
 *
 * `started` — not the absence of `updatedAt` — decides which. Creating a
 * campaign writes a row, so a brand-new one already has an `updatedAt` of a few
 * seconds ago and the "New campaign" half would never be reachable. A campaign
 * with nothing chosen on it yet is the one the user has just started.
 */
function contextLabel(
  started: boolean,
  updatedAt: string | undefined,
  startedFrom: string | undefined,
): string {
  if (started && updatedAt) {
    const parsed = new Date(updatedAt);
    if (!Number.isNaN(parsed.getTime())) {
      const stamp = parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `Campaign · last updated ${stamp}`;
    }
  }
  return startedFrom ? `New campaign · ${startedFrom}` : 'New campaign';
}

export function VNextOutreachCampaignBuilder({
  sessionId,
  clients,
  selectedClientId,
  senderLabel,
  senderConnectionId,
  step: requestedStep,
  onStepChange,
  onExit,
  startedFrom,
}: VNextOutreachCampaignBuilderProps) {
  const toast = useEngagementToast();
  // Arrow / Home / End across the rail. The hook was written for this rail and
  // the destination tabs; only the tabs were ever wired to it.
  const onRailKeyDown = useRovingFocus();
  const {
    session,
    applyCommands,
    applyingCommands,
    isBootstrapping,
    errorMessage,
    ownedSessions,
  } = useOutreachV3Session({ sessionId });

  const campaignType = outreachCampaignTypeFromSpec(session);
  /*
   * `send_update` is the prototype's default `bWorkflow`, and the step machine
   * needs a concrete type to decide whether Format exists. Only the rail shape
   * uses this fallback — every step still receives the real `campaignType`,
   * `null` included, so none of them can mistake "not chosen yet" for a choice.
   */
  const railType = campaignType ?? 'send_update';
  const step = resolveOutreachBuilderStep(railType, requestedStep);
  const steps = outreachBuilderSteps(railType);
  const setupCount = outreachBuilderSetupCount(railType);
  const activeIndex = outreachBuilderStepIndex(railType, step);

  const targets = outreachSelectedTargets(session);
  const blocked = outreachBlockedTargets(session);
  const readyCount = outreachReadyRecipientCount(targets.length, blocked.length, 'ready');

  const goNext = useCallback(() => {
    const next = outreachBuilderNextStep(railType, step);
    if (next) onStepChange(next);
  }, [onStepChange, railType, step]);

  const common: OutreachBuilderStepCommon = useMemo(
    () => ({
      sessionId,
      session: session ?? null,
      campaignType,
      busy: applyingCommands,
      applyCommands: (commands) => applyCommands(commands),
      toast: toast.show,
      onNext: goNext,
      primaryLabel: outreachBuilderPrimaryLabel(step, railType, readyCount),
    }),
    [
      applyCommands,
      applyingCommands,
      campaignType,
      goNext,
      railType,
      readyCount,
      session,
      sessionId,
      step,
      toast.show,
    ],
  );

  /*
   * Request-a-meeting auto-context runs at the SHELL, not inside the Context
   * step: a user who rides the rail straight from Targets to Review still gets
   * the sponsor overview, capabilities, facilities and target career-background
   * attached before generation. Placing the effect here means it fires on every
   * step; its own guards (content-addressed dedup on the spec, the
   * retry-once signature) keep it a no-op once everything is attached.
   */
  useOutreachMeetingAutoContext({
    session: session ?? null,
    applyCommands: common.applyCommands,
  });

  const StepIcon = STEP_ICON_COMPONENTS[OUTREACH_BUILDER_STEP_ICONS[step]];

  /*
   * The header pill states the campaign's real record status. `recordStatus`
   * lives on the list projection rather than the session envelope, so it is
   * read from the owned-session list when that is loaded and falls back to the
   * envelope's own archived/active flag otherwise — never to an invented
   * "Sent".
   */
  const summary = ownedSessions?.find((row) => row.id === sessionId);
  const statusLabel = summary
    ? { archived: 'Archived', sent: 'Sent', draft: 'Draft' }[outreachV3CampaignBucket(summary)]
    : session?.session.status === 'archived'
      ? 'Archived'
      : 'Draft';
  const statusTone =
    statusLabel === 'Sent' ? 'eng-pill--navy' : 'eng-pill--gray';

  return (
    <div className="ocb">
      <div className="ocb-head">
        <div className="ocb-head__main">
          <span className="ocb-head__icon" aria-hidden="true">
            <StepIcon size={20} />
          </span>
          <div className="ocb-head__body">
            <span className="ocb-head__context">
              {contextLabel(campaignType !== null, session?.session.updatedAt, startedFrom)}
              <button type="button" className="ocb-head__leave" onClick={onExit}>
                Leave
              </button>
            </span>
            <h2 className="ocb-head__title">{OUTREACH_BUILDER_STEP_TITLES[step]}</h2>
            <p className="ocb-head__sub">{OUTREACH_BUILDER_STEP_SUBLINES[step]}</p>
          </div>
        </div>
        <span className={`eng-pill ${statusTone}`}>{statusLabel}</span>
      </div>

      <nav className="ocb-rail" aria-label="Campaign steps" onKeyDown={onRailKeyDown}>
        {steps.slice(0, setupCount).map((def, index) => (
          <button
            key={def.key}
            type="button"
            className="ocb-rail__step"
            data-active={index === activeIndex ? 'true' : undefined}
            data-visited={index < activeIndex ? 'true' : undefined}
            aria-current={index === activeIndex ? 'step' : undefined}
            onClick={() => onStepChange(def.key)}
          >
            <span className="ocb-rail__num">{index + 1}</span>
            {def.label}
          </button>
        ))}
        <span className="ocb-rail__divider" aria-hidden="true" />
        {steps.slice(setupCount).map((def, index) => {
          const railIndex = index + setupCount;
          return (
            <button
              key={def.key}
              type="button"
              className="ocb-rail__after"
              data-active={railIndex === activeIndex ? 'true' : undefined}
              data-visited={railIndex < activeIndex ? 'true' : undefined}
              aria-current={railIndex === activeIndex ? 'step' : undefined}
              onClick={() => onStepChange(def.key)}
            >
              {def.label}
            </button>
          );
        })}
      </nav>

      {/*
        `errorMessage` is the hook's single error surface: it folds the session
        READ and every command WRITE into one value. Only a failed read means
        the campaign could not be loaded — a rejected write happens with the
        campaign fully in hand, and replacing the whole builder with a
        load-failure panel would throw away the name the user just typed, their
        open editor and every unsaved note, for a save that can simply be
        retried. Each step reports its own write failure in place.
      */}
      {errorMessage && !session ? (
        <div className="ocb-shell-state" role="alert">
          <span className="ocb-shell-state__title">This campaign could not be loaded</span>
          <p className="ocb-shell-state__body">{errorMessage}</p>
          <button type="button" className="ocb-btn ocb-btn--secondary" onClick={onExit}>
            Back to campaigns
          </button>
        </div>
      ) : isBootstrapping && !session ? (
        <div className="ocb-shell-state">
          <span className="ocb-shell-state__title">Loading the campaign…</span>
          <p className="ocb-shell-state__body">
            Reading the current Campaign Spec. Nothing is written until you confirm a step.
          </p>
        </div>
      ) : (
        <StepBody
          step={step}
          common={common}
          clients={clients}
          selectedClientId={selectedClientId}
          senderLabel={senderLabel}
          senderConnectionId={senderConnectionId}
          startedFrom={startedFrom ?? ''}
          onGenerationStarted={() => onStepChange('drafts')}
          onOpenDrafts={() => onStepChange('drafts')}
        />
      )}
    </div>
  );
}

function StepBody({
  step,
  common,
  clients,
  selectedClientId,
  senderLabel,
  senderConnectionId,
  startedFrom,
  onGenerationStarted,
  onOpenDrafts,
}: {
  step: OutreachBuilderStep;
  common: OutreachBuilderStepCommon;
  clients: Client[];
  selectedClientId: string | null;
  senderLabel: string | null;
  senderConnectionId: string | null;
  startedFrom: string;
  onGenerationStarted: () => void;
  onOpenDrafts: () => void;
}) {
  switch (step) {
    case 'workflow':
      return <OutreachCampaignTypeStep {...common} startedFrom={startedFrom} />;
    case 'name':
      return <OutreachNameStep {...common} clients={clients} startedFrom={startedFrom} />;
    case 'update':
      return <OutreachTemplateStep {...common} />;
    case 'format':
      return <OutreachFormatStep {...common} />;
    case 'targets':
      return <OutreachTargetsStep {...common} selectedClientId={selectedClientId} />;
    case 'context':
      return <OutreachContextStep {...common} />;
    case 'review':
      return <OutreachReviewStep {...common} onGenerationStarted={onGenerationStarted} />;
    case 'drafts':
      return <OutreachDraftsStep {...common} />;
    case 'send':
      return (
        <OutreachSendStep
          {...common}
          senderLabel={senderLabel}
          senderConnectionId={senderConnectionId}
          onOpenDrafts={onOpenDrafts}
        />
      );
  }
}

/** Re-exported so the routes file can type its step state without a second import. */
export type { OutreachBuilderStep };
export { outreachCampaignTypeLabel };
