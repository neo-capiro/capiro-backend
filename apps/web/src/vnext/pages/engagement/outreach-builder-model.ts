/**
 * How the prototype's builder steps read and write the real Campaign Spec.
 *
 * The prototype keeps its wizard in local state. The real campaign is a
 * server-owned, versioned Campaign Spec reached only through commands, and its
 * schema has no field for three of the prototype's decisions (campaign type,
 * email format, template knobs). This module is where that mapping lives, so a
 * step component never has to know it:
 *
 *   campaign type  -> `goal.goal` (the phrase the existing generator already
 *                     keys on), read back through `inferOutreachWorkflowTemplate`
 *   campaign name  -> `goal.topic` AND a campaign-scoped `writing_guidance` ref
 *                     titled "Campaign subject line"
 *   sponsor        -> `SET_SPONSOR_SCOPE`
 *   email format   -> a campaign-scoped `writing_guidance` ref titled
 *                     "Campaign email format · <name>"
 *
 * The format and the knobs are INSTRUCTIONS to the writer, not enforcement:
 * nothing server-side validates that a generated draft came out as a briefing
 * card. That distinction is reported to the user rather than hidden — see
 * `OUTREACH_UNWIRED_CONTROLS`.
 *
 * Reading a marker back by its `title` is safe: the command engine copies
 * `locator.title` onto the resolved ref verbatim (see
 * `outreach-command-engine.service.spec.ts`'s `resolvedManualContext`), and
 * `subjectLineContextSelection` has relied on it since the guided flow shipped.
 */

