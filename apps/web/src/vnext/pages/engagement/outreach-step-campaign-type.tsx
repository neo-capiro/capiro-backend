import { useState } from 'react';
import {
  OUTREACH_CAMPAIGN_TYPES,
  outreachBuilderPrimaryLabel,
  type OutreachCampaignType,
} from './outreach-campaign-flow.js';
import {
  outreachCampaignNameFromSpec,
  outreachGoalCommandsFor,
  outreachTypeChangeInvalidationCommands,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import './outreach-step-campaign-type.css';

/**
 * Step 1 — "What kind of campaign is this?".
 *
 * The prototype's first step is three radio tiles and an ungated Continue. The
 * campaign type has no field on the Campaign Spec, so it is written the way the
 * generator already reads it: `outreachGoalCommandsFor` synthesizes the goal /
 * objective / desired outcome / ask from the type and the campaign name, and
 * `outreachCampaignTypeFromSpec` reads the type back out of `goal.goal`.
 * Nothing else on this screen touches the server.
 */

/**
 * The prototype's `bWorkflow` default (`s.bWorkflow || 'Send update'`) — used
 * only when the spec has no type yet, never to overwrite a saved one.
 */
const DEFAULT_CAMPAIGN_TYPE: OutreachCampaignType = 'send_update';

export function OutreachCampaignTypeStep(props: OutreachBuilderStepCommon): JSX.Element {
  // The prototype's tile click writes local wizard state and nothing else, so a
  // mis-click costs nothing. Confirming is what reaches the spec, which keeps
  // the promise the Name step footer makes: a new immutable version is created
  // per confirmed change, not per click.
  const [pending, setPending] = useState<OutreachCampaignType | null>(null);
  const [savedSeen, setSavedSeen] = useState<OutreachCampaignType | null>(props.campaignType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The session usually arrives after mount, and a rail chip can bring the user
  // back here after the type changed elsewhere. Either way the local pick is
  // stale and must not keep overriding the spec, so it is dropped as soon as
  // the saved value moves. (Adjusting state during render is React's own
  // pattern for this; it costs one discarded render, not an effect + flash.)
  if (savedSeen !== props.campaignType) {
    setSavedSeen(props.campaignType);
    setPending(null);
  }

  const selected = pending ?? props.campaignType ?? DEFAULT_CAMPAIGN_TYPE;
  const busy = props.busy || saving;

  // The prototype re-labels this button the instant a tile is clicked, before
  // anything is saved (`wWorkflowLabel: 'Continue with ' + wf`). The shell can
  // only know the saved type, so `props.primaryLabel` is used whenever the two
  // agree and recomputed — from the same shared formula, never an inline
  // string — while the local pick is ahead of the spec.
  const primaryLabel =
    selected === props.campaignType
      ? props.primaryLabel
      : outreachBuilderPrimaryLabel('workflow', selected);

  async function confirmCampaignType(): Promise<void> {
    setError(null);

    // Re-writing the same type would create a Campaign Spec version identical
    // to the current one for no user-visible change.
    if (selected === props.campaignType) {
      props.onNext();
      return;
    }

    // The goal phrase belongs to one writer. This step and the Name step both
    // set it, so they share `outreachGoalCommandsFor` — otherwise a custom
    // campaign's `goal.goal` says something different depending on which of
    // the two the user touched last, and the type read back changes with it.
    //
    // A type change also invalidates whatever template/format/per-template
    // options the OLD type wrote: switching to "Request a meeting" makes a
    // stale Format marker linger unread but still fed to the writer, and
    // switching to "Custom" leaves a stale template marker that the Context
    // step keeps resolving — rendering that old template's options and
    // hiding the Sources panel a Custom campaign should show instead.
    const commands = [
      ...outreachGoalCommandsFor(selected, outreachCampaignNameFromSpec(props.session)),
      ...outreachTypeChangeInvalidationCommands(props.session),
    ];

    setSaving(true);
    try {
      await props.applyCommands(commands);
      setSaving(false);
      // Changing the type can invalidate the step the user was heading for —
      // "Request a meeting" has no Format step. The shell repairs that through
      // `resolveOutreachBuilderStep`, so this step only has to advance.
      props.onNext();
    } catch (cause) {
      setSaving(false);
      // The prototype is synchronous seed state and has no failure path at all.
      // Staying on the step with the reason shown is the honest equivalent of
      // its unconditional advance.
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The campaign type could not be saved.',
      );
    }
  }

  return (
    <div className="ocb-step ocb-stack octype">
      <div className="ocb-stack" role="radiogroup" aria-label="Campaign type">
        {OUTREACH_CAMPAIGN_TYPES.map((option) => {
          const on = option.id === selected;
          return (
            <label
              key={option.id}
              className="ocb-option octype__tile"
              data-selected={on ? 'true' : 'false'}
            >
              <input
                type="radio"
                className="octype__input"
                name="outreach-campaign-type"
                value={option.id}
                checked={on}
                disabled={busy}
                onChange={() => setPending(option.id)}
              />
              <span className="ocb-radio" data-on={on ? 'true' : 'false'} aria-hidden="true" />
              <span className="ocb-option__body">
                <span className="ocb-option__title">{option.label}</span>
                <span className="ocb-option__desc">{option.description}</span>
              </span>
            </label>
          );
        })}
      </div>

      {error ? (
        <p className="ocb-note ocb-note--warn" role="alert">
          {error}
        </p>
      ) : null}

      {/* Ungated by design: a type is always selected, so the prototype has no
          disabled state here and none is invented. `busy` is the only thing
          that stops it, and only while a batch is actually in flight. */}
      <button
        type="button"
        className="ocb-btn ocb-btn--primary octype__continue"
        disabled={busy}
        onClick={() => {
          void confirmCampaignType();
        }}
      >
        {primaryLabel}
      </button>
    </div>
  );
}
