import { ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import type { Client } from '../../../pages/clients/clientTypes.js';
import {
  acceptContextCommand,
  excludeContextCommand,
  sponsorCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import type {
  OutreachV3Command,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_SPONSOR_CLIENT_DESCRIPTION,
  OUTREACH_SPONSOR_FIRM,
  OUTREACH_SPONSOR_UNDECIDED,
  outreachCampaignTypeLabel,
  type OutreachCampaignType,
} from './outreach-campaign-flow.js';
import {
  OUTREACH_SUBJECT_MARKER,
  outreachCampaignFacts,
  outreachCampaignNameFromSpec,
  outreachGoalCommandsFor,
  outreachGuidanceRefsWithMarker,
  outreachSponsorFromSpec,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import {
  subjectLineContextSelection,
} from './outreach-v3-guided-workflow.js';
import './outreach-step-name.css';

/**
 * Step 2 — "Name the campaign".
 *
 * The campaign name is the subject line, so it is not a display-only label: it
 * lands on `goal.topic` (through `workflowCampaignDefaults`, which derives the
 * objective / desired outcome / why-now from it) AND on a campaign-scoped
 * `writing_guidance` ref that tells the writer to use it verbatim. The sponsor
 * is the same click the old standalone sponsor stage asked for, folded in here
 * the way the prototype folds it.
 *
 * Two prototype behaviours are deliberately NOT reproduced, both because they
 * would put a value into the real Campaign Spec that the user never chose:
 *  - the input's seed value (the prototype ships a hardcoded campaign name that
 *    is byte-identical to its own placeholder, so the field looks filled on
 *    first paint). Here the seed is whatever the spec holds, and the prototype's
 *    string is used only as the placeholder it also is.
 *  - the sponsor's default selection of "Capiro · firm". A spec with no sponsor
 *    is `kind:'undecided'`, and "No sponsor yet" is exactly what that means, so
 *    the tile that reflects the real state is the one that gets selected.
 */

/** The prototype's placeholder, which is also its (unused here) seed value. */
const NAME_PLACEHOLDER = 'FY27 Ground Robotics — where the autonomy provision landed';

const NAME_HELP =
  'This is the subject line every recipient sees — not an internal label. Write it the way you want it to land in an inbox.';

const SPONSOR_HELP =
  'Who the campaign is sent on behalf of. A client sponsor scopes every later context read to that client; the firm sponsor keeps client-scoped material out entirely.';

const FOOTER_NOTE = 'Every confirmed change creates a new immutable Campaign Spec version.';

const ASIDE_LEDE =
  'Anything not set reads as not set rather than borrowing a neighbouring value.';

const ASIDE_PANEL_TITLE = 'What this step does not do';

const ASIDE_PANEL_BODY =
  'No client is required. No target is selected here. No draft is written and nothing is sent.';

/**
 * Returning the campaign to "no sponsor decided yet" is a state the server's
 * `SET_SPONSOR_SCOPE` schema accepts (`undecided` with no client refs), but the
 * shared `sponsorCommand` builder throws on it — it was written for the old
 * sponsor stage, where refusing to decide was not an option. Building the
 * command here keeps "No sponsor yet" a real control instead of one that
 * silently leaves a previously chosen sponsor in place. Lift it into
 * `commands.ts` when that guard is relaxed.
 */
const UNDECIDED_SPONSOR_COMMAND: OutreachV3Command = {
  type: 'SET_SPONSOR_SCOPE',
  schemaVersion: 1,
  payload: { kind: 'undecided', label: null, clientRefs: [] },
};

type SponsorChoice =
  | { kind: 'firm' }
  | { kind: 'undecided' }
  | { kind: 'client'; clientId: string; name: string };

interface SponsorTile {
  key: string;
  label: string;
  description: string;
  choice: SponsorChoice;
}

function sponsorKey(choice: SponsorChoice): string {
  return choice.kind === 'client' ? `client:${choice.clientId}` : choice.kind;
}

/**
 * The tile the saved spec corresponds to, or `null` when no tile can represent
 * it — a client sponsor whose client is not in this user's list, or one of the
 * spec's other sponsor kinds (`multi_client`, `coalition`, `internal_team`,
 * `none`) that this step does not offer. `null` leaves every tile unselected
 * rather than quietly re-pointing the sponsor at something else, and the aside
 * still reports the sponsor the spec actually carries.
 */
function sponsorKeyFromSpec(
  session: OutreachV3SessionEnvelope | null,
  clients: Client[],
): string | null {
  const sponsor = outreachSponsorFromSpec(session);
  if (sponsor.kind === 'firm') return 'firm';
  if (sponsor.kind === 'undecided') return 'undecided';
  if (sponsor.kind === 'client' && sponsor.clientId) {
    const known = clients.some((client) => client.id === sponsor.clientId);
    return known ? `client:${sponsor.clientId}` : null;
  }
  return null;
}

export interface OutreachNameStepProps extends OutreachBuilderStepCommon {
  clients: Client[];
  startedFrom: string;
}

export function OutreachNameStep(props: OutreachNameStepProps): JSX.Element {
  // The prototype associates the input with its label only by DOM nesting, so
  // the accessible name swallows the help text and the counter. An explicit
  // `for`/`aria-describedby` pair keeps the same click-to-focus behaviour with
  // a name a screen reader can actually use.
  const fieldId = useId();
  const nameId = `${fieldId}-name`;
  const nameHelpId = `${fieldId}-name-help`;
  const sponsorLabelId = `${fieldId}-sponsor`;

  const specName = outreachCampaignNameFromSpec(props.session);
  const specSponsorKey = sponsorKeyFromSpec(props.session, props.clients);

  // Local edits win until the saved value moves under them — a rail chip can
  // bring the user back after another step changed the spec, and the session
  // usually arrives after mount. Adjusting state during render is React's own
  // pattern for this; it costs one discarded render rather than an effect and
  // a visible flash.
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [seenName, setSeenName] = useState(specName);
  const [pendingSponsorKey, setPendingSponsorKey] = useState<string | null>(null);
  const [seenSponsorKey, setSeenSponsorKey] = useState(specSponsorKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (seenName !== specName) {
    setSeenName(specName);
    setPendingName(null);
  }
  if (seenSponsorKey !== specSponsorKey) {
    setSeenSponsorKey(specSponsorKey);
    setPendingSponsorKey(null);
  }

  const name = pendingName ?? specName;
  const selectedSponsorKey = pendingSponsorKey ?? specSponsorKey;
  const busy = props.busy || saving;

  const tiles: SponsorTile[] = [
    {
      key: 'firm',
      label: OUTREACH_SPONSOR_FIRM.label,
      description: OUTREACH_SPONSOR_FIRM.description,
      choice: { kind: 'firm' },
    },
    // The prototype hardcodes two client names. These are the firm's real
    // clients, carrying the prototype's own description string.
    ...props.clients.map((client) => ({
      key: `client:${client.id}`,
      label: client.name,
      description: OUTREACH_SPONSOR_CLIENT_DESCRIPTION,
      choice: { kind: 'client' as const, clientId: client.id, name: client.name },
    })),
    {
      key: 'undecided',
      label: OUTREACH_SPONSOR_UNDECIDED.label,
      description: OUTREACH_SPONSOR_UNDECIDED.description,
      choice: { kind: 'undecided' },
    },
  ];

  const selectedTile = tiles.find((tile) => tile.key === selectedSponsorKey) ?? null;
  // "No sponsor yet" is an absence, so it reads as "Not set" in the aside — the
  // aside's own copy promises nothing borrows a neighbouring value. When no tile
  // represents the saved sponsor, the spec's own label is what gets reported.
  const sponsorLabel = selectedTile
    ? selectedTile.choice.kind === 'undecided'
      ? ''
      : selectedTile.label
    : outreachSponsorFromSpec(props.session).label;

  // The aside is "Campaign so far", and the prototype updates it on every
  // keystroke — it reflects the pending edit, not the last saved version.
  const facts = outreachCampaignFacts({
    subjectLine: name,
    campaignTypeLabel: props.campaignType ? outreachCampaignTypeLabel(props.campaignType) : null,
    sponsorLabel,
    startedFrom: props.startedFrom,
  });

  const trimmedName = name.trim();

  function buildCommands(): OutreachV3Command[] {
    // The Name step is only reachable after the type step, so a missing type
    // means a deep link into a spec that has no goal yet. `goalCommands`
    // requires a goal phrase, and Custom is the type that asserts the least.
    const type: OutreachCampaignType = props.campaignType ?? 'custom';
    // Shared with the Campaign type step so the two never disagree about the
    // goal phrase — see `outreachGoalCommandsFor`.
    const commands: OutreachV3Command[] = [...outreachGoalCommandsFor(type, trimmedName)];

    // One subject-line marker, not a pile of them: re-pressing Continue without
    // changing the name must not add a second ref, and a changed name replaces
    // the old ref rather than leaving two contradictory instructions in the
    // packet. (`length !== 1` also cleans up a spec that already has duplicates.)
    const existing = outreachGuidanceRefsWithMarker(props.session, OUTREACH_SUBJECT_MARKER);
    if (existing.length !== 1 || specName !== trimmedName) {
      if (existing.length > 0) {
        commands.push(
          excludeContextCommand(
            existing.map((ref) => ({ contextKey: ref.contextKey, reason: 'superseded' as const })),
          ),
        );
      }
      commands.push(acceptContextCommand([subjectLineContextSelection(trimmedName)]));
    }

    const savedSponsor = outreachSponsorFromSpec(props.session);
    const choice = selectedTile?.choice;
    if (choice?.kind === 'firm' && savedSponsor.kind !== 'firm') {
      commands.push(sponsorCommand({ kind: 'firm', label: OUTREACH_SPONSOR_FIRM.label }));
    } else if (
      choice?.kind === 'client' &&
      (savedSponsor.kind !== 'client' || savedSponsor.clientId !== choice.clientId)
    ) {
      commands.push(
        sponsorCommand({ kind: 'client', label: choice.name, clientIds: [choice.clientId] }),
      );
    } else if (choice?.kind === 'undecided' && savedSponsor.kind !== 'undecided') {
      commands.push(UNDECIDED_SPONSOR_COMMAND);
    }

    return commands;
  }

  async function confirm(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      await props.applyCommands(buildCommands());
      setSaving(false);
      props.onNext();
    } catch (cause) {
      setSaving(false);
      // The prototype is synchronous seed state with no failure path, so it
      // advances unconditionally. Staying here with the reason shown is the
      // honest equivalent.
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The campaign name could not be saved.',
      );
    }
  }

  return (
    <div className="ocb-split ocb-split--narrow-aside osn">
      <div className="ocb-card osn__card">
        <div className="ocb-field">
          <label className="ocb-field__label" htmlFor={nameId}>
            Campaign name
            <span className="ocb-flag ocb-flag--required">REQUIRED</span>
          </label>
          <span className="ocb-field__help" id={nameHelpId}>
            {NAME_HELP}
          </span>
          <input
            id={nameId}
            type="text"
            className="ocb-input ocb-input--lg"
            value={name}
            placeholder={NAME_PLACEHOLDER}
            aria-describedby={nameHelpId}
            aria-required="true"
            disabled={busy}
            onChange={(event) => setPendingName(event.target.value)}
          />
          {/* The prototype has no plural form and no length thresholds — one
              constant grey line at every length. Reproduced as written. */}
          <span className="ocb-field__count">{`${name.length} characters`}</span>
        </div>

        <div className="osn__sponsor">
          <span className="ocb-field__label" id={sponsorLabelId}>
            Sponsor
            <span className="ocb-flag">OPTIONAL</span>
          </span>
          <p className="ocb-prose ocb-field__help osn__sponsor-help">{SPONSOR_HELP}</p>
          <div className="osn__sponsors" role="radiogroup" aria-labelledby={sponsorLabelId}>
            {tiles.map((tile) => {
              const on = tile.key === selectedSponsorKey;
              return (
                <label
                  key={tile.key}
                  className="ocb-option ocb-option--compact osn__tile"
                  data-selected={on ? 'true' : 'false'}
                >
                  <input
                    type="radio"
                    className="osn__input"
                    name={`${fieldId}-sponsor-group`}
                    value={tile.key}
                    checked={on}
                    disabled={busy}
                    onChange={() => setPendingSponsorKey(sponsorKey(tile.choice))}
                  />
                  <span className="ocb-radio" data-on={on ? 'true' : 'false'} aria-hidden="true" />
                  <span className="ocb-option__body">
                    <span className="ocb-option__title">{tile.label}</span>
                    <span className="ocb-option__desc">{tile.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="osn__footer">
          <span className="ocb-note">{FOOTER_NOTE}</span>
          {/*
            The prototype labels this field REQUIRED and then never enforces it —
            its Continue is an unconditional step change, so a blank name reaches
            the Drafts step as an empty subject line. Here the name IS the
            subject line and the topic the generator writes against, so the flag
            is honoured: an empty name disables Continue rather than shipping a
            promise the next step cannot keep.
          */}
          <button
            type="button"
            className="ocb-btn ocb-btn--primary osn__next"
            disabled={busy || trimmedName.length === 0}
            onClick={() => {
              void confirm();
            }}
          >
            {props.primaryLabel}
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          {error ? (
            <p className="ocb-note ocb-note--warn osn__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <aside className="ocb-card osn__aside" aria-label="Campaign so far">
        <span className="ocb-eyebrow">Campaign so far</span>
        <p className="ocb-prose osn__lede">{ASIDE_LEDE}</p>
        <div className="ocb-kv osn__facts">
          {facts.map((fact) => (
            <div key={fact.key} className="ocb-kv__row ocb-kv__row--narrow">
              <span className="ocb-kv__key">{fact.key}</span>
              <span className="ocb-kv__value" data-unset={fact.unset ? 'true' : 'false'}>
                {fact.value}
              </span>
            </div>
          ))}
        </div>
        <div className="ocb-inset osn__panel">
          <span className="osn__panel-title">{ASIDE_PANEL_TITLE}</span>
          <span className="osn__panel-body">{ASIDE_PANEL_BODY}</span>
        </div>
      </aside>
    </div>
  );
}
