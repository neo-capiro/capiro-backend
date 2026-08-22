import { randomUUID } from 'node:crypto';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  hashOutreachTemplateSpecV1,
  OutreachTemplateVariablesMissingError,
  parseOutreachTemplateSpecV1,
  substituteOutreachTemplateVariables,
  templateSpecFromCampaign,
  type OutreachTemplateSpecV1,
  type OutreachTemplateVariable,
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
    // These fixtures only need to carry the tell-tale strings the assertions
    // below check are stripped — they intentionally use `as unknown as` rather
    // than chasing the full resolved target/context ref schema (locator,
    // snapshotHash, etc.), since templateSpecFromCampaign() never reads past
    // `targeting.criteria` / drops these arrays entirely either way.
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
    }] as unknown as typeof campaign.targeting.selectedTargetRefs;
    campaign.context.requiredPolicyRefs = [{
      contextKey: 'document:secret',
      source: 'document',
      sourceId: randomUUID(),
      contextClass: 'required_policy',
      label: 'Do not copy evidence',
      excerpt: null,
      scope: { kind: 'firm' },
      metadata: {},
    }] as unknown as typeof campaign.context.requiredPolicyRefs;

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

function variable(overrides?: Partial<OutreachTemplateVariable>): OutreachTemplateVariable {
  return {
    key: 'client',
    label: 'Client',
    question: null,
    type: 'text',
    choices: null,
    required: true,
    defaultValue: null,
    resolutionPolicy: 'user_must_confirm',
    scope: 'public',
    appliesTo: ['goal'],
    ...overrides,
  };
}

function specWithGoal(goal: string, overrides?: Partial<OutreachTemplateSpecV1>): OutreachTemplateSpecV1 {
  const base = templateSpecFromCampaign(createBlankCampaignSpecV1());
  return { ...base, ...overrides, goal: { ...base.goal, goal } };
}

describe('Outreach V3 template variables', () => {
  it('rejects a text token with no declared variable', () => {
    expect(() => parseOutreachTemplateSpecV1(specWithGoal('Hello {ghost}'))).toThrow();
  });

  it('rejects a variable used in a field not listed in its appliesTo', () => {
    const spec = specWithGoal('Hello {client}', { variables: [variable({ appliesTo: ['objective'] })] });
    expect(() => parseOutreachTemplateSpecV1(spec)).toThrow();
  });

  it('accepts a token whose variable declares that field in appliesTo', () => {
    const spec = specWithGoal('Hello {client}', { variables: [variable({ appliesTo: ['goal'] })] });
    expect(() => parseOutreachTemplateSpecV1(spec)).not.toThrow();
  });

  it('rejects two variables with the same key', () => {
    const spec = specWithGoal('Hi', { variables: [variable(), variable()] });
    expect(() => parseOutreachTemplateSpecV1(spec)).toThrow();
  });

  it('rejects a choice-type variable with no choices, and a non-choice variable that has choices', () => {
    expect(() => parseOutreachTemplateSpecV1(specWithGoal('Hi', { variables: [variable({ type: 'choice', choices: null })] }))).toThrow();
    expect(() => parseOutreachTemplateSpecV1(specWithGoal('Hi', { variables: [variable({ type: 'text', choices: ['a'] })] }))).toThrow();
  });

  it('rejects an "always_ask" variable that carries a stored default', () => {
    const spec = specWithGoal('Hi {client}', { variables: [variable({ resolutionPolicy: 'always_ask', defaultValue: 'Acme' })] });
    expect(() => parseOutreachTemplateSpecV1(spec)).toThrow();
  });

  it('rejects a control character in free text', () => {
    expect(() => parseOutreachTemplateSpecV1(specWithGoal('Hithere'))).toThrow();
  });

  it('rejects a malformed variable key (uppercase, symbols, leading digit)', () => {
    for (const key of ['Client', 'client-name', '1client', 'a'.repeat(41)]) {
      expect(() => parseOutreachTemplateSpecV1(specWithGoal('Hi', { variables: [variable({ key })] }))).toThrow();
    }
  });
});

describe('substituteOutreachTemplateVariables', () => {
  it('replaces a resolved token and leaves the stored template spec untouched', () => {
    const spec = specWithGoal('Support {program}', {
      variables: [variable({ key: 'program', label: 'Program', appliesTo: ['goal'] })],
    });
    const resolved = substituteOutreachTemplateVariables(spec, { program: 'HAC-D' });
    expect(resolved.goal.goal).toBe('Support HAC-D');
    expect(spec.goal.goal).toBe('Support {program}'); // original untouched
  });

  it('throws OutreachTemplateVariablesMissingError naming every unresolved required variable', () => {
    const spec = specWithGoal('{a} and {b}', {
      variables: [
        variable({ key: 'a', appliesTo: ['goal'] }),
        variable({ key: 'b', appliesTo: ['goal'], label: 'B' }),
      ],
    });
    try {
      substituteOutreachTemplateVariables(spec, {});
      throw new Error('expected substituteOutreachTemplateVariables to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OutreachTemplateVariablesMissingError);
      expect((error as OutreachTemplateVariablesMissingError).keys.sort()).toEqual(['a', 'b']);
    }
  });

  it('falls back to a stored default when the caller supplies nothing, for meri_can_determine/user_must_confirm', () => {
    const spec = specWithGoal('Support {program}', {
      variables: [variable({ key: 'program', appliesTo: ['goal'], required: false, resolutionPolicy: 'meri_can_determine', defaultValue: 'General fund' })],
    });
    expect(substituteOutreachTemplateVariables(spec, {}).goal.goal).toBe('Support General fund');
  });

  it('an optional unresolved variable is blanked, never left as a literal {token} a recipient could see', () => {
    const spec = specWithGoal('Support {program} today', {
      variables: [variable({ key: 'program', appliesTo: ['goal'], required: false, defaultValue: null })],
    });
    expect(substituteOutreachTemplateVariables(spec, {}).goal.goal).toBe('Support  today');
  });

  it('leaves a non-token field untouched when it has no variables applying to it', () => {
    const base = templateSpecFromCampaign(createBlankCampaignSpecV1());
    const spec = { ...base, goal: { ...base.goal, objective: 'Static objective' } };
    expect(substituteOutreachTemplateVariables(spec, {}).goal.objective).toBe('Static objective');
  });
});
