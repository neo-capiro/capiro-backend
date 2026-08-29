import { describe, expect, it } from 'vitest';
import type {
  OutreachV3ResolvedContextRef,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_EMAIL_FORMATS,
  type OutreachCampaignType,
} from './outreach-campaign-flow.js';
import {
  OUTREACH_FORMAT_MARKER,
  OUTREACH_UNWIRED_CONTROLS,
  outreachBlockedTargets,
  outreachCampaignFacts,
  outreachCampaignNameFromSpec,
  outreachCampaignTypeFromSpec,
  outreachCampaignTypeGoalPhrase,
  outreachEffectiveEmailFormat,
  outreachEmailFormatFromSpec,
  outreachEmailFormatSelection,
  outreachGoalCommandsFor,
  outreachGuidanceRefsWithMarker,
  outreachRecipientSummary,
  outreachSponsorFromSpec,
  outreachTargetIsSendable,
  outreachGenerationSpecCommands,
} from './outreach-builder-model.js';

function guidanceRef(title: string): OutreachV3ResolvedContextRef {
  return {
    contextKey: `ctx:${title}`,
    locator: { source: 'manual', id: title },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
    title,
    summary: '',
    verificationClass: 'user_supplied',
    sensitivity: 'normal',
    instructionsAllowed: true,
    usableAsEvidence: false,
    usableAsWritingGuidance: true,
    snapshotHash: 'hash',
  };
}

function target(overrides: Partial<OutreachV3ResolvedTargetRef>): OutreachV3ResolvedTargetRef {
  return {
    targetKey: 'target:1',
    locator: { source: 'directory_staff', id: '1' },
    displayName: 'Priya Anand',
    title: null,
    organization: null,
    email: 'priya@house.gov',
    clientId: null,
    roleStatus: 'current',
    snapshotHash: 'hash',
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: null,
      state: null,
      district: null,
      committees: [],
      issueAreas: [],
    },
    ...overrides,
  };
}

function session(overrides: {
  criteria?: Record<string, unknown> | null;
  strategy?: { campaignAngle: string; tone: string; length: string };
  delivery?: { pattern: string; personalization: string };
  goal?: string | null;
  topic?: string | null;
  writingGuidanceRefs?: OutreachV3ResolvedContextRef[];
  selectedTargetRefs?: OutreachV3ResolvedTargetRef[];
  sponsor?: { kind: 'firm' | 'client' | 'undecided'; label: string | null; clientId?: string };
}): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: null, status: 'active' },
    currentStateVersion: 1,
    specHash: 'spec-hash',
    readiness: {} as OutreachV3SessionEnvelope['readiness'],
    pendingProposalCount: 0,
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: overrides.goal ?? null,
        objective: null,
        topic: overrides.topic ?? null,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: {
        kind: overrides.sponsor?.kind ?? 'undecided',
        label: overrides.sponsor?.label ?? null,
        clientRefs: overrides.sponsor?.clientId ? [{ clientId: overrides.sponsor.clientId }] : [],
      },
      targeting: {
        criteria: (overrides.criteria ?? null) as never,
        selectedTargetRefs: overrides.selectedTargetRefs ?? [],
        rejectedRecommendationRefs: [],
      },
      delivery: (overrides.delivery ?? {
        pattern: 'undecided',
        personalization: 'undecided',
      }) as never,
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: overrides.writingGuidanceRefs ?? [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: (overrides.strategy
        ? { ...overrides.strategy, customLengthInstruction: null }
        : { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null }) as never,
    },
  };
}

const ALL_TYPES: OutreachCampaignType[] = ['request_meeting', 'send_update', 'custom'];

