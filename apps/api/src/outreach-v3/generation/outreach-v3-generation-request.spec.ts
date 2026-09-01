import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import type { GaAudience } from '../../engagement/generation/government-affairs-policy.registry.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import type { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { PreparedOutreachV3GenerationSlot } from './outreach-v3-generation-preparation.service.js';
import type {
  OutreachV3GenerationPlan,
  OutreachV3GenerationSlot,
} from './outreach-v3-generation-plan.js';
import { buildOutreachV3GatewayUnit } from './outreach-v3-generation-request.js';

function target(id: string): OutreachResolvedTargetRefV1 {
  return {
    targetKey: `directory_member:${id}`,
    locator: { source: 'directory_member', id },
    displayName: `Target ${id}`,
    email: `${id}@example.test`,
    phone: null,
    title: 'Legislative Director',
    organization: 'Office',
    clientId: null,
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'house',
      state: 'VA',
      district: '01',
      committees: [],
      issueAreas: [],
    },
    roleStatus: 'current',
    emailStatus: 'available',
    profileStatus: 'complete',
    sourceSnapshot: { system: 'directory', version: '1', lastVerifiedAt: null },
    snapshotHash: 'a'.repeat(64),
  } as OutreachResolvedTargetRefV1;
}

function manualTarget(id: string, audienceType: GaAudience | null = null): OutreachResolvedTargetRefV1 {
  return {
    targetKey: `manual:${id}`,
    locator: { source: 'manual', id, name: `Manual ${id}`, email: null, phone: null, title: null, organization: null, note: null, audienceType },
    displayName: `Manual ${id}`,
    email: `${id}@example.test`,
    phone: null,
    title: null,
    organization: null,
    clientId: null,
    jurisdiction: {
      governmentLevel: 'unknown',
      chamber: null,
      state: null,
      district: null,
      committees: [],
      issueAreas: [],
    },
    roleStatus: 'unknown',
    emailStatus: 'available',
    profileStatus: 'limited',
    sourceSnapshot: { system: 'user_supplied', version: null, lastVerifiedAt: null },
    snapshotHash: 'a'.repeat(64),
  } as OutreachResolvedTargetRefV1;
}

function slot(targetKey: string): OutreachV3GenerationSlot {
  return {
    generationKey: `v3:session:target:${targetKey}`,
    recipientKey: targetKey,
    audienceKind: 'individual',
    scopeKeys: [targetKey],
    recipients: [],
    context: {
      requiredPolicy: [],
      writingGuidance: [],
      campaignFacts: [],
      targetSpecific: [],
      groupSafe: [],
    },
    diversitySignature: 'directory_member|federal|house|VA|-',
  };
}

function plan(generationSlot: OutreachV3GenerationSlot): OutreachV3GenerationPlan {
  return {
    planVersion: 'outreach_v3_generation_plan_v1',
    planHash: 'b'.repeat(64),
    sessionId: '11111111-1111-4111-8111-111111111111',
    stateVersion: 7,
    specHash: 'c'.repeat(64),
    eligible: true,
    blockers: [],
    sponsorClientId: null,
    deliveryPattern: 'personalized_separate',
    personalization: 'high',
    slots: [generationSlot],
    representativeSampleKeys: [generationSlot.generationKey],
  };
}

function prepared(generationSlot: OutreachV3GenerationSlot): PreparedOutreachV3GenerationSlot {
  return {
    slot: generationSlot,
    currentTargets: [target('alpha')],
    selectedItems: [],
    serverEvidence: [],
    sourceContextKeys: [],
  };
}

