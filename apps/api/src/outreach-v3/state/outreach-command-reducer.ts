import {
  OUTREACH_COMMAND_PAYLOAD_SCHEMAS,
  isFutureOutreachCommand,
  type ParsedOutreachCommandEnvelope,
} from './outreach-command.contract.js';
import { OutreachCommandError } from './outreach-command-errors.js';
import {
  hashCampaignSpecV1,
  parseCampaignSpecV1,
  type OutreachCampaignSpecV1,
} from './outreach-campaign-spec.v1.js';
import {
  normalizeResolvedTargetRefsV1,
  targetKeyForLocator,
  type OutreachResolvedTargetRefV1,
} from '../../capabilities/targets/outreach-target.contract.js';
import {
  contextKeyForSelection,
  normalizeExcludedContextRefsV1,
  normalizeResolvedContextRefsV1,
  type OutreachResolvedContextRefV1,
} from '../../capabilities/context/outreach-context.contract.js';

export interface AuthorizedOutreachCommand extends ParsedOutreachCommandEnvelope {
  /** Populated by the persistence/authorization layer for RESTORE_STATE_VERSION. */
  restoreSpec?: OutreachCampaignSpecV1;
  /** Populated only after every ADD_TARGET_REFS locator is reauthorized. */
  resolvedTargetRefs?: OutreachResolvedTargetRefV1[];
  /** Populated only after every ACCEPT_CONTEXT_REFS selection is reauthorized. */
  resolvedContextRefs?: OutreachResolvedContextRefV1[];
}

export interface OutreachCommandReduction {
  nextSpec: OutreachCampaignSpecV1;
  changed: boolean;
  normalizedCommand: ParsedOutreachCommandEnvelope;
}

function withValidatedSpec(
  current: OutreachCampaignSpecV1,
  mutate: (draft: OutreachCampaignSpecV1) => OutreachCampaignSpecV1,
  command: ParsedOutreachCommandEnvelope,
): OutreachCommandReduction {
  let nextSpec: OutreachCampaignSpecV1;
  try {
    nextSpec = parseCampaignSpecV1(mutate(current));
  } catch {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_INVALID',
      'The command would create an invalid campaign state.',
      422,
    );
  }
  return {
    nextSpec,
    changed: hashCampaignSpecV1(nextSpec) !== hashCampaignSpecV1(current),
    normalizedCommand: command,
  };
}

function assertDeliveryCompatibility(
  pattern: OutreachCampaignSpecV1['delivery']['pattern'],
  personalization: OutreachCampaignSpecV1['delivery']['personalization'],
): void {
  if (pattern === 'shared_thread' && personalization === 'high') {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_BLOCKED',
      'High per-recipient personalization is incompatible with a shared thread.',
      422,
    );
  }
}

function authorizedTargetRefs(
  command: AuthorizedOutreachCommand,
  expectedKeys: readonly string[],
): OutreachResolvedTargetRefV1[] {
  const resolved = normalizeResolvedTargetRefsV1(command.resolvedTargetRefs ?? []);
  const resolvedKeys = resolved.map((target) => target.targetKey);
  if (
    resolvedKeys.length !== expectedKeys.length ||
    resolvedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new OutreachCommandError(
      'OUTREACH_REFERENCE_UNAUTHORIZED',
      'The target references were not resolved in the authorized scope.',
      403,
    );
  }
  return resolved;
}

function authorizedContextRefs(
  command: AuthorizedOutreachCommand,
  expectedKeys: readonly string[],
): OutreachResolvedContextRefV1[] {
  const resolved = normalizeResolvedContextRefsV1(command.resolvedContextRefs ?? []);
  const resolvedKeys = resolved.map((entry) => entry.contextKey);
  if (
    resolvedKeys.length !== expectedKeys.length ||
    resolvedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new OutreachCommandError(
      'OUTREACH_REFERENCE_UNAUTHORIZED',
      'The context references were not resolved in the authorized scope.',
      403,
    );
  }
  return resolved;
}

/**
 * Pure Campaign Spec transition. It remains free of Prisma, capabilities,
 * clocks, random IDs, logging, network providers and side effects. Target and
 * context snapshots are supplied only after the command engine reauthorizes them.
 */
