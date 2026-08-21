import type {
  OutreachV3Command,
  OutreachV3ContextClass,
  OutreachV3ContextScope,
  OutreachV3DeliveryPattern,
  OutreachV3Length,
  OutreachV3Personalization,
  OutreachV3SponsorKind,
  OutreachV3TargetCandidate,
  OutreachV3TargetLocator,
} from './contracts.js';

function command<T>(type: string, payload: T): OutreachV3Command<T> {
  return { type, schemaVersion: 1, payload };
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export interface GoalDraft {
  goal: string;
  objective: string;
  topic: string;
  desiredOutcome: string;
  askMode: 'explicit' | 'none';
  askText: string;
  whyNow: string;
}

export function goalCommands(draft: GoalDraft): OutreachV3Command[] {
  const goal = required(draft.goal, 'Campaign goal');
  const objective = required(draft.objective, 'Objective');
  const topic = required(draft.topic, 'Topic');
  const desiredOutcome = required(draft.desiredOutcome, 'Desired outcome');
  const ask =
    draft.askMode === 'none'
      ? command('SET_ASK', { mode: 'none', text: null })
      : command('SET_ASK', {
          mode: 'explicit',
          text: required(draft.askText, 'Explicit ask'),
        });
  return [
    command('SET_GOAL', { value: goal }),
    command('SET_OBJECTIVE', { value: objective }),
    command('SET_TOPIC', { value: topic }),
    command('SET_DESIRED_OUTCOME', { value: desiredOutcome }),
    ask,
    command('SET_WHY_NOW', { value: nullable(draft.whyNow) }),
  ];
}

export function sponsorCommand(input: {
  kind: OutreachV3SponsorKind;
  label?: string | null;
  clientIds?: string[];
}): OutreachV3Command {
  const label = nullable(input.label ?? '');
  const uniqueClientIds = [...new Set(input.clientIds ?? [])];
  const clientIds =
    input.kind === 'client' || input.kind === 'multi_client' ? uniqueClientIds : [];

  if (input.kind === 'undecided') throw new Error('Choose a sponsor scope.');
  if (input.kind === 'client' && clientIds.length !== 1) {
    throw new Error('One-client sponsor scope requires exactly one client.');
  }
  if (input.kind === 'multi_client' && clientIds.length < 2) {
    throw new Error('Several-clients sponsor scope requires at least two clients.');
  }
  if (input.kind === 'coalition' && !label) {
    throw new Error('Coalition sponsor scope requires a name.');
  }

  return command('SET_SPONSOR_SCOPE', {
    kind: input.kind,
    label,
    clientRefs: clientIds.map((clientId) => ({ clientId })),
  });
}

export function targetCriteriaCommand(input: {
  notes?: string;
  governmentLevels?: string[];
  chambers?: string[];
  committees?: string[];
  agencies?: string[];
  states?: string[];
  relationshipPreference?: 'any' | 'existing' | 'new' | 'mixed';
  includeStaff?: boolean;
  includePrincipals?: boolean;
}): OutreachV3Command {
  return command('SET_TARGET_CRITERIA', {
    value: {
      notes: nullable(input.notes ?? ''),
      governmentLevels: input.governmentLevels ?? [],
      chambers: input.chambers ?? [],
      committees: input.committees ?? [],
      agencies: input.agencies ?? [],
      states: input.states ?? [],
      relationshipPreference: input.relationshipPreference ?? 'any',
      includeStaff: input.includeStaff ?? true,
      includePrincipals: input.includePrincipals ?? true,
    },
  });
}

export function addTargetCommand(
  target: OutreachV3TargetCandidate | OutreachV3TargetLocator,
): OutreachV3Command {
  const locator = 'locator' in target ? target.locator : target;
  return command('ADD_TARGET_REFS', { refs: [locator] });
}

export function removeTargetCommand(targetKey: string): OutreachV3Command {
  return command('REMOVE_TARGET_REFS', { targetKeys: [required(targetKey, 'Target key')] });
}

export function rejectTargetRecommendationCommand(input: {
  recommendationRef: string;
  targetKey: string;
  reason?: 'not_relevant' | 'wrong_jurisdiction' | 'wrong_role' | 'already_covered' | 'other';
}): OutreachV3Command {
  return command('REJECT_TARGET_RECOMMENDATION', {
    recommendationRef: required(input.recommendationRef, 'Recommendation reference'),
    targetKey: required(input.targetKey, 'Target key'),
    reason: input.reason ?? 'not_relevant',
  });
}

export function deliveryCommands(
  pattern: OutreachV3DeliveryPattern,
  personalization: OutreachV3Personalization,
): OutreachV3Command[] {
  if (pattern === 'undecided' || personalization === 'undecided') {
    throw new Error('Choose a delivery pattern and personalization level.');
  }
  if (pattern === 'shared_thread' && personalization === 'high') {
    throw new Error('High per-recipient personalization is incompatible with a shared thread.');
  }
  const setPattern = command('SET_DELIVERY_PATTERN', { value: pattern });
  const setPersonalization = command('SET_PERSONALIZATION', { value: personalization });
  /**
   * Order matters, and it is not cosmetic. The reducer validates each command
   * against the state the previous one left behind, so an intermediate pair can
   * be rejected with a 422 even when the pair the user actually chose is legal.
   * `shared_thread` + `high` is the only forbidden pair, so leading with the
   * command that moves away from it keeps every intermediate state legal:
   *   - to shared_thread: personalization first, so the pattern never lands on
   *     shared_thread while a stored `high` is still in place;
   *   - away from shared_thread: pattern first, so personalization never lands
   *     on `high` while a stored `shared_thread` is still in place.
   * Both commands stay in the same single batch — only their order changes.
   */
  return pattern === 'shared_thread'
    ? [setPersonalization, setPattern]
    : [setPattern, setPersonalization];
}

export interface ContextSelectionInput {
  locator: Record<string, unknown>;
  contextClass: OutreachV3ContextClass;
  scope: OutreachV3ContextScope;
}

export function acceptContextCommand(
  selections: ContextSelectionInput[],
): OutreachV3Command {
  if (selections.length === 0) throw new Error('Choose at least one context source.');
  return command('ACCEPT_CONTEXT_REFS', { selections });
}

export function excludeContextCommand(
  refs: Array<{
    contextKey: string;
    reason?:
      | 'user_excluded'
      | 'out_of_scope'
      | 'stale'
      | 'conflicting'
      | 'sensitive'
      | 'not_relevant'
      | 'superseded';
  }>,
): OutreachV3Command {
  if (refs.length === 0) throw new Error('Choose at least one context source to exclude.');
  return command('EXCLUDE_CONTEXT_REFS', {
    refs: refs.map((ref) => ({
      contextKey: required(ref.contextKey, 'Context key'),
      reason: ref.reason ?? 'user_excluded',
    })),
  });
}

export function strategyCommands(input: {
  campaignAngle: string;
  tone: string;
  length: OutreachV3Length;
  customInstruction?: string;
}): OutreachV3Command[] {
  const campaignAngle = required(input.campaignAngle, 'Campaign angle');
  const tone = required(input.tone, 'Tone');
  if (input.length === 'undecided') throw new Error('Choose a campaign length.');
  const customInstruction =
    input.length === 'custom'
      ? required(input.customInstruction ?? '', 'Custom length instruction')
      : null;
  return [
    command('SET_CAMPAIGN_ANGLE', { value: campaignAngle }),
    command('SET_TONE', { value: tone }),
    command('SET_LENGTH', {
      value: input.length,
      customInstruction,
    }),
  ];
}

export interface StyleSampleDraft {
  label: string;
  subject: string;
  body: string;
}

/**
 * Add one or more example emails.
 *
 * `sampleKey` is deliberately NOT sent: the server derives it from the content
 * and its command schema rejects a caller-supplied key outright, which is what
 * makes removal-by-key and dedupe trustworthy. Adding the same example twice is
 * a server-side no-change rather than an error, so the UI does not have to
 * pre-check for duplicates.
 */
export function addStyleSamplesCommand(drafts: StyleSampleDraft[]): OutreachV3Command {
  const samples = drafts.map((draft) => ({
    label: nullable(draft.label),
    subject: nullable(draft.subject),
    body: required(draft.body, 'Example email body'),
  }));
  if (samples.length === 0) throw new Error('Add at least one example email.');
  return command('ADD_STYLE_SAMPLES', { samples });
}

export function removeStyleSamplesCommand(sampleKeys: string[]): OutreachV3Command {
  const keys = sampleKeys.map((key) => required(key, 'Example key'));
  if (keys.length === 0) throw new Error('Choose at least one example email to remove.');
  return command('REMOVE_STYLE_SAMPLES', { sampleKeys: keys });
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}