import { randomUUID } from 'node:crypto';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { OutreachSponsorScopeV1 } from '../state/outreach-campaign-spec.v1.js';
import {
  BLANK_TEMPLATE_GUIDANCE,
  DEFAULT_TEMPLATE_DEFAULTS_POLICY,
  DEFAULT_TEMPLATE_GUARDRAILS,
  type OutreachTemplateSpecV1,
} from './outreach-template.contract.js';
import {
  assertDestinationScopeAllowed,
  assertSharedPublicationAuthority,
  assertVersionSourceMatchesTemplateScope,
  classifySourceScope,
  computeTemplateApplicationFingerprint,
  computeTemplateCapabilities,
  toTemplateCardSummary,
} from './outreach-template-authorization.js';

function sponsor(overrides: Partial<OutreachSponsorScopeV1>): OutreachSponsorScopeV1 {
  return { kind: 'undecided', label: null, clientRefs: [], ...overrides } as OutreachSponsorScopeV1;
}

function ctx(role: 'standard_user' | 'user_admin' | 'capiro_admin', userId = randomUUID()) {
  return {
    tenantId: randomUUID(),
    tenantSlug: 'acme',
    userId,
    clerkUserId: randomUUID(),
    role,
  };
}

describe('classifySourceScope', () => {
  it('classifies a single-client sponsor as client-scoped', () => {
    const clientId = randomUUID();
    expect(classifySourceScope(sponsor({ kind: 'client', clientRefs: [{ clientId }] }))).toEqual({
      kind: 'client',
      clientId,
    });
  });

  it('blocks multi-client sources instead of silently downgrading them', () => {
    expect(
      classifySourceScope(
        sponsor({ kind: 'multi_client', clientRefs: [{ clientId: randomUUID() }, { clientId: randomUUID() }] }),
      ),
    ).toEqual({ kind: 'unsupported', reason: 'multi_client' });
  });

  it('blocks coalition sources (no coalition membership model exists yet)', () => {
    expect(classifySourceScope(sponsor({ kind: 'coalition', label: 'Allied Group' }))).toEqual({
      kind: 'unsupported',
      reason: 'coalition',
    });
  });

  for (const kind of ['firm', 'internal_team', 'undecided', 'none'] as const) {
    it(`classifies ${kind} sponsor as unscoped`, () => {
      expect(classifySourceScope(sponsor({ kind }))).toEqual({ kind: 'unscoped' });
    });
  }
});

describe('assertDestinationScopeAllowed', () => {
  it('allows a client-sourced campaign to become a same-client template only', () => {
    const clientId = randomUUID();
    const result = assertDestinationScopeAllowed({ kind: 'client', clientId }, 'client', clientId);
    expect(result).toEqual({ clientId });
  });

  it('blocks a client-sourced campaign from becoming firm-scoped', () => {
    const clientId = randomUUID();
    expect(() => assertDestinationScopeAllowed({ kind: 'client', clientId }, 'firm', null)).toThrow(
      OutreachCommandError,
    );
  });

  it('blocks a client-sourced campaign from becoming a DIFFERENT client template', () => {
    const clientId = randomUUID();
    expect(() =>
      assertDestinationScopeAllowed({ kind: 'client', clientId }, 'client', randomUUID()),
    ).toThrow(OutreachCommandError);
  });

  it('blocks a client-sourced campaign from becoming private (evading client governance)', () => {
    const clientId = randomUUID();
    expect(() => assertDestinationScopeAllowed({ kind: 'client', clientId }, 'private', null)).toThrow(
      OutreachCommandError,
    );
  });

  it('allows an unscoped (firm/internal) campaign to become private or firm', () => {
    expect(assertDestinationScopeAllowed({ kind: 'unscoped' }, 'private', null)).toEqual({ clientId: null });
    expect(assertDestinationScopeAllowed({ kind: 'unscoped' }, 'firm', null)).toEqual({ clientId: null });
  });

  it('blocks an unscoped campaign from becoming client-scoped', () => {
    expect(() => assertDestinationScopeAllowed({ kind: 'unscoped' }, 'client', randomUUID())).toThrow(
      OutreachCommandError,
    );
  });

  it('blocks multi-client/coalition sources with a distinct unsupported error', () => {
    expect(() =>
      assertDestinationScopeAllowed({ kind: 'unsupported', reason: 'multi_client' }, 'private', null),
    ).toThrow(expect.objectContaining({ code: 'OUTREACH_TEMPLATE_SCOPE_UNSUPPORTED' }));
  });
});

describe('assertVersionSourceMatchesTemplateScope', () => {
  it('allows a same-client new version', () => {
    const clientId = randomUUID();
    expect(() =>
      assertVersionSourceMatchesTemplateScope(
        { kind: 'client', clientId },
        { scope: 'client', clientId },
      ),
    ).not.toThrow();
  });

  it('blocks laundering a different client campaign into an existing client template', () => {
    const clientId = randomUUID();
    expect(() =>
      assertVersionSourceMatchesTemplateScope(
        { kind: 'client', clientId: randomUUID() },
        { scope: 'client', clientId },
      ),
    ).toThrow(expect.objectContaining({ code: 'OUTREACH_TEMPLATE_SCOPE_MISMATCH' }));
  });

  it('blocks laundering a client campaign into a firm template', () => {
    expect(() =>
      assertVersionSourceMatchesTemplateScope(
        { kind: 'client', clientId: randomUUID() },
        { scope: 'firm', clientId: null },
      ),
    ).toThrow(expect.objectContaining({ code: 'OUTREACH_TEMPLATE_SCOPE_MISMATCH' }));
  });
});