import type {
  OutreachV3CampaignSpec,
  OutreachV3Command,
  OutreachV3ContextSelection,
  OutreachV3ResolvedContextRef,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  deliveryCommands,
  excludeContextCommand,
  goalCommands,
  strategyCommands,
  targetCriteriaCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import {
  OUTREACH_EMAIL_FORMATS,
  OUTREACH_STANDARD_EMAIL_FORMAT,
  type OutreachCampaignType,
  type OutreachEmailFormatOption,
} from './outreach-campaign-flow.js';
import { workflowCampaignDefaults } from './outreach-v3-guided-workflow.js';

/* ------------------------------------------------------------------ *
 * Campaign type
 * ------------------------------------------------------------------ */

/**
 * The `goal.goal` phrase each campaign type writes. These exact strings are
 * what `inferOutreachWorkflowTemplate` matches on, and what the generation
 * prompt reads as the campaign's purpose, so they are not display copy and must
 * not be reworded to match the step's tile labels.
 */
const CAMPAIGN_TYPE_GOAL_PHRASE: Record<OutreachCampaignType, string> = {
  request_meeting: 'Request a meeting',
  send_update: 'Send a client update',
  custom: 'Custom campaign',
};

export function outreachCampaignTypeGoalPhrase(type: OutreachCampaignType): string {
  return CAMPAIGN_TYPE_GOAL_PHRASE[type];
}

/**
 * The campaign type a saved spec represents.
 *
 * Returns `null` — not a default — when the spec has no goal yet, so the
 * builder can tell "the user has not chosen" from "the user chose Custom".
 *
 * The exact-phrase pass has to come first. The substring pass behind it is a
 * legacy reader for specs the guided flow wrote, where a custom campaign's goal
 * is the sentence `Advance <campaign name>` — so a campaign named "FY27 budget
 * update" would read back as `send_update` and silently change which steps the
 * rail offers. Campaigns written by this builder always carry the canonical
 * phrase and never reach the fallback.
 */
export function outreachCampaignTypeFromSpec(
  session: OutreachV3SessionEnvelope | null,
): OutreachCampaignType | null {
  const raw = session?.spec.goal.goal?.trim() ?? '';
  if (!raw) return null;
  const canonical = (Object.keys(CAMPAIGN_TYPE_GOAL_PHRASE) as OutreachCampaignType[]).find(
    (type) => CAMPAIGN_TYPE_GOAL_PHRASE[type] === raw,
  );
  if (canonical) return canonical;
  const goal = raw.toLowerCase();
  if (goal.includes('meeting')) return 'request_meeting';
  if (goal.includes('update')) return 'send_update';
  return 'custom';
}

/**
 * The goal draft to write for a campaign type and name.
 *
 * Both the Campaign type step and the Name step write the goal, so the phrase
 * has to be decided in one place — otherwise the two steps disagree about what
 * a custom campaign's `goal.goal` says and the type read back depends on which
 * step the user touched last.
 *
 * `workflowCampaignDefaults` supplies the objective / desired outcome / ask /
 * why-now that the generator reads; its `goal` field is overridden here because
 * it phrases a custom campaign as `Advance <name>`, which does not round-trip.
 *
 * `whyNowOverride` lets the Name step carry a real scheduling window / timing
 * hook ("in DC the week of Oct 6") instead of the derived boilerplate, and both
 * steps pass the saved spec value back through so confirming a step never
 * clobbers a why-now the user already saved. Three states, deliberately:
 *  - `undefined` — no override information; derive the default (today's shape,
 *    so existing callers and tests are untouched).
 *  - `string` — a non-empty user value; it wins.
 *  - `null` — the user cleared the field; why-now is explicitly cleared.
 */
export function outreachGoalCommandsFor(
  type: OutreachCampaignType,
  campaignName: string,
  whyNowOverride?: string | null,
): OutreachV3Command[] {
  const trimmed = campaignName.trim();
  if (!trimmed) {
    /*
     * Nothing has named the campaign yet. `workflowCampaignDefaults` requires a
     * name and derives the objective, desired outcome, ask and why-now from it,
     * so calling it here would invent prose the user never wrote — and
     * `goalCommands` rejects a draft with any field missing. Record the type
     * alone; the Name step fills the rest in.
     *
     * The command is a literal because `commands.ts` exports builders for whole
     * decisions, not a bare `command()` helper. Keeping it here means exactly
     * one file in the builder knows the wire shape.
     */
    return [
      { type: 'SET_GOAL', schemaVersion: 1, payload: { value: outreachCampaignTypeGoalPhrase(type) } },
    ];
  }
  const defaults = workflowCampaignDefaults({ templateId: type, campaignName: trimmed });
  const override =
    whyNowOverride === undefined
      ? undefined
      : whyNowOverride && whyNowOverride.trim()
        ? whyNowOverride.trim()
        : null;
  return [
    ...goalCommands({
      ...defaults.goal,
      goal: outreachCampaignTypeGoalPhrase(type),
      topic: trimmed,
      ...(override !== undefined ? { whyNow: override } : {}),
    }),
    /*
     * The strategy half is NOT optional. `deriveOutreachReadiness` blocks
     * generation with STRATEGY_INCOMPLETE until `campaignAngle`, `tone` and a
     * decided `length` all exist, and `workflowCampaignDefaults` computes all
     * three from the same campaign type and name. Sending only the goal half —
     * which is what this did at first — left every campaign built by this
     * builder unable to generate a draft, with the server's only explanation
     * being a generic "complete the review packet".
     */
    ...strategyCommands(defaults.strategy),
  ];
}

/* ------------------------------------------------------------------ *
 * Campaign name (the subject line)
 * ------------------------------------------------------------------ */

export const OUTREACH_SUBJECT_MARKER = 'Campaign subject line';
export const OUTREACH_FORMAT_MARKER = 'Campaign email format';
export const OUTREACH_TEMPLATE_OPTIONS_MARKER = 'Campaign template options';
/**
 * Was a private, independently-duplicated literal in both
 * `outreach-step-template.tsx` (`TEMPLATE_GUIDANCE_MARKER`) and
 * `outreach-step-context.tsx` (`UPDATE_TEMPLATE_MARKER`). Exported so
 * `outreachTypeChangeInvalidationCommands` below can supersede it without a
 * third copy of the string drifting from the other two.
 */
export const OUTREACH_TEMPLATE_MARKER = 'Update template — ';

export function outreachCampaignNameFromSpec(
  session: OutreachV3SessionEnvelope | null,
): string {
  return session?.spec.goal.topic?.trim() ?? '';
}

/* ------------------------------------------------------------------ *
 * Writing-guidance markers
 * ------------------------------------------------------------------ */

function writingGuidanceRefs(
  session: OutreachV3SessionEnvelope | null,
): OutreachV3ResolvedContextRef[] {
  return session?.spec.context.writingGuidanceRefs ?? [];
}

/** Every campaign-scoped guidance ref whose title starts with `marker`. */
export function outreachGuidanceRefsWithMarker(
  session: OutreachV3SessionEnvelope | null,
  marker: string,
): OutreachV3ResolvedContextRef[] {
  return writingGuidanceRefs(session).filter((ref) => ref.title.startsWith(marker));
}

/**
 * Excludes every writing-guidance ref that only makes sense for the campaign
 * type being LEFT, so a type switch cannot leave a stale marker behind for a
 * later step to read back as if it still applied.
 *
 * Observed live: switching an existing campaign from an update-style type to
 * Custom left its old template selection's `Update template — …` ref active.
 * Nothing in the Custom flow ever revisits or supersedes that ref (Custom's
 * own Template step has no template to confirm), so
 * `outreachContextSelectedTemplate` kept resolving it, and the Context step
 * kept rendering that stale template's ten options — with the "Sources"
 * panel any OTHER context would use hidden behind them, since a step reads
 * `optionSet` from whatever template resolves, real or stale. Generation
 * would have kept following those options too: a writing-guidance ref is
 * unconditionally usable evidence for the writer, with no server-side notion
 * of "the template that wrote this is no longer selected."
 *
 * The subject-line marker is deliberately NOT included — a campaign's name
 * does not become invalid when its type changes; the Name step's own save
 * keeps that one current.
 */
export function outreachTypeChangeInvalidationCommands(
  session: OutreachV3SessionEnvelope | null,
): OutreachV3Command[] {
  const stale = [
    ...outreachGuidanceRefsWithMarker(session, OUTREACH_TEMPLATE_MARKER),
    ...outreachGuidanceRefsWithMarker(session, OUTREACH_FORMAT_MARKER),
    ...outreachGuidanceRefsWithMarker(session, OUTREACH_TEMPLATE_OPTIONS_MARKER),
  ];
  if (stale.length === 0) return [];
  return [
    excludeContextCommand(
      stale.map((ref) => ({ contextKey: ref.contextKey, reason: 'superseded' as const })),
    ),
  ];
}

/**
 * A campaign-scoped writing-guidance selection. `title` doubles as the marker
 * the reader matches on, so it is built here rather than at each call site.
 */
export function outreachGuidanceSelection(input: {
  title: string;
  text: string;
}): OutreachV3ContextSelection {
  return {
    locator: {
      source: 'manual',
      id: crypto.randomUUID(),
      title: input.title,
      text: input.text,
      sourceLabel: 'outreach_review_packet',
    },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
  };
}

/* ------------------------------------------------------------------ *
 * Email format
 * ------------------------------------------------------------------ */

export function outreachEmailFormatSelection(
  format: OutreachEmailFormatOption,
): OutreachV3ContextSelection {
  return outreachGuidanceSelection({
    title: `${OUTREACH_FORMAT_MARKER} · ${format.name}`,
    text: `Lay every destination in this campaign out as a ${format.name.toLowerCase()}: ${format.description}`,
  });
}

/**
 * The format a saved spec carries, or `null` when none has been chosen.
 *
 * Matches on the format NAME in the marker title rather than on the guidance
 * text, so an edit to the instruction wording cannot silently orphan the
 * selection. The most recently added marker wins, because switching format
 * writes a new ref and drops the old one in the same command batch — if a
 * failure ever left both, the newer one is the user's actual choice.
 */
export function outreachEmailFormatFromSpec(
  session: OutreachV3SessionEnvelope | null,
): OutreachEmailFormatOption | null {
  const markers = outreachGuidanceRefsWithMarker(session, OUTREACH_FORMAT_MARKER);
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    const title = markers[i]?.title ?? '';
    const name = title.slice(OUTREACH_FORMAT_MARKER.length).replace(/^\s*·\s*/, '').trim();
    const match = OUTREACH_EMAIL_FORMATS.find((format) => format.name === name);
    if (match) return match;
  }
  return null;
}