describe('campaign type round-trip', () => {
  it('reads back every type it writes, named or unnamed', () => {
    for (const type of ALL_TYPES) {
      for (const name of ['', 'FY27 Ground Robotics — where the autonomy provision landed']) {
        const commands = outreachGoalCommandsFor(type, name);
        const setGoal = commands.find((command) => command.type === 'SET_GOAL');
        const value = (setGoal?.payload as { value?: string } | undefined)?.value;
        expect(value).toBe(outreachCampaignTypeGoalPhrase(type));
        expect(outreachCampaignTypeFromSpec(session({ goal: value ?? null }))).toBe(type);
      }
    }
  });

  it('writes only the goal phrase before the campaign has a name', () => {
    // `workflowCampaignDefaults` derives the objective, desired outcome, ask and
    // why-now FROM the campaign name. Sending it a placeholder would put
    // invented prose in the packet before the user has written a subject line.
    const commands = outreachGoalCommandsFor('send_update', '   ');
    expect(commands.map((command) => command.type)).toEqual(['SET_GOAL']);
  });

  it('writes the whole goal once a name exists, with the name as the topic', () => {
    const commands = outreachGoalCommandsFor('request_meeting', ' Section 215 update ');
    const types = commands.map((command) => command.type);
    expect(types).toContain('SET_GOAL');
    expect(types.length).toBeGreaterThan(1);
    const topic = commands.find((command) => command.type === 'SET_TOPIC');
    expect((topic?.payload as { value?: string } | undefined)?.value).toBe('Section 215 update');
  });

  it('has no type at all before a goal is written', () => {
    expect(outreachCampaignTypeFromSpec(session({ goal: null }))).toBeNull();
    expect(outreachCampaignTypeFromSpec(session({ goal: '   ' }))).toBeNull();
    expect(outreachCampaignTypeFromSpec(null)).toBeNull();
  });

  it('still classifies a goal written by the older guided flow', () => {
    // Legacy specs phrase a custom campaign as "Advance <name>". The canonical
    // pass has to run first, or "Custom campaign" itself would fall through to
    // the substring reader.
    expect(outreachCampaignTypeFromSpec(session({ goal: 'Request a meeting' }))).toBe(
      'request_meeting',
    );
    expect(outreachCampaignTypeFromSpec(session({ goal: 'Send a client update' }))).toBe(
      'send_update',
    );
    expect(outreachCampaignTypeFromSpec(session({ goal: 'Advance FY27 robotics' }))).toBe('custom');
  });

  it('does not let a campaign NAME decide the type', () => {
    // The regression this guards: a custom campaign called "FY27 budget update"
    // used to read back as `send_update`, which silently changed which steps
    // the rail offered. The canonical phrase is on `goal.goal`, and `topic`
    // never participates.
    const spec = session({
      goal: outreachCampaignTypeGoalPhrase('custom'),
      topic: 'FY27 budget update — meeting notes',
    });
    expect(outreachCampaignTypeFromSpec(spec)).toBe('custom');
    expect(outreachCampaignNameFromSpec(spec)).toBe('FY27 budget update — meeting notes');
  });
});

describe('email format marker', () => {
  it('round-trips every format through its guidance marker', () => {
    for (const format of OUTREACH_EMAIL_FORMATS) {
      const selection = outreachEmailFormatSelection(format);
      const title = String(selection.locator.title);
      expect(title.startsWith(OUTREACH_FORMAT_MARKER)).toBe(true);
      const read = outreachEmailFormatFromSpec(
        session({ writingGuidanceRefs: [guidanceRef(title)] }),
      );
      expect(read?.id).toBe(format.id);
    }
  });

  it('has no format until one is chosen, and ignores unrelated guidance', () => {
    expect(outreachEmailFormatFromSpec(session({}))).toBeNull();
    expect(
      outreachEmailFormatFromSpec(
        session({ writingGuidanceRefs: [guidanceRef('Campaign subject line')] }),
      ),
    ).toBeNull();
  });

  it('prefers the most recent marker if a failed switch ever left two', () => {
    const spec = session({
      writingGuidanceRefs: [
        guidanceRef(`${OUTREACH_FORMAT_MARKER} · Briefing card`),
        guidanceRef(`${OUTREACH_FORMAT_MARKER} · Timeline update`),
      ],
    });
    expect(outreachEmailFormatFromSpec(spec)?.id).toBe('timeline');
  });

  it('forces plain text for a meeting request whatever the spec says', () => {
    // A meeting request has no Format step. A marker left behind by an earlier
    // campaign type must not silently keep applying.
    const spec = session({
      writingGuidanceRefs: [guidanceRef(`${OUTREACH_FORMAT_MARKER} · Briefing card`)],
    });
    expect(outreachEffectiveEmailFormat(spec, 'request_meeting').id).toBe('standard');
    expect(outreachEffectiveEmailFormat(spec, 'send_update').id).toBe('briefing_card');
    expect(outreachEffectiveEmailFormat(spec, null).id).toBe('briefing_card');
  });

  it('finds guidance refs by marker prefix only', () => {
    const spec = session({
      writingGuidanceRefs: [
        guidanceRef(`${OUTREACH_FORMAT_MARKER} · Status table`),
        guidanceRef('Campaign subject line'),
      ],
    });
    expect(outreachGuidanceRefsWithMarker(spec, OUTREACH_FORMAT_MARKER)).toHaveLength(1);
    expect(outreachGuidanceRefsWithMarker(spec, 'Campaign subject line')).toHaveLength(1);
    expect(outreachGuidanceRefsWithMarker(null, OUTREACH_FORMAT_MARKER)).toEqual([]);
  });
});

