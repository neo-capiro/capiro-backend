import { describe, expect, it } from 'vitest';
import {
  OUTREACH_BUILDER_STEP_ICONS,
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  OUTREACH_CAMPAIGN_TYPES,
  OUTREACH_EMAIL_FORMATS,
  outreachBuilderNextStep,
  outreachBuilderPrimaryLabel,
  outreachBuilderSetupCount,
  outreachBuilderStepIndex,
  outreachBuilderSteps,
  outreachEmailFormatById,
  outreachReadyRecipientCount,
  outreachSendGate,
  outreachSkipsFormatStep,
  outreachTemplateStepLabel,
  type OutreachBuilderStep,
  type OutreachCampaignType,
} from './outreach-campaign-flow.js';

const ALL_STEPS: OutreachBuilderStep[] = [
  'workflow',
  'name',
  'update',
  'format',
  'targets',
  'context',
  'review',
  'drafts',
  'send',
];

describe('outreach builder step machine', () => {
  it('orders the nine steps exactly as the prototype does', () => {
    expect(outreachBuilderSteps('send_update').map((step) => step.key)).toEqual([
      'workflow',
      'name',
      'update',
      'format',
      'targets',
      'context',
      'review',
      'drafts',
      'send',
    ]);
  });

  it('drops Format for a meeting request and keeps it for custom', () => {
    expect(outreachSkipsFormatStep('request_meeting')).toBe(true);
    expect(outreachSkipsFormatStep('custom')).toBe(false);
    expect(outreachSkipsFormatStep('send_update')).toBe(false);

    expect(outreachBuilderSteps('request_meeting').map((step) => step.key)).not.toContain('format');
    expect(outreachBuilderSteps('custom').map((step) => step.key)).toContain('format');
  });

  it('labels the template step per campaign type', () => {
    expect(outreachTemplateStepLabel('request_meeting')).toBe('Request template');
    expect(outreachTemplateStepLabel('send_update')).toBe('Update template');
    expect(outreachTemplateStepLabel('custom')).toBe('Template');

    expect(outreachBuilderSteps('request_meeting').at(2)?.label).toBe('Request template');
    expect(outreachBuilderSteps('custom').at(2)?.label).toBe('Template');
  });

  it('always leaves exactly Review, Drafts and Send after the setup divider', () => {
    for (const type of ['request_meeting', 'send_update', 'custom'] as OutreachCampaignType[]) {
      const steps = outreachBuilderSteps(type);
      const after = steps.slice(outreachBuilderSetupCount(type));
      expect(after.map((step) => step.key)).toEqual(['review', 'drafts', 'send']);
    }
    expect(outreachBuilderSetupCount('send_update')).toBe(6);
    expect(outreachBuilderSetupCount('request_meeting')).toBe(5);
  });

  it('advances through every step and stops at send', () => {
    let step: OutreachBuilderStep | null = 'workflow';
    const walked: OutreachBuilderStep[] = [];
    while (step) {
      walked.push(step);
      step = outreachBuilderNextStep('send_update', step);
    }
    expect(walked).toEqual(ALL_STEPS);
    expect(outreachBuilderNextStep('send_update', 'send')).toBeNull();
  });

  it('skips straight from the template step to targets when Format is dropped', () => {
    expect(outreachBuilderNextStep('request_meeting', 'update')).toBe('targets');
    expect(outreachBuilderNextStep('send_update', 'update')).toBe('format');
  });

  it('resolves an index for a step the type does not have instead of returning -1', () => {
    expect(outreachBuilderStepIndex('request_meeting', 'format')).toBe(0);
    expect(outreachBuilderStepIndex('send_update', 'format')).toBe(3);
  });

  it('uses the prototype primary-button labels', () => {
    expect(outreachBuilderPrimaryLabel('workflow', 'send_update')).toBe('Continue with Send update');
    expect(outreachBuilderPrimaryLabel('workflow', 'request_meeting')).toBe(
      'Continue with Request a meeting',
    );
    expect(outreachBuilderPrimaryLabel('name', 'send_update')).toBe('Continue to update template');
    expect(outreachBuilderPrimaryLabel('name', 'request_meeting')).toBe(
      'Continue to request template',
    );
    expect(outreachBuilderPrimaryLabel('update', 'request_meeting')).toBe('Continue to targets');
    expect(outreachBuilderPrimaryLabel('update', 'send_update')).toBe('Continue to format');
    expect(outreachBuilderPrimaryLabel('format', 'send_update')).toBe('Continue to targets');
    expect(outreachBuilderPrimaryLabel('targets', 'send_update')).toBe('Continue to context');
    expect(outreachBuilderPrimaryLabel('context', 'send_update')).toBe('Continue to review packet');
    expect(outreachBuilderPrimaryLabel('review', 'send_update')).toBe(
      'Accept packet and generate drafts',
    );
    expect(outreachBuilderPrimaryLabel('drafts', 'send_update')).toBe('Continue to send');
    expect(outreachBuilderPrimaryLabel('send', 'send_update', 1)).toBe('Send 1 email');
    expect(outreachBuilderPrimaryLabel('send', 'send_update', 4)).toBe('Send 4 emails');
    expect(outreachBuilderPrimaryLabel('send', 'send_update', 0)).toBe('Send 0 emails');
  });

  it('gives every step a title, a subline and an icon', () => {
    for (const step of ALL_STEPS) {
      expect(OUTREACH_BUILDER_STEP_TITLES[step]).toBeTruthy();
      expect(OUTREACH_BUILDER_STEP_SUBLINES[step]).toBeTruthy();
      expect(OUTREACH_BUILDER_STEP_ICONS[step]).toBeTruthy();
    }
  });

  it('keeps the three campaign types in the prototype order', () => {
    expect(OUTREACH_CAMPAIGN_TYPES.map((type) => type.id)).toEqual([
      'request_meeting',
      'send_update',
      'custom',
    ]);
    for (const type of OUTREACH_CAMPAIGN_TYPES) {
      expect(type.description.length).toBeGreaterThan(40);
    }
  });
});

