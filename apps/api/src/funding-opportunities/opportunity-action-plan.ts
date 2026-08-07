import { createHash } from 'node:crypto';
import type { InboxSource } from './funding-opportunity-inbox.service.js';
import { FORECAST_INBOX_SOURCE } from './funding-opportunity-inbox.service.js';
import type { OpportunityActionIntent } from './funding-opportunity-actions.service.js';
import type { OpportunityKind } from './funding-opportunities.types.js';
import type { LandscapeItem } from './government-landscape.types.js';

/**
 * The deterministic action plan (Funding Opportunities P34).
 *
 * ── Proposals, not commitments ───────────────────────────────────────────────
 *
 * Nothing here writes anything. Every action is a PROPOSAL a human accepts, and
 * accepting one goes through P08's existing idempotent server action — the same
 * path a hand-created pursuit takes, so a plan-accepted task and a manual one
 * are the same kind of row and neither can exist without its workflow update.
 *
 * That is why the module is pure. A plan that could create tasks would be a plan
 * that creates tasks nobody asked for the moment a page is opened.
 *
 * ── One task per INTENT, not one per action ──────────────────────────────────
 *
 * P08 keys its task on `<source>:<sourceRecordId>:<intent>`, deliberately, so a
 * double-clicked button and a replayed mutation land on one task. That key is
 * NOT widened here. The consequence is real and is surfaced rather than papered
 * over: accepting a second `review`-intent action returns the FIRST task with
 * `reused: true` and re-points the opportunity's next action, instead of opening
 * a second task.
 *
 * Widening the key to include the action would have been the easy alternative
 * and is worse — it would make the plan a second task-creating path with its own
 * idempotency rules, and the whole point of P08 was that there is one.
 *
 * ── Stage decides the plan, and a closed notice gets a different one ─────────
 *
 * The rules key on the acquisition's own lifecycle stage, because what a team
 * should DO is a function of where the acquisition is, not of how much Capiro
 * likes the fit. A sources-sought notice wants a response and a vehicle answer;
 * a solicitation wants a compliance matrix and submission milestones; an
 * amendment wants a reassessment of what changed.
 *
 * A CLOSED or INFORMATIONAL notice produces MONITOR and REFERENCE actions only,
 * and a FORECAST produces shaping and monitoring only. Neither ever produces a
 * pursuit action, however strong the fit — the same judgement `NON_PURSUABLE_KINDS`
 * and P26's `FORECAST_FORBIDDEN_ACTIONS` already encode, applied here so the plan
 * cannot propose what the writer would refuse. {@link assertStageAllowsIntents}
 * enforces it structurally rather than trusting each branch to remember.
 *
 * ── Never invent a warm introduction ─────────────────────────────────────────
 *
 * A target is named only when a SOURCE-BACKED landscape item names it.
 * {@link buildActionPlan} takes P33's packet and reads only items whose basis is
 * `source_backed`; an inferred one — a keyword-resembling PE match, say —
 * contributes nothing to a target. "Reach out to the programme office for PE
 * 0605898N" on the strength of a NAICS coincidence is exactly the fabricated
 * relationship this rule exists to prevent, and it is the kind of mistake that
 * costs a client credibility rather than a bid.
 *
 * A target is also never a PERSON. Capiro holds no reviewed relationship join
 * for an opportunity yet — P33 reports both `reviewed_relationship` and
 * `acquisition_personnel` as `not_wired` — so naming an individual would be
 * inventing the introduction outright. An office identified by PE code is a
 * checkable fact; "your contact at the programme office" is not.
 *
 * ── Unresolved prerequisites are stated, not silently assumed ────────────────
 *
 * An action that depends on something Capiro does not have carries it in
 * `unresolvedPrerequisites`. "Draft the compliance matrix" with no requirements
 * extracted is a step somebody will start and stall on; saying so up front is
 * the difference between a plan and a wish list.
 *
 * ── No clock ─────────────────────────────────────────────────────────────────
 *
 * `asOf` comes from the caller. Same packet and same `asOf` produce a
 * byte-identical plan, ids and fingerprint included, which is what the phase's
 * determinism bar actually asks for and what makes the plan diffable.
 */

