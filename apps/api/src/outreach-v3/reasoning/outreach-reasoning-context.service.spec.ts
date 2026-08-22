import type { TenantContext } from '@capiro/shared';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { deriveOutreachTargetCoverage } from '../targets/outreach-target-coverage.service.js';
import { OutreachReasoningContextService } from './outreach-reasoning-context.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  tenantSlug: 'test',
  role: 'standard_user',
} as TenantContext;

function campaign(spec = createBlankCampaignSpecV1()) {
  return {
    sessionId: '00000000-0000-4000-8000-000000000010',
    currentStateVersion: 3,
    specHash: 'a'.repeat(64),
    spec,
    readiness: { blockers: [] },
    targetCoverage: deriveOutreachTargetCoverage(
      spec.targeting.criteria,
      spec.targeting.selectedTargetRefs,
    ),
    pendingProposalCount: 0,
  };
}

function campaignWithClient() {
  const spec = createBlankCampaignSpecV1();
  spec.sponsor = {
    kind: 'client',
    label: null,
    clientRefs: [{ clientId: '00000000-0000-4000-8000-000000000030' }],
  };
  return campaign(spec);
}

const allRegistered = [
  'get_capiro_record',
  'get_client_context',
  'get_recent_activity',
  'search_targets',
  'get_target_profile',
  'analyze_relationships',
];

function harness(registered = allRegistered) {
  const sessions = { getSession: jest.fn() };
  const capabilities = {
    listForSurface: jest.fn(() => registered.map((name) => ({ name }))),
    get: jest.fn((name: string) =>
      registered.includes(name) ? { name, surfaces: ['outreach'] } : undefined,
    ),
    execute: jest.fn(async (name: string, capabilityCtx: unknown, input: unknown) => ({
      capability: name,
      schemaVersion: 1,
      data: input,
      provenance: [],
      exclusions: [],
      scope: {
        tenantId: ctx.tenantId,
        clientId:
          input && typeof input === 'object' && 'clientId' in input
            ? ((input as { clientId?: string | null }).clientId ?? null)
            : null,
      },
      freshness: { asOf: '2026-08-08T00:00:00.000Z', degraded: false, reasons: [] },
      authorization: { filtered: false, restrictedCount: 0 },
      capabilityCtx,
    })),
  };
  return {
    service: new OutreachReasoningContextService(sessions as never, capabilities as never),
    sessions,
    capabilities,
  };
}