describe('recipients', () => {
  it('treats a missing or invalid address as not sendable', () => {
    expect(outreachTargetIsSendable(target({}))).toBe(true);
    expect(outreachTargetIsSendable(target({ email: null }))).toBe(false);
    expect(outreachTargetIsSendable(target({ email: '   ' }))).toBe(false);
    // `emailStatus` is authoritative even when an address string is present.
    expect(
      outreachTargetIsSendable(target({ email: 'stale@house.gov', emailStatus: 'invalid' })),
    ).toBe(false);
    expect(
      outreachTargetIsSendable(target({ email: 'ok@house.gov', emailStatus: 'available' })),
    ).toBe(true);
  });

  it('lists exactly the blocked targets', () => {
    const spec = session({
      selectedTargetRefs: [
        target({ targetKey: 'a' }),
        target({ targetKey: 'b', email: null }),
        target({ targetKey: 'c', emailStatus: 'missing' }),
      ],
    });
    expect(outreachBlockedTargets(spec).map((row) => row.targetKey)).toEqual(['b', 'c']);
    expect(outreachBlockedTargets(null)).toEqual([]);
  });

  it('pluralises the recipient summary', () => {
    expect(outreachRecipientSummary(0)).toBe('0 recipients · one email each');
    expect(outreachRecipientSummary(1)).toBe('1 recipient · one email');
    expect(outreachRecipientSummary(4)).toBe('4 recipients · one email each');
  });
});

describe('campaign facts', () => {
  it('reads an unset value as "Not set" rather than borrowing a neighbour', () => {
    const facts = outreachCampaignFacts({
      subjectLine: '  ',
      campaignTypeLabel: 'Send update',
      sponsorLabel: '',
      startedFrom: 'Firm Template',
    });
    expect(facts.map((fact) => [fact.key, fact.value, fact.unset])).toEqual([
      ['Subject line', 'Not set', true],
      ['Campaign type', 'Send update', false],
      ['Sponsor', 'Not set', true],
      ['Started from', 'Firm Template', false],
    ]);
  });
});

describe('sponsor', () => {
  it('reads the sponsor and its sole client, and reports undecided honestly', () => {
    expect(outreachSponsorFromSpec(session({}))).toEqual({
      kind: 'undecided',
      label: '',
      clientId: null,
    });
    expect(
      outreachSponsorFromSpec(
        session({ sponsor: { kind: 'client', label: 'Overland AI', clientId: 'client-1' } }),
      ),
    ).toEqual({ kind: 'client', label: 'Overland AI', clientId: 'client-1' });
  });
});

describe('unwired controls', () => {
  it('names every control the prototype shows that no endpoint backs', () => {
    // This list is the deliverable, not a nicety: it is what the release note
    // reports. A control that becomes wired must leave it in the same change.
    expect(OUTREACH_UNWIRED_CONTROLS.map((row) => row.control)).toEqual([
      'Email format',
      'Campaign subject line',
      'Per-template context options',
      'Campaign document upload',
      'Send scheduling',
      'Send pacing',
    ]);
    for (const row of OUTREACH_UNWIRED_CONTROLS) {
      expect(row.reality.length).toBeGreaterThan(40);
    }
  });
});