describe('outreach email formats', () => {
  it('keeps the four prototype layouts and marks plain text as the safe one', () => {
    expect(OUTREACH_EMAIL_FORMATS.map((format) => format.id)).toEqual([
      'standard',
      'briefing_card',
      'status_table',
      'timeline',
    ]);
    expect(OUTREACH_EMAIL_FORMATS.at(0)?.suitsAll).toBe(true);
    expect(OUTREACH_EMAIL_FORMATS.at(0)?.bands).toBeNull();
    for (const format of OUTREACH_EMAIL_FORMATS.slice(1)) {
      expect(format.suitsAll).toBe(false);
      expect(format.bands).toHaveLength(3);
    }
  });

  it('falls back to standard email for an unknown or missing id', () => {
    expect(outreachEmailFormatById(null).id).toBe('standard');
    expect(outreachEmailFormatById('nope').id).toBe('standard');
    expect(outreachEmailFormatById('timeline').id).toBe('timeline');
  });
});

describe('outreach send gate', () => {
  it('blocks until preflight has run', () => {
    const gate = outreachSendGate({
      preflightRan: false,
      blockedCount: 0,
      partialChoice: 'ready',
    });
    expect(gate.canSend).toBe(false);
    expect(gate.reason).toBe('Run preflight first.');
  });

  it('allows a clean send once preflight has run', () => {
    const gate = outreachSendGate({
      preflightRan: true,
      blockedCount: 0,
      partialChoice: 'ready',
    });
    expect(gate.canSend).toBe(true);
    expect(gate.reason).toBe('The confirmation dialog is the only real-send trigger.');
  });

  /**
   * The held-out acknowledgement gate was removed deliberately. It asked the
   * user to tick a box confirming they knew some recipients were excluded, but
   * those recipients are dropped from the envelope server-side either way, so
   * the box could never change who received mail. This pins the de-gated
   * behaviour so it is not reintroduced by accident.
   */
  it('allows a partial send with held-out recipients and no acknowledgment', () => {
    const gate = outreachSendGate({
      preflightRan: true,
      blockedCount: 1,
      partialChoice: 'ready',
    });
    expect(gate.canSend).toBe(true);
    expect(gate.holdsAll).toBe(false);
    expect(gate.reason).toBe('The confirmation dialog is the only real-send trigger.');
  });

  it('blocks the whole campaign when the user chooses to wait for everyone', () => {
    const gate = outreachSendGate({
      preflightRan: true,
      blockedCount: 1,
      partialChoice: 'all',
    });
    expect(gate.holdsAll).toBe(true);
    expect(gate.canSend).toBe(false);
    expect(gate.reason).toBe(
      'With this choice one blocked recipient keeps the whole campaign from sending.',
    );
  });

  it('counts ready recipients per partial choice', () => {
    expect(outreachReadyRecipientCount(4, 0, 'ready')).toBe(4);
    expect(outreachReadyRecipientCount(4, 1, 'ready')).toBe(3);
    // Waiting for everyone means the button still names the whole campaign; the
    // gate — not the count — is what stops the send.
    expect(outreachReadyRecipientCount(4, 1, 'all')).toBe(4);
    expect(outreachReadyRecipientCount(4, 0, 'all')).toBe(4);
  });
});
