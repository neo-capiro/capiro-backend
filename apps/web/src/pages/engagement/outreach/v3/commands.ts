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
  const ask =
    draft.askMode === 'none'
      ? command('SET_ASK', { mode: 'none', text: null })
      : command('SET_ASK', { mode: 'explicit', text: nullable(draft.askText) });
  return [
    command('SET_GOAL', { value: nullable(draft.goal) }),
    command('SET_OBJECTIVE', { value: nullable(draft.objective) }),
    command('SET_TOPIC', { value: nullable(draft.topic) }),
    command('SET_DESIRED_OUTCOME', { value: nullable(draft.desiredOutcome) }),
    ask,
    command('SET_WHY_NOW', { value: nullable(draft.whyNow) }),
  ];
}

export function sponsorCommand(input: {
  kind: OutreachV3SponsorKind;
  label?: string | null;
  clientIds?: string[];
}): OutreachV3Command {
  return command('SET_SPONSOR_SCOPE', {
    kind: input.kind,
    label: nullable(input.label ?? ''),
    clientRefs: [...new Set(input.clientIds ?? [])].map((clientId) => ({ clientId })),
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
  return command('REMOVE_TARGET_REFS', { targetKeys: [targetKey] });
}

export function rejectTargetRecommendationCommand(input: {
  recommendationRef: string;
  targetKey: string;
}): OutreachV3Command {
  return command('REJECT_TARGET_RECOMMENDATION', input);
}

export function deliveryCommands(
  pattern: OutreachV3DeliveryPattern,
  personalization: OutreachV3Personalization,
): OutreachV3Command[] {
  return [
    command('SET_DELIVERY_PATTERN', { value: pattern }),
    command('SET_PERSONALIZATION', { value: personalization }),
  ];
}

export interface ContextSelectionInput {
  locator: Record<string, unknown>;
  contextClass: OutreachV3ContextClass;
  scope: OutreachV3ContextScope;
}

export function acceptContextCommand(
  selections: ContextSelectionInput[],
): OutreachV3Command {
  return command('ACCEPT_CONTEXT_REFS', { selections });
}

export function excludeContextCommand(
  refs: Array<{ contextKey: string; reasonCode?: string | null }>,
): OutreachV3Command {
  return command('EXCLUDE_CONTEXT_REFS', { refs });
}

export function strategyCommands(input: {
  campaignAngle: string;
  tone: string;
  length: OutreachV3Length;
  customInstruction?: string;
}): OutreachV3Command[] {
  return [
    command('SET_CAMPAIGN_ANGLE', { value: nullable(input.campaignAngle) }),
    command('SET_TONE', { value: nullable(input.tone) }),
    command('SET_LENGTH', {
      value: input.length,
      customInstruction:
        input.length === 'custom' ? nullable(input.customInstruction ?? '') : null,
    }),
  ];
}

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}
