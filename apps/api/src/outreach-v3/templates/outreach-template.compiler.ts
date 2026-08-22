import type { ApplyOutreachCommandBatchInput } from '../state/outreach-command.contract.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { OutreachTemplateSpecV1 } from './outreach-template.contract.js';

function command(type: ApplyOutreachCommandBatchInput['commands'][number]['type'], payload: unknown) {
  return { type, schemaVersion: 1 as const, payload };
}

/**
 * A template never mutates Campaign Spec directly. It compiles into the same
 * canonical, validated command batch used by the normal operator controls.
 * Targets and context are intentionally absent and must be refreshed live.
 */
export function compileOutreachTemplateBatch(input: {
  batchId: string;
  expectedStateVersion: number;
  spec: OutreachTemplateSpecV1;
  clientId: string | null;
}): ApplyOutreachCommandBatchInput {
  const { spec } = input;
  const commands: ApplyOutreachCommandBatchInput['commands'] = [
    command('SET_GOAL', { value: spec.goal.goal }),
    command('SET_OBJECTIVE', { value: spec.goal.objective }),
    command('SET_TOPIC', { value: spec.goal.topic }),
    command('SET_DESIRED_OUTCOME', { value: spec.goal.desiredOutcome }),
  ];

  if (spec.goal.ask.mode !== 'undecided') {
    commands.push(
      command('SET_ASK', {
        mode: spec.goal.ask.mode,
        text: spec.goal.ask.mode === 'explicit' ? spec.goal.ask.text : null,
      }),
    );
  }
  commands.push(command('SET_WHY_NOW', { value: spec.goal.whyNow }));

  if (spec.sponsor.kind === 'client' && !input.clientId) {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_INVALID',
      'This template needs a client before it can be used.',
      422,
    );
  }
  commands.push(
    command('SET_SPONSOR_SCOPE', {
      kind: spec.sponsor.kind,
      label: spec.sponsor.kind === 'coalition' ? spec.sponsor.label : null,
      clientRefs:
        spec.sponsor.kind === 'client' && input.clientId
          ? [{ clientId: input.clientId }]
          : [],
    }),
  );

  commands.push(
    command('SET_TARGET_CRITERIA', { value: spec.targeting.criteria }),
    command('SET_DELIVERY_PATTERN', { value: spec.delivery.pattern }),
    command('SET_PERSONALIZATION', { value: spec.delivery.personalization }),
    command('SET_CAMPAIGN_ANGLE', { value: spec.strategy.campaignAngle }),
    command('SET_TONE', { value: spec.strategy.tone }),
    command('SET_LENGTH', {
      value: spec.strategy.length,
      customInstruction:
        spec.strategy.length === 'custom' ? spec.strategy.customLengthInstruction : null,
    }),
  );

  if (spec.styleSamples.length) {
    commands.push(command('ADD_STYLE_SAMPLES', { samples: spec.styleSamples }));
  }

  return {
    batchId: input.batchId,
    expectedStateVersion: input.expectedStateVersion,
    commands,
  };
}