describe('assertSharedPublicationAuthority', () => {
  it('allows anyone to publish their own private template', () => {
    expect(() => assertSharedPublicationAuthority(ctx('standard_user'), 'private')).not.toThrow();
  });

  it('blocks a standard user from publishing a firm template', () => {
    expect(() => assertSharedPublicationAuthority(ctx('standard_user'), 'firm')).toThrow(
      expect.objectContaining({ code: 'OUTREACH_TEMPLATE_PUBLISH_UNAUTHORIZED' }),
    );
  });

  it('blocks a standard user from publishing a client template', () => {
    expect(() => assertSharedPublicationAuthority(ctx('standard_user'), 'client')).toThrow(
      OutreachCommandError,
    );
  });

  it('allows a tenant admin to publish a firm or client template', () => {
    expect(() => assertSharedPublicationAuthority(ctx('user_admin'), 'firm')).not.toThrow();
    expect(() => assertSharedPublicationAuthority(ctx('capiro_admin'), 'client')).not.toThrow();
  });
});

describe('computeTemplateCapabilities', () => {
  const publishedActive = { scope: 'firm' as const, ownerUserId: '', status: 'active' as const, publishedVersionId: randomUUID() };

  it('gives the owner full management capability regardless of scope', () => {
    const ownerId = randomUUID();
    const caps = computeTemplateCapabilities(ctx('standard_user', ownerId), {
      ...publishedActive,
      ownerUserId: ownerId,
    });
    expect(caps).toMatchObject({ canInspect: true, canEdit: true, canCreateVersion: true, canArchive: true });
  });

  it('lets an admin manage a firm/client template they do not own, but not publish alone without the rule change', () => {
    const caps = computeTemplateCapabilities(ctx('user_admin'), publishedActive);
    expect(caps.canInspect).toBe(true);
    expect(caps.canPublish).toBe(true);
  });

  it('never lets an admin manage another user\'s PRIVATE template', () => {
    const caps = computeTemplateCapabilities(ctx('user_admin'), {
      ...publishedActive,
      scope: 'private',
      ownerUserId: randomUUID(),
    });
    expect(caps).toMatchObject({ canInspect: false, canEdit: false, canPublish: false, canArchive: false });
  });

  it('gives an ordinary reader only canUse, never manage capabilities', () => {
    const caps = computeTemplateCapabilities(ctx('standard_user'), publishedActive);
    expect(caps).toMatchObject({
      canUse: true,
      canInspect: false,
      canEdit: false,
      canCreateVersion: false,
      canPublish: false,
      canArchive: false,
      canRestore: false,
    });
  });

  it('never allows use of an unpublished or archived template', () => {
    expect(
      computeTemplateCapabilities(ctx('standard_user'), { ...publishedActive, publishedVersionId: null }).canUse,
    ).toBe(false);
    expect(
      computeTemplateCapabilities(ctx('standard_user'), { ...publishedActive, status: 'archived' }).canUse,
    ).toBe(false);
  });
});

describe('toTemplateCardSummary', () => {
  const baseSpec: OutreachTemplateSpecV1 = {
    schemaVersion: 'outreach_v3_template_v1',
    goal: {
      goal: 'Secure a briefing',
      objective: 'Get on the record',
      topic: 'Autonomy',
      desiredOutcome: 'Meeting confirmed',
      ask: { mode: 'explicit', text: 'Meet next month' },
      whyNow: 'Markup coming up',
    },
    sponsor: { kind: 'firm', label: null },
    targeting: { criteria: null },
    delivery: { pattern: 'personalized_separate', personalization: 'high' },
    strategy: { campaignAngle: 'Program history', tone: 'Direct', length: 'short', customLengthInstruction: null },
    styleSamples: [{ label: 'Sample', subject: 'Hi', body: 'Confidential voice sample body' }],
    variables: [],
    defaultsPolicy: DEFAULT_TEMPLATE_DEFAULTS_POLICY,
    guidance: BLANK_TEMPLATE_GUIDANCE,
    guardrails: DEFAULT_TEMPLATE_GUARDRAILS,
  };

  it('never leaks style sample bodies, ask text, or long-form prose into the card summary', () => {
    const summary = toTemplateCardSummary(baseSpec);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('Confidential voice sample body');
    expect(serialized).not.toContain('Meet next month');
    expect(serialized).not.toContain('Get on the record');
    expect(serialized).not.toContain('Markup coming up');
    expect(serialized).not.toContain('Program history');
    expect(summary).toEqual({
      topic: 'Autonomy',
      sponsorKind: 'firm',
      deliveryPattern: 'personalized_separate',
      personalization: 'high',
      tone: 'Direct',
      length: 'short',
      hasExplicitAsk: true,
      styleSampleCount: 1,
      variableCount: 0,
      requiredVariableCount: 0,
    });
  });
});

describe('computeTemplateApplicationFingerprint', () => {
  const base = {
    actorUserId: randomUUID(),
    templateId: randomUUID(),
    templateVersionId: randomUUID(),
    clientId: null as string | null,
    title: 'My campaign',
  };

  it('is stable for the same logical request', () => {
    expect(computeTemplateApplicationFingerprint(base)).toBe(computeTemplateApplicationFingerprint({ ...base }));
  });

  it('changes when the template version differs', () => {
    expect(computeTemplateApplicationFingerprint(base)).not.toBe(
      computeTemplateApplicationFingerprint({ ...base, templateVersionId: randomUUID() }),
    );
  });

  it('changes when the client differs', () => {
    expect(computeTemplateApplicationFingerprint(base)).not.toBe(
      computeTemplateApplicationFingerprint({ ...base, clientId: randomUUID() }),
    );
  });

  it('treats an untrimmed/empty title the same as null', () => {
    expect(computeTemplateApplicationFingerprint({ ...base, title: '  ' })).toBe(
      computeTemplateApplicationFingerprint({ ...base, title: null }),
    );
  });
});