/**
 * Declaration order IS the presentation order, and it follows the order a team
 * would actually work: decide whether to play, influence what gets asked, answer
 * what was asked, gather what the answer needs, then watch, then file.
 *
 * `qualify` leads for that reason. Sorting a solicitation's plan alphabetically
 * would put "Build the compliance matrix" above "Make the bid/no-bid decision",
 * which is a running order that starts with the expensive step.
 */
export const ACTION_CATEGORIES = [
  'qualify',
  'shape',
  'respond',
  'research',
  'monitor',
  'reference',
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/**
 * How an accepted action becomes real.
 *
 * `review` and `pursuit` are P08's own intents, imported rather than re-spelt so
 * the two vocabularies cannot drift. `none` is this module's addition, for a
 * reference action that is information rather than work — it creates nothing,
 * and the UI offers no accept control for it.
 */
export const ACTION_INTENTS = ['review', 'pursuit', 'none'] as const;
export type ActionIntent = OpportunityActionIntent | 'none';

export interface ActionEvidence {
  source: string;
  sourceId: string;
  /** The verbatim value that connected the two things. Never a paraphrase. */
  matchedOn: string;
}

export interface ProposedAction {
  /** Stable within a plan, derived from the plan's own inputs. Never random. */
  id: string;
  category: ActionCategory;
  title: string;
  /** Why this action, in one sentence composed from facts. */
  rationale: string;
  /** How accepting it becomes a task. `none` means there is nothing to create. */
  intent: ActionIntent;
  /**
   * The landscape items this action rests on. Empty is honest and common: an
   * action that follows from the STAGE alone needs no evidence beyond the notice
   * being what it is.
   */
  evidence: ActionEvidence[];
  /**
   * A named office, and ONLY from a source-backed item. Null is the common case
   * and is never filled with a guess.
   */
  suggestedTarget: string | null;
  /** What the due date is derived FROM. Null whenever `dueDate` is null. */
  dueDateBasis: string | null;
  dueDate: string | null;
  /** Things Capiro does not have that this action needs. */
  unresolvedPrerequisites: string[];
}

export interface ActionPlan {
  source: InboxSource;
  sourceRecordId: string;
  clientId: string;
  stage: PlanStage;
  actions: ProposedAction[];
  /** Stable over the actions. Same inputs, same plan, same hash. */
  fingerprint: string;
  generatedAt: string;
}

/**
 * The stage vocabulary the rules key on.
 *
 * Derived from the opportunity's source, kind and activity — never from the fit
 * score. What a team should DO is a function of where the acquisition is.
 */
export const PLAN_STAGES = [
  'forecast',
  'sources_sought',
  'presolicitation',
  'solicitation',
  'amendment',
  'grant',
  'closed_or_informational',
] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

/**
 * Intents each stage may propose. The forecast and closed lists exclude
 * `pursuit` structurally — see {@link assertStageAllowsIntents}.
 */
export const STAGE_ALLOWED_INTENTS: Record<PlanStage, ReadonlySet<ActionIntent>> = {
  forecast: new Set<ActionIntent>(['review', 'none']),
  closed_or_informational: new Set<ActionIntent>(['review', 'none']),
  sources_sought: new Set<ActionIntent>(['review', 'pursuit', 'none']),
  presolicitation: new Set<ActionIntent>(['review', 'pursuit', 'none']),
  solicitation: new Set<ActionIntent>(['review', 'pursuit', 'none']),
  amendment: new Set<ActionIntent>(['review', 'pursuit', 'none']),
  grant: new Set<ActionIntent>(['review', 'pursuit', 'none']),
};

export interface PlanInput {
  source: InboxSource;
  sourceRecordId: string;
  clientId: string;
  kind: OpportunityKind;
  /** False for a closed or withdrawn notice. */
  isActive: boolean;
  /** False for an award or special notice. The same flag the pursuit guard reads. */
  isPursuable: boolean;
  /** ISO instant, or null when the source states none. Never invented. */
  responseDeadline: string | null;
  /** P33's packet items. ONLY source-backed ones ever produce a target. */
  landscape: readonly LandscapeItem[];
  /** True when P31 has extracted at least one requirement for this notice. */
  hasRequirements: boolean;
  /** True when P23 reports a current, usable vehicle position for the client. */
  hasVehicleAccess: boolean;
  /** The caller's clock. There is deliberately no `new Date()` in this module. */
  asOf: Date;
}

/**
 * Which stage the rules apply.
 *
 * FORECAST is decided by source and wins outright: a forecast has no deadline to
 * respond to and no notice type to classify, and P26 already forbids `pursue`
 * and `submit` on one. Then `closed_or_informational`, because a closed
 * solicitation is not a solicitation to respond to and an award notice is not a
 * competition.
 */
export function planStageFor(
  input: Pick<PlanInput, 'source' | 'kind' | 'isActive' | 'isPursuable'>,
): PlanStage {
  if (input.source === FORECAST_INBOX_SOURCE) return 'forecast';
  if (!input.isActive || !input.isPursuable) return 'closed_or_informational';
  switch (input.kind) {
    case 'sources_sought':
      return 'sources_sought';
    case 'presolicitation':
      return 'presolicitation';
    case 'solicitation':
    case 'combined_synopsis_solicitation':
      return 'solicitation';
    case 'amendment':
      return 'amendment';
    case 'grant':
    case 'cooperative_agreement':
      return 'grant';
    default:
      // `special_notice` and `award_notice` are already caught by `isPursuable`.
      // `other` reaching here means the normalizer has not been taught this
      // notice type, and a reference action is the honest response to a stage
      // nobody has classified — not a guess at the nearest one.
      return 'closed_or_informational';
  }
}

/** Source-backed only. An inferred item never names a target. */
function sourceBacked(items: readonly LandscapeItem[]): LandscapeItem[] {
  return items.filter((i) => i.basis === 'source_backed');
}

function evidenceOf(items: readonly LandscapeItem[]): ActionEvidence[] {
  return items.map((i) => ({ source: i.source, sourceId: i.sourceId, matchedOn: i.matchedOn }));
}

/**
 * A due date derived from the response deadline, with the derivation NAMED.
 *
 * `dueDateBasis` is not decoration. A date with no stated basis is a date
 * somebody will move without knowing what it was protecting; "21 days before the
 * stated response deadline" tells a reader what breaks if they slip it.
 *
 * Returns null when the notice states no deadline, and there is deliberately no
 * fallback to "two weeks from now": a fabricated due date on a solicitation with
 * no stated deadline is the most confidently wrong thing this plan could emit.
 * A date already in the past is still returned — a deadline that leaves no room
 * is a fact the reader needs, and quietly clamping it to today would hide it.
 */
function beforeDeadline(
  responseDeadline: string | null,
  days: number,
  label: string,
): Pick<ProposedAction, 'dueDate' | 'dueDateBasis'> {
  if (responseDeadline == null) return { dueDate: null, dueDateBasis: null };
  const at = new Date(responseDeadline);
  if (Number.isNaN(at.getTime())) return { dueDate: null, dueDateBasis: null };
  return {
    dueDate: new Date(at.getTime() - days * 86_400_000).toISOString(),
    dueDateBasis: `${days} days before the stated response deadline (${label})`,
  };
}

/**
 * The plan. PURE and deterministic: same input, byte-identical output including
 * the fingerprint and every action id.
 */
export function buildActionPlan(input: PlanInput): ActionPlan {
  const stage = planStageFor(input);
  const backed = sourceBacked(input.landscape);
  const peItems = backed.filter((i) => i.source === 'program_element');
  const districtItems = backed.filter((i) => i.source === 'congressional_district');

  const actions: ProposedAction[] = [];
  const add = (action: Omit<ProposedAction, 'id'>) =>
    actions.push({ ...action, id: actionId(input, action.category, action.title) });

  switch (stage) {
    case 'closed_or_informational':
      add({
        category: 'reference',
        title: 'Keep for reference',
        rationale:
          'This notice is closed, withdrawn or informational. There is nothing to respond to, and it is kept because it informs capture planning for the same requirement next time.',
        intent: 'none',
        evidence: evidenceOf(peItems),
        suggestedTarget: null,
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites: [],
      });
      add({
        category: 'monitor',
        title: 'Watch for a follow-on notice',
        rationale:
          'An agency that closed or cancelled a requirement frequently reposts it, and a repost is easy to miss.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites: [],
      });
      break;

    case 'forecast':
      // A forecast is the only stage at which the requirement itself can still
      // change. None of these carry a due date: the provider resource states no
      // anticipated solicitation date at all (P26's `anticipatedSolicitationDate`
      // is a documented constant null), and deriving one from the award estimate
      // would invent a milestone the agency never published.
      add({
        category: 'shape',
        title: 'Shape the requirement before a solicitation posts',
        rationale:
          'A forecast is the last point at which a requirement can still be influenced. Once a solicitation posts the requirement is fixed, and the only remaining move is to answer it.',
        intent: 'review',
        evidence: evidenceOf(peItems),
        suggestedTarget: targetFromProgramElements(peItems),
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites: [],
      });
      add({
        category: 'research',
        title: 'Prepare a capability briefing for the programme office',
        rationale:
          'A briefing before the requirement is written is how a programme office learns what is buyable. After it is written, the same conversation is a protest risk.',
        intent: 'review',
        evidence: evidenceOf(peItems),
        suggestedTarget: targetFromProgramElements(peItems),
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites:
          peItems.length > 0
            ? []
            : [
                // Names the real reason. Capiro composes government-landscape
                // context for SAM.gov notices only, so a forecast never has a
                // source-backed programme link to draw an office from — saying
                // "none found" would read as a finding about the programme.
                'Capiro composes government-landscape context for SAM.gov notices only, so no programme office is named for a forecast yet.',
              ],
      });
      add({
        category: 'monitor',
        title: 'Watch for the solicitation',
        rationale:
          'A forecast states no solicitation date. Watching the crosswalk for a matching notice is the only reliable way to catch the transition.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites: [],
      });
      break;

    case 'sources_sought':
      add({
        category: 'respond',
        title: 'Respond to the sources-sought notice',
        rationale:
          'A sources-sought response is how the agency learns this client exists, and it feeds the set-aside decision. Not responding is a decision too.',
        intent: 'pursuit',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 3, 'sources-sought response'),
        unresolvedPrerequisites: [],
      });
      add({
        category: 'respond',
        title: 'Ask the contracting officer to clarify scope',
        rationale:
          'A sources-sought notice states a requirement loosely on purpose. Clarifying questions at this stage are welcomed and shape what eventually gets solicited.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 5, 'clarifying questions'),
        unresolvedPrerequisites: [],
      });
      add({
        category: 'qualify',
        title: 'Identify the acquisition route or a teaming partner',
        rationale: vehicleRationale(input.hasVehicleAccess),
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites: vehiclePrerequisites(input.hasVehicleAccess),
      });
      break;

    case 'presolicitation':
      add({
        category: 'qualify',
        title: 'Validate the acquisition path',
        rationale:
          'A presolicitation is the last stage at which a vehicle or teaming gap can be closed without schedule pressure.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 14, 'acquisition path validation'),
        unresolvedPrerequisites: vehiclePrerequisites(input.hasVehicleAccess),
      });
      add({
        category: 'qualify',
        title: 'Build the capture plan',
        rationale:
          'The solicitation is coming. A capture plan written now is the difference between a considered bid and a rushed one.',
        intent: 'pursuit',
        evidence: evidenceOf(peItems),
        suggestedTarget: targetFromProgramElements(peItems),
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites: [],
      });
      break;

    case 'solicitation':
      add({
        category: 'qualify',
        title: 'Make the bid/no-bid decision',
        rationale:
          'A solicitation has a fixed close. The decision has to be made early enough to leave time to write.',
        intent: 'pursuit',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 21, 'bid/no-bid decision'),
        unresolvedPrerequisites: [],
      });
      add({
        category: 'respond',
        title: 'Submit questions to the contracting officer',
        rationale:
          'A question deadline almost always precedes the response deadline, and questions are the only sanctioned way to change an unworkable requirement.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 14, 'question submission'),
        // The real question deadline lives in the solicitation document. Capiro
        // has it only when P31 extracted it, and saying so beats presenting a
        // derived date as the agency's own.
        unresolvedPrerequisites: input.hasRequirements
          ? []
          : ['The agency’s own question deadline has not been extracted from the documents.'],
      });
      add({
        category: 'respond',
        title: 'Build the compliance matrix',
        rationale:
          'A compliance matrix is the only way to prove every stated requirement is answered, and it is built from the solicitation text rather than from the notice header.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 10, 'compliance matrix'),
        unresolvedPrerequisites: input.hasRequirements
          ? []
          : ['No requirements have been extracted from this solicitation’s documents yet.'],
      });
      add({
        category: 'respond',
        title: 'Set the submission milestones',
        rationale:
          'Submission is a dated event with a hard close. Working the milestones back from it is what makes the close survivable.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 5, 'submission dry run'),
        unresolvedPrerequisites: [],
      });
      break;

    case 'amendment':
      add({
        category: 'qualify',
        title: 'Reassess the affected requirements and dates',
        rationale:
          'An amendment changes something. Until somebody reads what, an in-progress response is being written against a superseded document.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 7, 'amendment reassessment'),
        unresolvedPrerequisites: input.hasRequirements
          ? []
          : ['The amended requirements have not been extracted, so what changed is not yet listed.'],
      });
      break;

    case 'grant':
      add({
        category: 'qualify',
        title: 'Confirm eligibility and cost share',
        rationale:
          'A grant’s eligible-applicant list and cost-share requirement are pass/fail gates, and both are stated in the notice rather than inferred from the client’s profile.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 21, 'eligibility and cost share'),
        unresolvedPrerequisites: [],
      });
      add({
        category: 'qualify',
        title: 'Line up the required partners',
        rationale:
          'Grant programmes routinely require a named partner or sub-recipient, and a partner found in the last fortnight is a partner nobody has diligenced.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        ...beforeDeadline(input.responseDeadline, 30, 'partner commitments'),
        unresolvedPrerequisites: [],
      });
      add({
        category: 'research',
        title: 'Contact the programme office',
        rationale:
          'Grant programme officers answer eligibility and scope questions before submission, and the notice itself names the office to ask.',
        intent: 'review',
        evidence: [],
        suggestedTarget: null,
        dueDateBasis: null,
        dueDate: null,
        unresolvedPrerequisites: [],
      });
      break;
  }

  // ── Cross-stage: a district connection is worth an action of its own, and
  // ONLY when a source-backed item established it. P33 derives district items
  // from a STATE overlap between the notice's place of performance and a
  // recorded facility, so the wording says delegation rather than implying a
  // geocoded district nobody computed.
  if (districtItems.length > 0) {
    add({
      category: 'research',
      title: 'Brief the congressional offices covering the client’s facility',
      rationale:
        'A recorded client facility sits in the state this notice names as its place of performance. That is a constituent interest, and it is source-backed on both sides.',
      intent: 'review',
      evidence: evidenceOf(districtItems),
      suggestedTarget: targetFromDistricts(districtItems),
      dueDateBasis: null,
      dueDate: null,
      unresolvedPrerequisites: [],
    });
  }

  return finish(input, stage, actions);
}