describe('OutreachReasoningContextService', () => {
  it('binds a one-client campaign to that client in server-owned capability scope', () => {
    const spec = createBlankCampaignSpecV1();
    spec.sponsor = {
      kind: 'client',
      label: null,
      clientRefs: [{ clientId: '00000000-0000-4000-8000-000000000020' }],
    };
    const h = harness();

    expect(h.service.capabilityContext(ctx, campaign(spec).sessionId, campaign(spec))).toMatchObject({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      surface: 'outreach',
      clientScope: {
        clientId: '00000000-0000-4000-8000-000000000020',
        reason: 'campaign',
      },
    });
  });

  it('does not fabricate a primary client for a multi-client campaign', () => {
    const spec = createBlankCampaignSpecV1();
    spec.sponsor = {
      kind: 'multi_client',
      label: null,
      clientRefs: [
        { clientId: '00000000-0000-4000-8000-000000000030' },
        { clientId: '00000000-0000-4000-8000-000000000021' },
      ],
    };
    const h = harness();

    expect(h.service.capabilityContext(ctx, campaign(spec).sessionId, campaign(spec)).clientScope).toBeNull();
  });

  it('exposes target intelligence without fabricating a sponsor client', () => {
    const h = harness();
    expect(h.service.providerTools(campaign()).map((tool) => tool.name)).toEqual([
      'search_targets',
      'get_target_profile',
      'analyze_relationships',
    ]);
  });

  it('adds sponsor-context tools only when the campaign has authorized sponsor clients', () => {
    const h = harness(['get_capiro_record', 'get_recent_activity', 'search_targets']);
    expect(h.service.providerTools(campaignWithClient()).map((tool) => tool.name)).toEqual([
      'get_capiro_record',
      'get_recent_activity',
      'search_targets',
    ]);
  });

  it('rejects a provider request for an unapproved capability before registry execution', async () => {
    const h = harness();
    await expect(
      h.service.executeReadTool(
        h.service.capabilityContext(ctx, campaign().sessionId, campaign()),
        campaign(),
        'search_memory',
        {},
      ),
    ).rejects.toMatchObject({ code: 'OUTREACH_REASONING_TOOL_NOT_ALLOWED' });
    expect(h.capabilities.execute).not.toHaveBeenCalled();
  });

  it('injects canonical criteria, selected targets and rejected recommendations into target search', async () => {
    const spec = createBlankCampaignSpecV1();
    spec.targeting.criteria = {
      notes: 'HASC targets',
      governmentLevels: ['federal'],
      chambers: ['house'],
      committees: ['Armed Services'],
      agencies: [],
      states: ['VA'],
      relationshipPreference: 'mixed',
      includeStaff: true,
      includePrincipals: true,
    };
    const h = harness();
    await h.service.executeReadTool(
      h.service.capabilityContext(ctx, campaign(spec).sessionId, campaign(spec)),
      campaign(spec),
      'search_targets',
      { query: 'autonomy', clientId: null, sources: [], limit: 12 },
    );
    expect(h.capabilities.execute).toHaveBeenCalledWith(
      'search_targets',
      expect.any(Object),
      expect.objectContaining({
        query: 'autonomy',
        limit: 12,
        criteria: expect.objectContaining({ committees: ['Armed Services'], states: ['VA'] }),
        excludeTargetKeys: [],
        rejectedRecommendationRefs: [],
      }),
    );
  });

  it('keeps sponsor context tools constrained to sponsor clients', async () => {
    const h = harness();
    await expect(
      h.service.executeReadTool(
        h.service.capabilityContext(ctx, campaignWithClient().sessionId, campaignWithClient()),
        campaignWithClient(),
        'get_client_context',
        { clientId: '00000000-0000-4000-8000-000000000099' },
      ),
    ).rejects.toMatchObject({ code: 'OUTREACH_REASONING_TOOL_NOT_ALLOWED' });
  });

  describe('buildInstructions command catalog (OUTREACH_REASONING_OUTPUT_INVALID root-cause fix)', () => {
    it('gives the model an exact payload-key template for every strategy command, and never phaseOwner', () => {
      const h = harness();
      const instructions = h.service.buildInstructions(ctx, campaign());

      const catalogLine = instructions
        .split('\n')
        .find((line) => line.startsWith('Implemented proposal command catalog:'));
      expect(catalogLine).toBeDefined();
      const catalog = JSON.parse(
        catalogLine!.replace('Implemented proposal command catalog: ', '').replace(/\.$/, ''),
      ) as Array<{ type: string; schemaVersion: number; examplePayload?: Record<string, unknown> }>;

      const byType = new Map(catalog.map((entry) => [entry.type, entry]));
      expect(byType.get('SET_CAMPAIGN_ANGLE')?.examplePayload).toEqual({ value: expect.any(String) });
      expect(byType.get('SET_TONE')?.examplePayload).toEqual({ value: expect.any(String) });
      expect(byType.get('SET_LENGTH')?.examplePayload).toEqual({
        value: expect.any(String),
        customInstruction: null,
      });

      // phaseOwner is internal registry metadata that production output showed
      // the model echoing back as a stray top-level key on emitted commands.
      // It must not appear as an actual field on any catalog entry (the
      // instructions separately name it once, by way of telling the model not
      // to emit it -- that mention is intentional and checked below).
      for (const entry of catalog) {
        expect(entry).not.toHaveProperty('phaseOwner');
      }
      expect(instructions).toContain('catalog metadata such as "phaseOwner" is not part of the command you emit');

      // ADD_STYLE_SAMPLES / REMOVE_STYLE_SAMPLES are implemented but
      // user-authored-only -- OutreachReasoningService rejects any model
      // proposal of them, so they must not appear as if proposable.
      expect(byType.has('ADD_STYLE_SAMPLES')).toBe(false);
      expect(byType.has('REMOVE_STYLE_SAMPLES')).toBe(false);
    });

    it('explains the exact three-key command envelope so the model does not flatten payload fields', () => {
      const h = harness();
      const instructions = h.service.buildInstructions(ctx, campaign());

      expect(instructions).toContain(
        'Every proposed command is a JSON object with EXACTLY three top-level keys',
      );
      expect(instructions).toContain('SET_LENGTH payload.value must be exactly one of');
    });
  });

  it('collapses capability denials to a safe tool failure without leaking record identity', async () => {
    const h = harness();
    h.capabilities.execute.mockRejectedValueOnce(new Error('ethical wall client=secret-id'));

    await expect(
      h.service.executeReadTool(
        h.service.capabilityContext(ctx, campaignWithClient().sessionId, campaignWithClient()),
        campaignWithClient(),
        'get_client_context',
        { clientId: '00000000-0000-4000-8000-000000000030' },
      ),
    ).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_TOOL_FAILED',
      safeMetadata: { capability: 'get_client_context' },
    });
  });
});
