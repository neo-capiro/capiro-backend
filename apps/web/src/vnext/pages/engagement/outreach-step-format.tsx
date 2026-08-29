/**
 * Builder step 4 — Format. "Presentation only. The words come from the
 * template you picked — format changes how they are laid out."
 *
 * Two honest departures from the prototype, both disclosed in the UI or the
 * empty state rather than papered over:
 *
 *  1. The prototype badges a format "Recommended" when the selected template's
 *     id appears in that format's hard-coded `suits` list. No such signal
 *     exists here — the shared `OutreachEmailFormatOption` has no `suits`
 *     field, no server-side template↔format suitability exists, and inventing
 *     one would be a recommendation with nothing behind it. Only the
 *     plain-text option's "Safest" badge ships, which is a property of the
 *     format itself (`suitsAll`) rather than a claim about the template.
 *  2. The prototype previews a seeded specimen letter. This reads the
 *     campaign's own content skeleton off the spec; with no skeleton set the
 *     preview says so instead of showing a letter nobody wrote.
 *
 * The choice itself has no spec field. It is stored as campaign-scoped
 * `writing_guidance`, which steers generation but is not enforced — the
 * sentence the step prints under the tiles is the canonical statement of that
 * from `OUTREACH_UNWIRED_CONTROLS`, not a paraphrase.
 */
import { useState } from 'react';
import {
  acceptContextCommand,
  excludeContextCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import type {
  OutreachV3Command,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_EMAIL_FORMATS,
  OUTREACH_FORMAT_NOTE,
  outreachCampaignTypeLabel,
  type OutreachEmailFormatId,
  type OutreachEmailFormatOption,
} from './outreach-campaign-flow.js';
import {
  OUTREACH_FORMAT_MARKER,
  OUTREACH_UNWIRED_CONTROLS,
  outreachCampaignNameFromSpec,
  outreachEffectiveEmailFormat,
  outreachEmailFormatFromSpec,
  outreachEmailFormatSelection,
  outreachGuidanceRefsWithMarker,
  outreachSponsorFromSpec,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import { OUTREACH_FORMAT_PREVIEW_FOOTNOTE } from './outreach-email-format-preview.js';
import { OutreachFormatPreview } from './outreach-format-preview.js';
import { previewSkeleton } from './outreach-v3-skeleton-editing.js';
import type { OutreachContentSkeleton } from './outreach-v3-template-api.js';
import './outreach-builder.css';
import './outreach-step-format.css';

/**
 * The band bars are the prototype's literal hex, carried on the shared format
 * constants. This module's stylesheet is token-only, so each band maps to the
 * `--eng-*` name that holds exactly that value. An unrecognised band falls back
 * to the neutral border grey rather than emitting raw hex into the DOM.
 */
const BAND_TOKENS: Record<string, string> = {
  '#294E68': 'var(--eng-accent)',
  '#E4E7EC': 'var(--eng-border)',
  '#F2F4F7': 'var(--eng-muted)',
};

function bandColor(band: string): string {
  return BAND_TOKENS[band.toUpperCase()] ?? 'var(--eng-border)';
}

const FORMAT_UNWIRED_NOTE =
  OUTREACH_UNWIRED_CONTROLS.find((entry) => entry.control === 'Email format')?.reality ?? '';

/**
 * The campaign's content skeleton — what `SET_CONTENT_SKELETON` stores.
 *
 * `OutreachV3CampaignSpec` does not declare the field (the contract type
 * predates the command), so it is read structurally instead of asserted into a
 * shape the compiler cannot check. Anything that is not a string subject and
 * body reads as "no skeleton", which shows the empty preview.
 */
function campaignContentSkeleton(
  session: OutreachV3SessionEnvelope | null,
): OutreachContentSkeleton | null {
  const raw = (session?.spec as Record<string, unknown> | undefined)?.['contentSkeleton'];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const subject = typeof record['subject'] === 'string' ? record['subject'] : '';
  const body = typeof record['body'] === 'string' ? record['body'] : '';
  if (!subject.trim() && !body.trim()) return null;
  const rawSlots = Array.isArray(record['slots']) ? (record['slots'] as unknown[]) : [];
  const slots = rawSlots.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const slot = entry as Record<string, unknown>;
    const key = typeof slot['key'] === 'string' ? slot['key'] : '';
    if (!key) return [];
    return [
      {
        key,
        label: typeof slot['label'] === 'string' ? slot['label'] : key,
        instruction: typeof slot['instruction'] === 'string' ? slot['instruction'] : '',
        required: slot['required'] === true,
      },
    ];
  });
  return { subject, body, slots };
}

