import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
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
        tool: 'outreach_evidence:outreach_v3:memory_item:fact-a',
        serialized: 'Exact bounded fact A',
        result: expect.objectContaining({
          sourceType: 'outreach_v3:memory_item:fact-a',
          sourceId: 'outreach_v3:memory_item:fact-a:all',
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
    expect(unit.enrichments.map((entry) => entry.sourceType)).toEqual([
      'outreach_v3:memory_item:fact-a',
      'outreach_v3:memory_item:fact-b',
    ]);
    expect(unit.auditLedger.map((entry) => entry.serialized)).toEqual(['A text', 'B text']);
    expect(unit.enrichments[0]?.scope).toBe('all');
  });
});
