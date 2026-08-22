import { randomUUID } from 'node:crypto';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  hashOutreachTemplateSpecV1,
  templateSpecFromCampaign,
} from './outreach-template.contract.js';
import { compileOutreachTemplateBatch } from './outreach-template.compiler.js';

describe('Outreach V3 governed templates', () => {
  it('projects only reusable strategy and voice from a live campaign', () => {
    const campaign = createBlankCampaignSpecV1();
    campaign.goal.goal = 'Secure a technical briefing';
    campaign.goal.topic = 'Autonomy';
    campaign.goal.ask = { mode: 'explicit', text: 'Meet next month' };
    campaign.sponsor = {
      kind: 'client',
      label: null,
      clientRefs: [{ clientId: randomUUID() }],
    };
    campaign.targeting.criteria = {
      notes: 'Relevant oversight staff',
      governmentLevels: ['federal'],
      chambers: [],
      committees: ['Armed Services'],
      agencies: [],
      states: [],
      relationshipPreference: 'any',
      includeStaff: true,
      includePrincipals: false,
    };
    campaign.targeting.selectedTargetRefs = [{
      targetKey: 'directory:person:secret',
      source: 'directory',
      sourceId: randomUUID(),
      targetType: 'person',
      name: 'Do not copy',
      title: null,
      organization: null,
      email: 'private@example.com',
      metadata: {},
    }] as typeof campaign.targeting.selectedTargetRefs;
    campaign.context.requiredPolicyRefs = [{
      contextKey: 'document:secret',
      source: 'document',
      sourceId: randomUUID(),
      contextClass: 'required_policy',
      label: 'Do not copy evidence',
      excerpt: null,
      scope: { kind: 'firm' },
      metadata: {},
    }] as typeof campaign.context.requiredPolicyRefs;

    const template = templateSpecFromCampaign(campaign);

    expect(template.goal.topic).toBe('Autonomy');
    expect(template.sponsor).toEqual({ kind: 'client', label: null });
    expect(template.targeting.criteria?.committees).toEqual(['Armed Services']);
    expect(template).not.toHaveProperty('context');
    expect(template.targeting).not.toHaveProperty('selectedTargetRefs');
    expect(JSON.stringify(template)).not.toContain('private@example.com');
    expect(JSON.stringify(template)).not.toContain('document:secret');
    expect(JSON.stringify(template)).not.toContain(campaign.sponsor.clientRefs[0]?.clientId);
  });

  it('compiles through canonical commands without target, context, draft or send authority', () => {
    const campaign = createBlankCampaignSpecV1();
    campaign.goal.goal = 'Request a briefing';
    campaign.goal.ask = { mode: 'explicit', text: 'Meet with the team' };
    campaign.sponsor = { kind: 'firm', label: null, clientRefs: [] };
    campaign.delivery.pattern = 'personalized_separate';
    campaign.delivery.personalization = 'high';
    campaign.strategy.tone = 'Direct';
    campaign.strategy.length = 'short';
    const batch = compileOutreachTemplateBatch({
      batchId: randomUUID(),
      expectedStateVersion: 1,
      spec: templateSpecFromCampaign(campaign),
      clientId: null,
    });
    const types = batch.commands.map((command) => command.type);

    expect(types).toContain('SET_GOAL');
    expect(types).toContain('SET_ASK');
    expect(types).toContain('SET_DELIVERY_PATTERN');
    expect(types).toContain('SET_TONE');
    for (const forbidden of [
      'ADD_TARGET_REFS',
      'ACCEPT_CONTEXT_REFS',
      'SET_SENDER_REF',
      'SET_ATTACHMENT_REFS',
      'REQUEST_SAMPLE_GENERATION',
      'REQUEST_FULL_GENERATION',
      'REQUEST_SEND_REVIEW',
    ]) {
      expect(types).not.toContain(forbidden);
    }
    expect(batch.commands.length).toBeLessThanOrEqual(20);
  });

  it('requires an explicit current client when a reusable sponsor mode is client', () => {
    const campaign = createBlankCampaignSpecV1();
    campaign.sponsor = {
      kind: 'client',
      label: null,
      clientRefs: [{ clientId: randomUUID() }],
    };
    const spec = templateSpecFromCampaign(campaign);
    expect(() =>
      compileOutreachTemplateBatch({
        batchId: randomUUID(),
        expectedStateVersion: 1,
        spec,
        clientId: null,
      }),
    ).toThrow(OutreachCommandError);
  });

  it('content-addresses the exact reusable version', () => {
    const spec = templateSpecFromCampaign(createBlankCampaignSpecV1());
    expect(hashOutreachTemplateSpecV1(spec)).toBe(hashOutreachTemplateSpecV1(spec));
    const changed = { ...spec, strategy: { ...spec.strategy, tone: 'Warm' } };
    expect(hashOutreachTemplateSpecV1(changed)).not.toBe(hashOutreachTemplateSpecV1(spec));
  });
});