describe('spec fields the prototype has no control for', () => {
  const picked = [
    target({
      targetKey: 'directory_member:m1',
      locator: { source: 'directory_member', id: 'm1' },
      jurisdiction: {
        governmentLevel: 'federal',
        chamber: 'house',
        state: 'CA',
        district: '12',
        committees: ['House Armed Services'],
        issueAreas: [],
      },
    }),
    target({
      targetKey: 'directory_staff:s1',
      locator: { source: 'directory_staff', id: 's1' },
      jurisdiction: {
        governmentLevel: 'federal',
        chamber: 'senate',
        state: 'TX',
        district: null,
        committees: ['Senate Armed Services'],
        issueAreas: [],
      },
    }),
  ];

  it('derives criteria from the real selection when the campaign has none', () => {
    // Without this the server blocks generation with TARGET_CRITERIA_MISSING
    // and reports only "Complete the review packet", naming no field.
    const commands = outreachGenerationSpecCommands(session({ criteria: null }), picked, 'send_update');
    const criteria = commands.find((command) => command.type === 'SET_TARGET_CRITERIA');
    expect((criteria?.payload as { value?: Record<string, unknown> }).value).toMatchObject({
      governmentLevels: ['federal'],
      chambers: ['house', 'senate'],
      committees: ['House Armed Services', 'Senate Armed Services'],
      states: ['CA', 'TX'],
      includeStaff: true,
      includePrincipals: true,
    });
  });

  it('describes who was picked, not a filter the user never set', () => {
    const membersOnly = outreachGenerationSpecCommands(session({ criteria: null }), [picked[0]!], 'send_update');
    const value = (
      membersOnly.find((c) => c.type === 'SET_TARGET_CRITERIA')?.payload as {
        value?: Record<string, unknown>;
      }
    ).value;
    expect(value).toMatchObject({ includeStaff: false, includePrincipals: true, chambers: ['house'] });
  });

  it('defaults delivery to one tailored email per person when undecided', () => {
    const commands = outreachGenerationSpecCommands(session({ criteria: null }), picked, 'send_update');
    const types = commands.map((command) => command.type);
    expect(types).toContain('SET_DELIVERY_PATTERN');
  });

  it('never overwrites a group that has already chosen a shared thread', () => {
    // A group silently becoming one-email-each is the disclosure failure the
    // list-vs-group distinction exists to prevent.
    const commands = outreachGenerationSpecCommands(
      session({
        criteria: { chambers: ['house'] },
        delivery: { pattern: 'shared_thread', personalization: 'light' },
        strategy: { campaignAngle: 'angle', tone: 'tone', length: 'short' },
      }),
      picked,
      'send_update',
    );
    expect(commands).toEqual([]);
  });

  it('writes nothing once the spec is complete, so an accept stays idempotent', () => {
    const commands = outreachGenerationSpecCommands(
      session({
        criteria: { chambers: ['house'] },
        delivery: { pattern: 'personalized_separate', personalization: 'high' },
        strategy: { campaignAngle: 'angle', tone: 'tone', length: 'short' },
      }),
      picked,
      'send_update',
    );
    expect(commands).toEqual([]);
  });

  it('writes nothing with no targets', () => {
    expect(outreachGenerationSpecCommands(session({ criteria: null }), [], 'send_update')).toEqual([]);
  });
});

describe('campaign type also writes the strategy', () => {
  it('sends the strategy half, without which generation is blocked', () => {
    // `deriveOutreachReadiness` requires campaignAngle + tone + a decided
    // length. Sending only the goal half left every campaign unable to draft.
    const types = outreachGoalCommandsFor('send_update', 'FY27 mark-up').map((c) => c.type);
    expect(types).toContain('SET_CAMPAIGN_ANGLE');
    expect(types).toContain('SET_TONE');
    expect(types).toContain('SET_LENGTH');
  });
});