/**
 * A named target, and only from a SOURCE-BACKED Program Element.
 *
 * Never a person — see the module note on inventing introductions.
 */
function targetFromProgramElements(items: readonly LandscapeItem[]): string | null {
  if (items.length === 0) return null;
  return `Programme office for ${[...new Set(items.map((i) => i.matchedOn))].sort().join(', ')}`;
}

function targetFromDistricts(items: readonly LandscapeItem[]): string | null {
  if (items.length === 0) return null;
  return `Congressional delegation for ${[...new Set(items.map((i) => i.matchedOn))].sort().join(', ')}`;
}

function vehicleRationale(hasVehicleAccess: boolean): string {
  return hasVehicleAccess
    ? 'The client holds a current, usable vehicle position. Confirm this notice can be competed on it before committing.'
    : 'Capiro has no confirmed vehicle access for this client. A vehicle or a teaming partner has to exist before a response is worth writing.';
}

function vehiclePrerequisites(hasVehicleAccess: boolean): string[] {
  return hasVehicleAccess
    ? []
    : ['No current, usable contract-vehicle position is recorded for this client.'];
}

/**
 * A stable id for one action within one plan, derived from the plan's inputs and
 * the action's own identity. Never random, so the same plan produces the same
 * ids across requests — which is what lets a UI track which proposals a user has
 * already dealt with without a table to store them in.
 */