/**
 * The format to render with. A meeting request has no format step, so it is
 * always plain text regardless of what an earlier campaign type may have
 * written into the spec.
 */
export function outreachEffectiveEmailFormat(
  session: OutreachV3SessionEnvelope | null,
  campaignType: OutreachCampaignType | null,
): OutreachEmailFormatOption {
  if (campaignType === 'request_meeting') return OUTREACH_STANDARD_EMAIL_FORMAT;
  return outreachEmailFormatFromSpec(session) ?? OUTREACH_STANDARD_EMAIL_FORMAT;
}

/* ------------------------------------------------------------------ *
 * Sponsor
 * ------------------------------------------------------------------ */

export interface OutreachSponsorSelection {
  kind: OutreachV3CampaignSpec['sponsor']['kind'];
  label: string;
  clientId: string | null;
}

export function outreachSponsorFromSpec(
  session: OutreachV3SessionEnvelope | null,
): OutreachSponsorSelection {
  const sponsor = session?.spec.sponsor;
  return {
    kind: sponsor?.kind ?? 'undecided',
    label: sponsor?.label?.trim() ?? '',
    clientId: sponsor?.clientRefs?.[0]?.clientId ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

export function outreachSelectedTargets(
  session: OutreachV3SessionEnvelope | null,
): OutreachV3ResolvedTargetRef[] {
  return session?.spec.targeting.selectedTargetRefs ?? [];
}

/**
 * A target with no address cannot be sent to. `emailStatus` is authoritative
 * when the server supplies it; the bare `email` field is the fallback for
 * older refs that predate it.
 */
export function outreachTargetIsSendable(target: OutreachV3ResolvedTargetRef): boolean {
  if (target.emailStatus === 'missing' || target.emailStatus === 'invalid') return false;
  return Boolean(target.email && target.email.trim());
}

export function outreachBlockedTargets(
  session: OutreachV3SessionEnvelope | null,
): OutreachV3ResolvedTargetRef[] {
  return outreachSelectedTargets(session).filter((target) => !outreachTargetIsSendable(target));
}

/**
 * Groups of selected targets that share ONE office, for the office-level
 * dedupe warning: four staffers in the same member office each get the same
 * personalized pitch with no cross-awareness, which reads as a form blast to
 * the office that receives it. Nothing is blocked — a multi-staffer office is
 * sometimes deliberate — but the user should choose it, not stumble into it.
 *
 * "Office" is the server-resolved `organization` string (member office name,
 * committee name), normalized case/whitespace-insensitively. Targets with no
 * organization are never grouped: an unknown office is not the SAME office.
 * Groups are returned largest-first; members keep selection order.
 */
export function outreachSameOfficeGroups(
  targets: OutreachV3ResolvedTargetRef[],
): Array<{ office: string; targets: OutreachV3ResolvedTargetRef[] }> {
  const byOffice = new Map<string, { office: string; targets: OutreachV3ResolvedTargetRef[] }>();
  for (const target of targets) {
    const office = target.organization?.trim();
    if (!office) continue;
    const key = office.toLowerCase().replace(/\s+/g, ' ');
    const group = byOffice.get(key);
    if (group) group.targets.push(target);
    else byOffice.set(key, { office, targets: [target] });
  }
  return [...byOffice.values()]
    .filter((group) => group.targets.length > 1)
    .sort((a, b) => b.targets.length - a.targets.length);
}

/** The warning sentence both the Targets and Review steps print. */
export function outreachSameOfficeWarning(
  groups: Array<{ office: string; targets: OutreachV3ResolvedTargetRef[] }>,
): string | null {
  if (groups.length === 0) return null;
  const parts = groups.map(
    (group) => `${group.office} (${group.targets.length} recipients)`,
  );
  return (
    `Multiple recipients share the same office: ${parts.join('; ')}. ` +
    'Each gets their own separately-generated email with no mention of the others — ' +
    'an office comparing notes will see near-identical messages. Keep them all if that is deliberate, ' +
    'or trim to the best-placed contact per office.'
  );
}

/** "4 recipients · one email each" / "1 recipient · one email". */
export function outreachRecipientSummary(count: number): string {
  return count === 1 ? '1 recipient · one email' : `${count} recipients · one email each`;
}

/**
 * The spec fields generation requires that the prototype has no control for.
 *
 * `deriveOutreachReadiness` blocks generation on TARGET_CRITERIA_MISSING until
 * `targeting.criteria` is non-null, and on DELIVERY_UNDECIDED until both
 * delivery fields are decided. The prototype asks for neither: it has no
 * criteria form, and its delivery decision is implicit in list-vs-group. So
 * both are derived here rather than invented:
 *
 *  - criteria DESCRIBES the selection the user actually made — the chambers,
 *    states, committees and levels present in it, and whether they picked
 *    staff, principals or both. It is not a filter they never set.
 *  - delivery is only defaulted when it is still `undecided`. Saving or
 *    applying a GROUP sets `shared_thread` in the Targets step, and that must
 *    never be silently overwritten by a later target edit — a group becoming
 *    one-email-each without the user asking is the disclosure failure this
 *    flow exists to prevent.
 */
export function outreachGenerationSpecCommands(
  session: OutreachV3SessionEnvelope | null,
  targets: OutreachV3ResolvedTargetRef[],
  campaignType: OutreachCampaignType | null,
): OutreachV3Command[] {
  if (targets.length === 0) return [];
  const commands: OutreachV3Command[] = [];

  /*
   * The spec's criteria vocabulary is a closed enum server-side
   * (`targetCriteriaV1Schema`), but a resolved target's jurisdiction is not:
   * `chamber` comes from the Directory as free text, and a manual locator
   * reports `governmentLevel: 'unknown'`. Sending either straight through is
   * rejected as OUTREACH_COMMAND_INVALID and takes the whole accept with it.
   *
   * So each field is narrowed to the vocabulary the spec actually has, and
   * anything outside it is dropped rather than coerced. Criteria is a
   * description of the selection; asserting a chamber the schema has no word
   * for would be inventing one.
   */
  const GOVERNMENT_LEVELS = ['federal', 'state', 'local', 'agency', 'mixed'];
  const CHAMBERS = ['house', 'senate', 'state_house', 'state_senate'];

  const uniq = (values: Array<string | null | undefined>, allowed?: string[]): string[] => {
    const cleaned = values
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter(Boolean)
      .filter((value) => !allowed || allowed.includes(value));
    return [...new Set(cleaned)].sort();
  };

  /** Free text the schema bounds at 120 chars and rejects when empty. */
  const uniqText = (values: Array<string | null | undefined>): string[] => {
    const cleaned = values
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0 && value.length <= 120);
    return [...new Set(cleaned)].sort().slice(0, 100);
  };

  const isStaff = (target: OutreachV3ResolvedTargetRef): boolean =>
    String(target.locator['source'] ?? '').includes('staff');

  /*
   * Each half is written ONLY when it is missing. That is not an optimisation:
   * accepting the packet derives the generation request key from the approval
   * hash, which moves with the state version — so a batch sent on every accept
   * would give a retry after a failed start a different key, and mint a second
   * backend job instead of resolving to the first. Re-deriving criteria the
   * campaign already has buys nothing (the gate checks only that it is
   * non-null) and costs that idempotency.
   */
  if (session && session.spec.targeting.criteria === null) {
    commands.push(
      targetCriteriaCommand({
        governmentLevels: uniq(
          targets.map((t) => t.jurisdiction.governmentLevel),
          GOVERNMENT_LEVELS,
        ),
        chambers: uniq(
          targets.map((t) => t.jurisdiction.chamber),
          CHAMBERS,
        ),
        committees: uniqText(targets.flatMap((t) => t.jurisdiction.committees)),
        states: uniqText(targets.map((t) => t.jurisdiction.state)),
        includeStaff: targets.some(isStaff),
        includePrincipals: targets.some((t) => !isStaff(t)),
      }),
    );
  }

  const delivery = session?.spec.delivery;
  if (delivery && (delivery.pattern === 'undecided' || delivery.personalization === 'undecided')) {
    // The prototype's default shape: one tailored email per person.
    commands.push(...deliveryCommands('personalized_separate', 'high'));
  }

  /*
   * The Campaign type and Name steps write the strategy, but a campaign
   * created before they did — or one whose type was never confirmed — reaches
   * here with STRATEGY_INCOMPLETE and no step left to fix it, since the user
   * has already walked past both. Filling it from the type and name the
   * campaign already carries heals that without sending them backwards.
   */
  const strategy = session?.spec.strategy;
  const name = outreachCampaignNameFromSpec(session);
  const strategyComplete = Boolean(
    strategy?.campaignAngle && strategy?.tone && strategy?.length !== 'undecided',
  );
  if (session && !strategyComplete && name) {
    const defaults = workflowCampaignDefaults({
      templateId: campaignType ?? 'send_update',
      campaignName: name,
    });
    commands.push(...strategyCommands(defaults.strategy));
  }

  return commands;
}

/* ------------------------------------------------------------------ *
 * "Campaign so far" — the Name step's aside
 * ------------------------------------------------------------------ */

export interface OutreachCampaignFact {
  key: string;
  value: string;
  /** True when nothing is set, so the row renders in the muted "Not set" tone. */
  unset: boolean;
}

const NOT_SET = 'Not set';

/**
 * Anything not set reads as "Not set" rather than borrowing a neighbouring
 * value — the prototype states that promise in the aside's own copy, so an
 * empty string must never fall through to a default here.
 */
export function outreachCampaignFacts(input: {
  subjectLine: string;
  campaignTypeLabel: string | null;
  sponsorLabel: string;
  startedFrom: string;
}): OutreachCampaignFact[] {
  const row = (key: string, value: string | null): OutreachCampaignFact => {
    const trimmed = value?.trim() ?? '';
    return { key, value: trimmed || NOT_SET, unset: !trimmed };
  };
  return [
    row('Subject line', input.subjectLine),
    row('Campaign type', input.campaignTypeLabel),
    row('Sponsor', input.sponsorLabel),
    row('Started from', input.startedFrom),
  ];
}

/* ------------------------------------------------------------------ *
 * Honest reporting of what is not wired
 * ------------------------------------------------------------------ */

/**
 * Controls the prototype shows that no endpoint backs. They are built, because
 * the standing rule is to build the UI ahead of the backend and say which
 * controls are not wired — not to quietly drop them. Each entry names what
 * actually happens today.
 */
export const OUTREACH_UNWIRED_CONTROLS: Array<{ control: string; reality: string }> = [
  {
    control: 'Email format',
    reality:
      'The Campaign Spec has no format field. The choice is stored as campaign writing guidance, so it steers generation but nothing validates the result.',
  },
  {
    control: 'Campaign subject line',
    reality:
      'The campaign name is stored as goal.topic and as campaign writing guidance telling the writer to use it verbatim. Each generated draft version carries its own subject; nothing validates that it matches.',
  },
  {
    control: 'Per-template context options',
    reality:
      'Stored as campaign writing guidance alongside the format. There is no per-template options field on the spec.',
  },
  {
    control: 'Send scheduling',
    reality: 'The send contract creates immediate intents only. "Send now" is the only real path.',
  },
  {
    control: 'Send pacing',
    reality: 'Provider policy governs pacing; there is no per-campaign pacing setting to save.',
  },
];

/* ------------------------------------------------------------------ *
 * The contract every step component is written against
 * ------------------------------------------------------------------ */

export interface OutreachBuilderStepCommon {
  sessionId: string;
  session: OutreachV3SessionEnvelope | null;
  /** `null` until the user has chosen on the first step. */
  campaignType: OutreachCampaignType | null;
  /** A command batch is in flight; primary actions disable. */
  busy: boolean;
  applyCommands: (commands: OutreachV3Command[]) => Promise<unknown>;
  /** Announce a completed action. Matches the prototype's toast copy. */
  toast: (message: string) => void;
  /** Advance to this step's successor. */
  onNext: () => void;
  /** The label the prototype puts on this step's primary button. */
  primaryLabel: string;
}