export function reduceOutreachCommand(
  currentInput: OutreachCampaignSpecV1,
  command: AuthorizedOutreachCommand,
): OutreachCommandReduction {
  const current = parseCampaignSpecV1(currentInput);

  if (isFutureOutreachCommand(command.type)) {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_FUTURE_PHASE',
      'This command belongs to a later Outreach phase.',
      422,
      { commandType: command.type, futureOwner: 'generation_send' },
    );
  }

  switch (command.type) {
    case 'SET_GOAL': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_GOAL.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, goal: { ...spec.goal, goal: payload.value } }),
        command,
      );
    }
    case 'SET_OBJECTIVE': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_OBJECTIVE.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, goal: { ...spec.goal, objective: payload.value } }),
        command,
      );
    }
    case 'SET_TOPIC': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_TOPIC.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, goal: { ...spec.goal, topic: payload.value } }),
        command,
      );
    }
    case 'SET_DESIRED_OUTCOME': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_DESIRED_OUTCOME.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, goal: { ...spec.goal, desiredOutcome: payload.value } }),
        command,
      );
    }
    case 'SET_ASK': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_ASK.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({
          ...spec,
          goal: {
            ...spec.goal,
            ask: { mode: payload.mode, text: payload.mode === 'none' ? null : payload.text },
          },
        }),
        command,
      );
    }
    case 'CLEAR_ASK': {
      OUTREACH_COMMAND_PAYLOAD_SCHEMAS.CLEAR_ASK.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, goal: { ...spec.goal, ask: { mode: 'undecided', text: null } } }),
        command,
      );
    }
    case 'SET_WHY_NOW': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_WHY_NOW.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, goal: { ...spec.goal, whyNow: payload.value } }),
        command,
      );
    }
    case 'SET_SPONSOR_SCOPE': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_SPONSOR_SCOPE.parse(command.payload);
      return withValidatedSpec(current, (spec) => ({ ...spec, sponsor: payload }), command);
    }
    case 'SET_TARGET_CRITERIA': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_TARGET_CRITERIA.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, targeting: { ...spec.targeting, criteria: payload.value } }),
        command,
      );
    }
    case 'ADD_TARGET_REFS': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.ADD_TARGET_REFS.parse(command.payload);
      const expectedKeys = payload.refs
        .map((locator) => targetKeyForLocator(locator))
        .sort(compare);
      const resolved = authorizedTargetRefs(command, expectedKeys);
      return withValidatedSpec(
        current,
        (spec) => ({
          ...spec,
          targeting: {
            ...spec.targeting,
            selectedTargetRefs: normalizeResolvedTargetRefsV1([
              ...spec.targeting.selectedTargetRefs,
              ...resolved,
            ]),
            rejectedRecommendationRefs: spec.targeting.rejectedRecommendationRefs.filter(
              (rejection) => !expectedKeys.includes(rejection.targetKey),
            ),
          },
        }),
        command,
      );
    }
    case 'REMOVE_TARGET_REFS': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.REMOVE_TARGET_REFS.parse(command.payload);
      const removed = new Set(payload.targetKeys);
      return withValidatedSpec(
        current,
        (spec) => ({
          ...spec,
          targeting: {
            ...spec.targeting,
            selectedTargetRefs: spec.targeting.selectedTargetRefs.filter(
              (target) => !removed.has(target.targetKey),
            ),
          },
          context: {
            ...spec.context,
            targetSpecificRefs: spec.context.targetSpecificRefs.filter(
              (entry) => entry.scope.kind !== 'target' || !removed.has(entry.scope.targetKey),
            ),
          },
        }),
        command,
      );
    }
    case 'REJECT_TARGET_RECOMMENDATION': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.REJECT_TARGET_RECOMMENDATION.parse(
        command.payload,
      );
      return withValidatedSpec(
        current,
        (spec) => ({
          ...spec,
          targeting: {
            ...spec.targeting,
            rejectedRecommendationRefs: [
              ...spec.targeting.rejectedRecommendationRefs.filter(
                (entry) => entry.recommendationRef !== payload.recommendationRef,
              ),
              payload,
            ],
          },
        }),
        command,
      );
    }
    case 'ACCEPT_CONTEXT_REFS': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.ACCEPT_CONTEXT_REFS.parse(command.payload);
      const expectedKeys = payload.selections.map(contextKeyForSelection).sort(compare);
      const resolved = authorizedContextRefs(command, expectedKeys);
      return withValidatedSpec(
        current,
        (spec) => {
          const accepted = {
            requiredPolicyRefs: [...spec.context.requiredPolicyRefs],
            writingGuidanceRefs: [...spec.context.writingGuidanceRefs],
            campaignFactRefs: [...spec.context.campaignFactRefs],
            targetSpecificRefs: [...spec.context.targetSpecificRefs],
            groupSafeRefs: [...spec.context.groupSafeRefs],
          };
          for (const entry of resolved) {
            contextBucket(accepted, entry.contextClass).push(entry);
          }
          return {
            ...spec,
            context: {
              requiredPolicyRefs: normalizeResolvedContextRefsV1(accepted.requiredPolicyRefs),
              writingGuidanceRefs: normalizeResolvedContextRefsV1(accepted.writingGuidanceRefs),
              campaignFactRefs: normalizeResolvedContextRefsV1(accepted.campaignFactRefs),
              targetSpecificRefs: normalizeResolvedContextRefsV1(accepted.targetSpecificRefs),
              groupSafeRefs: normalizeResolvedContextRefsV1(accepted.groupSafeRefs),
              excludedRefs: spec.context.excludedRefs.filter(
                (excluded) => !expectedKeys.includes(excluded.contextKey),
              ),
            },
          };
        },
        command,
      );
    }
    case 'EXCLUDE_CONTEXT_REFS': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.EXCLUDE_CONTEXT_REFS.parse(command.payload);
      const excludedKeys = new Set(payload.refs.map((entry) => entry.contextKey));
      return withValidatedSpec(
        current,
        (spec) => ({
          ...spec,
          context: {
            requiredPolicyRefs: spec.context.requiredPolicyRefs.filter(
              (entry) => !excludedKeys.has(entry.contextKey),
            ),
            writingGuidanceRefs: spec.context.writingGuidanceRefs.filter(
              (entry) => !excludedKeys.has(entry.contextKey),
            ),
            campaignFactRefs: spec.context.campaignFactRefs.filter(
              (entry) => !excludedKeys.has(entry.contextKey),
            ),
            targetSpecificRefs: spec.context.targetSpecificRefs.filter(
              (entry) => !excludedKeys.has(entry.contextKey),
            ),
            groupSafeRefs: spec.context.groupSafeRefs.filter(
              (entry) => !excludedKeys.has(entry.contextKey),
            ),
            excludedRefs: normalizeExcludedContextRefsV1([
              ...spec.context.excludedRefs,
              ...payload.refs,
            ]),
          },
        }),
        command,
      );
    }
    case 'SET_DELIVERY_PATTERN': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_DELIVERY_PATTERN.parse(command.payload);
      assertDeliveryCompatibility(payload.value, current.delivery.personalization);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, delivery: { ...spec.delivery, pattern: payload.value } }),
        command,
      );
    }
    case 'SET_PERSONALIZATION': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_PERSONALIZATION.parse(command.payload);
      assertDeliveryCompatibility(current.delivery.pattern, payload.value);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, delivery: { ...spec.delivery, personalization: payload.value } }),
        command,
      );
    }
    case 'SET_CAMPAIGN_ANGLE': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_CAMPAIGN_ANGLE.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, strategy: { ...spec.strategy, campaignAngle: payload.value } }),
        command,
      );
    }
    case 'SET_TONE': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_TONE.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, strategy: { ...spec.strategy, tone: payload.value } }),
        command,
      );
    }
    case 'SET_LENGTH': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_LENGTH.parse(command.payload);
      return withValidatedSpec(
        current,
        (spec) => ({
          ...spec,
          strategy: {
            ...spec.strategy,
            length: payload.value,
            customLengthInstruction:
              payload.value === 'custom' ? payload.customInstruction : null,
          },
        }),
        command,
      );
    }
    case 'RESTORE_STATE_VERSION': {
      OUTREACH_COMMAND_PAYLOAD_SCHEMAS.RESTORE_STATE_VERSION.parse(command.payload);
      if (!command.restoreSpec) {
        throw new OutreachCommandError(
          'OUTREACH_COMMAND_BLOCKED',
          'Restore requires an authorized state-version snapshot.',
          422,
        );
      }
      const restored = parseCampaignSpecV1(command.restoreSpec);
      return {
        nextSpec: restored,
        changed: hashCampaignSpecV1(restored) !== hashCampaignSpecV1(current),
        normalizedCommand: command,
      };
    }
  }
}

function contextBucket(
  buckets: {
    requiredPolicyRefs: OutreachResolvedContextRefV1[];
    writingGuidanceRefs: OutreachResolvedContextRefV1[];
    campaignFactRefs: OutreachResolvedContextRefV1[];
    targetSpecificRefs: OutreachResolvedContextRefV1[];
    groupSafeRefs: OutreachResolvedContextRefV1[];
  },
  contextClass: OutreachResolvedContextRefV1['contextClass'],
): OutreachResolvedContextRefV1[] {
  switch (contextClass) {
    case 'required_policy':
      return buckets.requiredPolicyRefs;
    case 'writing_guidance':
      return buckets.writingGuidanceRefs;
    case 'campaign_fact':
      return buckets.campaignFactRefs;
    case 'target_specific':
      return buckets.targetSpecificRefs;
    case 'group_safe':
      return buckets.groupSafeRefs;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