export function OutreachFormatStep(props: OutreachBuilderStepCommon): JSX.Element {
  const { session, campaignType, busy, applyCommands, onNext, primaryLabel } = props;
  const [applying, setApplying] = useState<OutreachEmailFormatId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = outreachEmailFormatFromSpec(session);
  const selected = outreachEffectiveEmailFormat(session, campaignType);

  const skeleton = campaignContentSkeleton(session);
  // The skeleton's `{{slot}}` tokens become their own labels, so the preview
  // reads as the letter the campaign will actually assemble rather than as
  // template source. Same renderer the template editor previews with.
  const letter = skeleton ? previewSkeleton(skeleton) : null;
  // The campaign name IS the subject line recipients see (the Name step says
  // so), which makes it the honest fallback when the skeleton carries none.
  const subject = letter?.subject.trim() || outreachCampaignNameFromSpec(session);
  const body = letter?.body ?? '';
  // Standing in for the prototype's template "who · cadence" line, which has no
  // real counterpart: these are the two facts the spec actually holds about who
  // this letter comes from.
  const kicker = [
    campaignType ? outreachCampaignTypeLabel(campaignType) : '',
    outreachSponsorFromSpec(session).label,
  ]
    .filter(Boolean)
    .join(' · ');

  const chooseFormat = async (format: OutreachEmailFormatOption) => {
    if (stored?.id === format.id || busy || applying) return;
    // Both halves ride one batch: the previous marker is superseded as the new
    // one lands, so two contradictory layout instructions never coexist.
    const superseded = outreachGuidanceRefsWithMarker(session, OUTREACH_FORMAT_MARKER);
    const commands: OutreachV3Command[] = [
      acceptContextCommand([outreachEmailFormatSelection(format)]),
    ];
    if (superseded.length > 0) {
      commands.push(
        excludeContextCommand(
          superseded.map((ref) => ({ contextKey: ref.contextKey, reason: 'superseded' as const })),
        ),
      );
    }
    setApplying(format.id);
    setError(null);
    try {
      await applyCommands(commands);
    } catch (cause) {
      // Without this the tile silently springs back to the saved format on the
      // next render and the user is left believing they chose the other one.
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'The email format could not be saved.',
      );
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="ocb-step ocb-split ocb-split--wide-aside">
      <div>
        <div className="ofmt-grid" role="radiogroup" aria-label="Email format">
          {OUTREACH_EMAIL_FORMATS.map((format) => {
            const on = selected.id === format.id;
            return (
              <button
                type="button"
                key={format.id}
                className="ofmt-tile"
                role="radio"
                aria-checked={on}
                disabled={busy || applying !== null}
                onClick={() => void chooseFormat(format)}
              >
                <span className="ofmt-thumb" aria-hidden="true">
                  {/* Plain text has no chrome to preview, so the standard
                      option shows body lines only — not greyed-out bands. */}
                  {format.bands ? (
                    <>
                      <span
                        className="ofmt-thumb__band ofmt-thumb__band--a"
                        style={{ background: bandColor(format.bands[0]) }}
                      />
                      <span
                        className="ofmt-thumb__band ofmt-thumb__band--b"
                        style={{ background: bandColor(format.bands[1]) }}
                      />
                      <span
                        className="ofmt-thumb__band ofmt-thumb__band--c"
                        style={{ background: bandColor(format.bands[2]) }}
                      />
                    </>
                  ) : null}
                  <span className="ofmt-thumb__lines">
                    <span className="ofmt-thumb__line ofmt-thumb__line--a" />
                    <span className="ofmt-thumb__line ofmt-thumb__line--b" />
                    <span className="ofmt-thumb__line ofmt-thumb__line--c" />
                  </span>
                </span>
                <span className="ofmt-tile__head">
                  <span className="ofmt-tile__name">{format.name}</span>
                  {format.suitsAll ? <span className="ofmt-badge">Safest</span> : null}
                </span>
                <span className="ofmt-tile__desc">{format.description}</span>
                <span className="ocb-radio" data-on={on ? 'true' : 'false'} aria-hidden="true" />
              </button>
            );
          })}
        </div>

        {error ? (
          <p className="ocb-note ocb-note--warn ofmt-note" role="alert">
            {error}
          </p>
        ) : null}

        <p className="ocb-note ofmt-note">{OUTREACH_FORMAT_NOTE}</p>
        {FORMAT_UNWIRED_NOTE ? (
          <p className="ocb-note ocb-note--muted ofmt-note">{FORMAT_UNWIRED_NOTE}</p>
        ) : null}

        <button
          type="button"
          className="ocb-btn ocb-btn--primary ofmt-next"
          disabled={busy || applying !== null}
          onClick={onNext}
        >
          {primaryLabel}
        </button>
      </div>

      <aside className="ofmt-aside">
        <span className="ocb-eyebrow">{`Preview · ${selected.name}`}</span>
        <OutreachFormatPreview
          format={selected}
          subject={subject}
          body={body}
          kicker={kicker}
        />
        <span className="ocb-note ocb-note--muted">{OUTREACH_FORMAT_PREVIEW_FOOTNOTE}</span>
      </aside>
    </div>
  );
}