describe('Outreach V3 gateway request compiler', () => {
  it('derives recipient identity and exact state provenance server-side', () => {
    const spec = createBlankCampaignSpecV1();
    spec.goal.goal = 'Protect program funding';
    spec.goal.objective = 'Secure support';
    spec.strategy.campaignAngle = 'Operational readiness';
    spec.strategy.tone = 'formal';
    spec.strategy.length = 'short';
    const generationSlot = slot('directory_member:alpha');

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: prepared(generationSlot),
    });

    expect(unit.request.recipient).toEqual(
      expect.objectContaining({
        recipientKey: 'directory_member:alpha',
        name: 'Target alpha',
        email: 'alpha@example.test',
        sourceType: 'directory_member',
      }),
    );
    expect(unit.request.ref).toEqual(
      expect.objectContaining({
        outreachV3StateVersion: '7',
        outreachV3SpecHash: 'c'.repeat(64),
        outreachV3PlanHash: 'b'.repeat(64),
      }),
    );
    expect(unit.request.tone).toBe('formal');
    expect(unit.request.length).toBe('short');
  });

  it('preserves the exact groupMembers shape consumed by the existing send envelope builder', () => {
    const spec = createBlankCampaignSpecV1();
    const groupSlot: OutreachV3GenerationSlot = {
      ...slot('shared'),
      generationKey: 'v3:session:shared:abc',
      recipientKey: 'shared:abc',
      audienceKind: 'group',
    };
    const preparedGroup: PreparedOutreachV3GenerationSlot = {
      ...prepared(groupSlot),
      currentTargets: [target('alpha'), target('bravo')],
    };
    const groupPlan = plan(groupSlot);
    groupPlan.deliveryPattern = 'shared_thread';
    groupPlan.personalization = 'light';

    const unit = buildOutreachV3GatewayUnit({
      plan: groupPlan,
      spec,
      prepared: preparedGroup,
    });
    expect(unit.request.recipient.snapshot).toEqual(
      expect.objectContaining({
        kind: 'shared_thread',
        groupMembers: [
          expect.objectContaining({ email: 'alpha@example.test', name: 'Target alpha' }),
          expect.objectContaining({ email: 'bravo@example.test', name: 'Target bravo' }),
        ],
      }),
    );
    expect(unit.request.recipient).toEqual(
      expect.objectContaining({
        sourceType: 'outreach_v3_group',
        sourceTypes: ['directory_member'],
        governmentLevel: 'federal',
      }),
    );
  });

  it('preserves custom tone and custom length only as authenticated directives', () => {
    const spec = createBlankCampaignSpecV1();
    spec.goal.objective = 'Secure support';
    spec.strategy.tone = 'Calm, direct, and technically literate';
    spec.strategy.length = 'custom';
    spec.strategy.customLengthInstruction = 'Keep it under 140 words.';
    const generationSlot = slot('directory_member:alpha');

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: prepared(generationSlot),
    });
    expect(unit.request.tone).toBe('professional');
    expect(unit.request.length).toBe('standard');
    expect(unit.request.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'note', noteUse: 'instruction' }),
        expect.objectContaining({ customNoteText: expect.stringContaining('under 140 words') }),
      ]),
    );
  });

  it('fails closed if prepared evidence crosses the sole-client boundary', () => {
    const spec = createBlankCampaignSpecV1();
    const generationSlot = slot('directory_member:alpha');
    const campaignPlan = plan(generationSlot);
    campaignPlan.sponsorClientId = '22222222-2222-4222-8222-222222222222';
    const preparedSlot = prepared(generationSlot);
    preparedSlot.serverEvidence = [
      {
        contextKey: 'wrong-client',
        sourceType: 'outreach_v3:memory_item',
        sourceId: 'wrong-client',
        title: 'Wrong client',
        text: 'Private client information',
        truncated: false,
        trust: 'server_record',
        clientId: '33333333-3333-4333-8333-333333333333',
        authoritativeAsOf: null,
      },
    ];

    let thrown: OutreachCommandError | null = null;
    try {
      buildOutreachV3GatewayUnit({ plan: campaignPlan, spec, prepared: preparedSlot });
    } catch (error) {
      thrown = error as OutreachCommandError;
    }
    expect(thrown?.code).toBe('OUTREACH_COMMAND_BLOCKED');
  });

  it('uses one captured bounded string for packet enrichment and the audit ledger', async () => {
    const spec = createBlankCampaignSpecV1();
    const generationSlot = slot('directory_member:alpha');
    const preparedSlot = prepared(generationSlot);
    preparedSlot.serverEvidence = [
      {
        contextKey: 'fact-a',
        sourceType: 'outreach_v3:memory_item',
        sourceId: 'fact-a',
        title: 'A',
        text: 'Exact bounded fact A',
        truncated: true,
        trust: 'server_record',
        clientId: null,
        authoritativeAsOf: '2026-08-11T00:00:00.000Z',
      },
    ];

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: preparedSlot,
    });
    expect(await unit.enrichments[0]!.load()).toBe('Exact bounded fact A');
    expect(unit.auditLedger).toEqual([
      expect.objectContaining({
        tool: 'outreach_evidence:fact-a',
        serialized: 'Exact bounded fact A',
        result: expect.objectContaining({
          // sourceType stays a genuine TYPE; per-source identity is the contextKey.
          // Previously both were `outreach_v3:memory_item:fact-a`, which for real
          // V3 context produced 130-char ids the planner could not cite back.
          sourceType: 'outreach_v3:memory_item',
          sourceId: 'fact-a',
          contextKey: 'fact-a',
          truncated: true,
        }),
      }),
    ]);
  });

  it('creates unique durable evidence-channel identities for V3 server evidence', () => {
    const spec = createBlankCampaignSpecV1();
    const generationSlot = slot('directory_member:alpha');
    const preparedSlot = prepared(generationSlot);
    preparedSlot.serverEvidence = [
      {
        contextKey: 'fact-a',
        sourceType: 'outreach_v3:memory_item',
        sourceId: 'fact-a',
        title: 'A',
        text: 'A text',
        truncated: false,
        trust: 'server_record',
        clientId: null,
        authoritativeAsOf: null,
      },
      {
        contextKey: 'fact-b',
        sourceType: 'outreach_v3:memory_item',
        sourceId: 'fact-b',
        title: 'B',
        text: 'B text',
        truncated: false,
        trust: 'server_record',
        clientId: null,
        authoritativeAsOf: null,
      },
    ];

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: preparedSlot,
    });
    // Two sources of the SAME type must remain individually addressable. Identity
    // now rides `sourceKey` (the contextKey) rather than being smuggled into
    // `sourceType`, so the type stays short and citable.
    expect(unit.enrichments.map((entry) => entry.sourceType)).toEqual([
      'outreach_v3:memory_item',
      'outreach_v3:memory_item',
    ]);
    expect(unit.enrichments.map((entry) => entry.sourceKey)).toEqual(['fact-a', 'fact-b']);
    // The identity the planner actually has to cite is the packet's sourceId,
    // which resolves from sourceKey — assert it is unique per source.
    const packetSourceIds = unit.enrichments.map(
      (entry) => entry.sourceKey ?? `${entry.sourceType}:${entry.scope}`,
    );
    expect(new Set(packetSourceIds).size).toBe(2);
    expect(
      unit.auditLedger.map((entry) => (entry.result as { sourceId: string }).sourceId),
    ).toEqual(['fact-a', 'fact-b']);
    expect(unit.auditLedger.map((entry) => entry.serialized)).toEqual(['A text', 'B text']);
    expect(unit.enrichments[0]?.scope).toBe('all');
  });

  it('keeps V3 evidence source ids short and free of repeated segments', () => {
    // Regression for the live 2026-08-24 outage: the compiler used to build
    // sourceType = `${sourceType}:${contextKey}` and sourceId = `${that}:all`.
    // Because sourceType is derived from the same locator the contextKey encodes,
    // the result repeated whole segments and ran to 133 chars, which the planner
    // could not echo byte-exact — every claim tripped CLAIM_CITES_UNKNOWN_SOURCE
    // and no draft call was ever made.
    const spec = createBlankCampaignSpecV1();
    const generationSlot = slot('directory_staff:staff-1');
    const preparedSlot = prepared(generationSlot);
    const realContextKey =
      'campaign_fact:campaign:government_record:lda_filing:4ff509f7-2b21-4e49-b11d-ba7c4ac4dc4a';
    preparedSlot.serverEvidence = [
      {
        contextKey: realContextKey,
        sourceType: 'outreach_v3:government_record:lda_filing',
        sourceId: realContextKey,
        title: 'CAREER START',
        text: 'bounded fact',
        truncated: false,
        trust: 'authoritative_structured',
        clientId: null,
        authoritativeAsOf: '2026-07-20T17:52:07.000Z',
      },
    ];

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: preparedSlot,
    });

    const citedId = (unit.auditLedger[0]!.result as { sourceId: string }).sourceId;
    // The old broken id was 133 chars; the type alone was 129.
    expect(citedId.length).toBeLessThan(100);
    expect(unit.enrichments[0]!.sourceType.length).toBeLessThan(50);
    // No segment may appear twice — self-similarity is what broke transcription.
    const segments = citedId.split(':');
    expect(new Set(segments).size).toBe(segments.length);
    // And the type must not be redundantly re-stated as a prefix of the id.
    expect(citedId.startsWith(unit.enrichments[0]!.sourceType)).toBe(false);
  });

  it('carries a manual target\'s declared audience through as an explicit override', () => {
    const spec = createBlankCampaignSpecV1();
    const generationSlot = slot('manual:alpha');
    const preparedSlot: PreparedOutreachV3GenerationSlot = {
      ...prepared(generationSlot),
      currentTargets: [manualTarget('alpha', 'client_executive')],
    };

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: preparedSlot,
    });
    expect(unit.request.explicitAudience).toBe('client_executive');
  });

  it('leaves the audience unresolved for a manual target with no declared audience', () => {
    const spec = createBlankCampaignSpecV1();
    const generationSlot = slot('manual:alpha');
    const preparedSlot: PreparedOutreachV3GenerationSlot = {
      ...prepared(generationSlot),
      currentTargets: [manualTarget('alpha')],
    };

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: preparedSlot,
    });
    expect(unit.request.explicitAudience).toBeNull();
  });

  it('never lets one manual member\'s declared audience override a shared-thread group', () => {
    const spec = createBlankCampaignSpecV1();
    const groupSlot: OutreachV3GenerationSlot = {
      ...slot('shared'),
      generationKey: 'v3:session:shared:abc',
      recipientKey: 'shared:abc',
      audienceKind: 'group',
    };
    const groupPlan = plan(groupSlot);
    groupPlan.deliveryPattern = 'shared_thread';
    groupPlan.personalization = 'light';
    const preparedGroup: PreparedOutreachV3GenerationSlot = {
      ...prepared(groupSlot),
      currentTargets: [manualTarget('alpha', 'client_executive'), target('bravo')],
    };

    const unit = buildOutreachV3GatewayUnit({
      plan: groupPlan,
      spec,
      prepared: preparedGroup,
    });
    expect(unit.request.explicitAudience).toBeNull();
  });

  it('threads a target\'s Cc/Bcc from the campaign spec\'s separate targetCcBcc map into the recipient snapshot', () => {
    const spec = createBlankCampaignSpecV1();
    spec.targeting.targetCcBcc = {
      'directory_member:alpha': { cc: ['chief@office.test'], bcc: ['archive@firm.test'] },
    };
    const generationSlot = slot('directory_member:alpha');

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: prepared(generationSlot),
    });

    expect(unit.request.recipient.snapshot).toEqual(
      expect.objectContaining({
        cc: ['chief@office.test'],
        bcc: ['archive@firm.test'],
      }),
    );
  });

  it('defaults a target\'s Cc/Bcc to empty arrays when the campaign spec has no entry for it', () => {
    const spec = createBlankCampaignSpecV1();
    const generationSlot = slot('directory_member:alpha');

    const unit = buildOutreachV3GatewayUnit({
      plan: plan(generationSlot),
      spec,
      prepared: prepared(generationSlot),
    });

    expect(unit.request.recipient.snapshot).toEqual(
      expect.objectContaining({ cc: [], bcc: [] }),
    );
  });

  it('threads each shared-thread group member\'s own Cc/Bcc into its groupMembers snapshot', () => {
    const spec = createBlankCampaignSpecV1();
    spec.targeting.targetCcBcc = {
      'directory_member:bravo': { cc: ['legal@firm.test'], bcc: [] },
    };
    const groupSlot: OutreachV3GenerationSlot = {
      ...slot('shared'),
      generationKey: 'v3:session:shared:abc',
      recipientKey: 'shared:abc',
      audienceKind: 'group',
    };
    const groupPlan = plan(groupSlot);
    groupPlan.deliveryPattern = 'shared_thread';
    groupPlan.personalization = 'light';
    const preparedGroup: PreparedOutreachV3GenerationSlot = {
      ...prepared(groupSlot),
      currentTargets: [target('alpha'), target('bravo')],
    };

    const unit = buildOutreachV3GatewayUnit({
      plan: groupPlan,
      spec,
      prepared: preparedGroup,
    });

    const members = (unit.request.recipient.snapshot as { members: Array<{ targetKey: string; cc: string[]; bcc: string[] }> }).members;
    expect(members.find((m) => m.targetKey === 'directory_member:alpha')).toEqual(
      expect.objectContaining({ cc: [], bcc: [] }),
    );
    expect(members.find((m) => m.targetKey === 'directory_member:bravo')).toEqual(
      expect.objectContaining({ cc: ['legal@firm.test'], bcc: [] }),
    );
  });

  it('unions every member\'s Cc/Bcc onto the shared-thread group snapshot\'s own top-level cc/bcc (what buildEnvelope reads)', () => {
    const spec = createBlankCampaignSpecV1();
    spec.targeting.targetCcBcc = {
      'directory_member:alpha': { cc: ['chief@office.test'], bcc: ['archive@firm.test'] },
      'directory_member:bravo': { cc: ['legal@firm.test', 'chief@office.test'], bcc: [] },
    };
    const groupSlot: OutreachV3GenerationSlot = {
      ...slot('shared'),
      generationKey: 'v3:session:shared:abc',
      recipientKey: 'shared:abc',
      audienceKind: 'group',
    };
    const groupPlan = plan(groupSlot);
    groupPlan.deliveryPattern = 'shared_thread';
    groupPlan.personalization = 'light';
    const preparedGroup: PreparedOutreachV3GenerationSlot = {
      ...prepared(groupSlot),
      currentTargets: [target('alpha'), target('bravo')],
    };

    const unit = buildOutreachV3GatewayUnit({
      plan: groupPlan,
      spec,
      prepared: preparedGroup,
    });

    const snapshot = unit.request.recipient.snapshot as { cc: string[]; bcc: string[] };
    // Deduped union: chief@office.test appears once even though two members Cc it.
    expect(snapshot.cc).toEqual(['chief@office.test', 'legal@firm.test']);
    expect(snapshot.bcc).toEqual(['archive@firm.test']);
  });

  it('excludes a group member\'s own To address from the unioned Cc/Bcc and keeps Cc/Bcc disjoint (Cc wins)', () => {
    const spec = createBlankCampaignSpecV1();
    const alpha = target('alpha');
    const bravo = target('bravo');
    spec.targeting.targetCcBcc = {
      // bravo Cc's alpha's own To address → must not be duplicated into Cc.
      'directory_member:alpha': { cc: [String(bravo.email)], bcc: ['shared@firm.test'] },
      // alpha's Bcc address is also Cc'd by bravo → Cc wins, Bcc drops it.
      'directory_member:bravo': { cc: ['shared@firm.test'], bcc: [] },
    };
    const groupSlot: OutreachV3GenerationSlot = {
      ...slot('shared'),
      generationKey: 'v3:session:shared:abc',
      recipientKey: 'shared:abc',
      audienceKind: 'group',
    };
    const groupPlan = plan(groupSlot);
    groupPlan.deliveryPattern = 'shared_thread';
    groupPlan.personalization = 'light';
    const preparedGroup: PreparedOutreachV3GenerationSlot = {
      ...prepared(groupSlot),
      currentTargets: [alpha, bravo],
    };

    const unit = buildOutreachV3GatewayUnit({
      plan: groupPlan,
      spec,
      prepared: preparedGroup,
    });

    const snapshot = unit.request.recipient.snapshot as { cc: string[]; bcc: string[] };
    expect(snapshot.cc).toEqual(['shared@firm.test']);
    expect(snapshot.bcc).toEqual([]);
  });

  it('leaves the shared-thread group snapshot cc/bcc empty when no member has any', () => {
    const spec = createBlankCampaignSpecV1();
    const groupSlot: OutreachV3GenerationSlot = {
      ...slot('shared'),
      generationKey: 'v3:session:shared:abc',
      recipientKey: 'shared:abc',
      audienceKind: 'group',
    };
    const groupPlan = plan(groupSlot);
    groupPlan.deliveryPattern = 'shared_thread';
    groupPlan.personalization = 'light';
    const preparedGroup: PreparedOutreachV3GenerationSlot = {
      ...prepared(groupSlot),
      currentTargets: [target('alpha'), target('bravo')],
    };

    const unit = buildOutreachV3GatewayUnit({
      plan: groupPlan,
      spec,
      prepared: preparedGroup,
    });

    const snapshot = unit.request.recipient.snapshot as { cc: string[]; bcc: string[] };
    expect(snapshot.cc).toEqual([]);
    expect(snapshot.bcc).toEqual([]);
  });
});
