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

export interface AuthorizedOutreachCommand extends ParsedOutreachCommandEnvelope {
  /** Populated by the persistence/authorization layer for RESTORE_STATE_VERSION. */
  restoreSpec?: OutreachCampaignSpecV1;
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

/**
 * Pure Phase 2 state transition. This function must remain free of Prisma,
 * capabilities, clocks, random IDs, logging, network providers and side effects.
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
      {
        commandType: command.type,
        futureOwner: [
          'ADD_TARGET_REFS',
          'REMOVE_TARGET_REFS',
          'REJECT_TARGET_RECOMMENDATION',
          'ACCEPT_CONTEXT_REFS',
          'EXCLUDE_CONTEXT_REFS',
        ].includes(command.type)
          ? 'target_context'
          : 'generation_send',
      },
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
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_DESIRED_OUTCOME.parse(
        command.payload,
      );
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
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_SPONSOR_SCOPE.parse(
        command.payload,
      );
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, sponsor: payload }),
        command,
      );
    }
    case 'SET_TARGET_CRITERIA': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_TARGET_CRITERIA.parse(
        command.payload,
      );
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, targeting: { ...spec.targeting, criteria: payload.value } }),
        command,
      );
    }
    case 'SET_DELIVERY_PATTERN': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_DELIVERY_PATTERN.parse(
        command.payload,
      );
      assertDeliveryCompatibility(payload.value, current.delivery.personalization);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, delivery: { ...spec.delivery, pattern: payload.value } }),
        command,
      );
    }
    case 'SET_PERSONALIZATION': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_PERSONALIZATION.parse(
        command.payload,
      );
      assertDeliveryCompatibility(current.delivery.pattern, payload.value);
      return withValidatedSpec(
        current,
        (spec) => ({ ...spec, delivery: { ...spec.delivery, personalization: payload.value } }),
        command,
      );
    }
    case 'SET_CAMPAIGN_ANGLE': {
      const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_CAMPAIGN_ANGLE.parse(
        command.payload,
      );
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