function actionId(
  input: Pick<PlanInput, 'source' | 'sourceRecordId' | 'clientId'>,
  category: ActionCategory,
  title: string,
): string {
  return createHash('sha256')
    .update([input.source, input.sourceRecordId, input.clientId, category, title].join(' '))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The structural guarantee behind "a closed notice never proposes a pursuit".
 *
 * A thrown error rather than a silent downgrade: a rule that produced a pursuit
 * for a forecast is a bug in the rule, and quietly rewriting its intent would
 * ship the bug with a plausible-looking plan on top of it.
 */
export function assertStageAllowsIntents(stage: PlanStage, actions: readonly ProposedAction[]) {
  const allowed = STAGE_ALLOWED_INTENTS[stage];
  const offender = actions.find((a) => !allowed.has(a.intent));
  if (offender) {
    throw new Error(
      `Action plan rule produced intent "${offender.intent}" for stage "${stage}" (action: ${offender.title}).`,
    );
  }
}

function finish(input: PlanInput, stage: PlanStage, actions: ProposedAction[]): ActionPlan {
  assertStageAllowsIntents(stage, actions);

  // A TOTAL order, for the same reason P33's packet has one: a fingerprint that
  // moved must mean the plan moved, not that two actions swapped places.
  const rank = new Map<string, number>(ACTION_CATEGORIES.map((c, i) => [c, i]));
  const ordered = [...actions].sort((a, b) => {
    const byCategory = (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99);
    if (byCategory !== 0) return byCategory;
    const byTitle = a.title.localeCompare(b.title);
    return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
  });

  return {
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    clientId: input.clientId,
    stage,
    actions: ordered,
    // Over the FACTS of the plan — id, category, intent, target, due date and
    // prerequisites. A re-worded rationale does not move it; a changed target or
    // a newly-resolved prerequisite does. `generatedAt` is excluded on purpose:
    // re-observing the same plan an hour later is not a change to the plan.
    fingerprint: createHash('sha256')
      .update(
        ordered
          .map((a) =>
            [
              a.id,
              a.category,
              a.intent,
              a.suggestedTarget ?? '',
              a.dueDate ?? '',
              a.unresolvedPrerequisites.join('|'),
            ].join(' '),
          )
          .join(''),
      )
      .digest('hex'),
    generatedAt: input.asOf.toISOString(),
  };
}

/** True when any action in the plan would create a pursuit. */
export function hasPursuitAction(plan: Pick<ActionPlan, 'actions'>): boolean {
  return plan.actions.some((a) => a.intent === 'pursuit');
}
