import type { TenantContext } from '@capiro/shared';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
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
    pendingProposalCount: 0,
  };
}

function harness(registered = ['get_capiro_record', 'get_client_context', 'get_recent_activity']) {
  const sessions = { getSession: jest.fn() };
  const capabilities = {
    listForSurface: jest.fn(() => registered.map((name) => ({ name }))),
    get: jest.fn((name: string) =>
      registered.includes(name)
        ? { name, surfaces: ['outreach'] }
        : undefined,
    ),
    execute: jest.fn(async (name: string, capabilityCtx: unknown, input: unknown) => ({
      capability: name,
      schemaVersion: 1,
      data: input,
      provenance: [],
      exclusions: [],
      scope: { tenantId: ctx.tenantId },
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
        { clientId: '00000000-0000-4000-8000-000000000020' },
        { clientId: '00000000-0000-4000-8000-000000000021' },
      ],
    };
    const h = harness();

    expect(h.service.capabilityContext(ctx, campaign(spec).sessionId, campaign(spec)).clientScope).toBeNull();
  });

  it('exposes only allowlisted capabilities that are actually registered for outreach', () => {
    const h = harness(['get_capiro_record', 'get_recent_activity']);
    expect(h.service.providerTools().map((tool) => tool.name)).toEqual([
      'get_capiro_record',
      'get_recent_activity',
    ]);
  });

  it('rejects a provider request for an unapproved capability before registry execution', async () => {
    const h = harness();
    await expect(
      h.service.executeReadTool(
        h.service.capabilityContext(ctx, campaign().sessionId, campaign()),
        'search_targets',
        {},
      ),
    ).rejects.toMatchObject({ code: 'OUTREACH_REASONING_TOOL_NOT_ALLOWED' });
    expect(h.capabilities.execute).not.toHaveBeenCalled();
  });

  it('collapses capability denials to a safe tool failure without leaking record identity', async () => {
    const h = harness();
    h.capabilities.execute.mockRejectedValueOnce(new Error('ethical wall client=secret-id'));

    await expect(
      h.service.executeReadTool(
        h.service.capabilityContext(ctx, campaign().sessionId, campaign()),
        'get_client_context',
        { clientId: '00000000-0000-4000-8000-000000000020' },
      ),
    ).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_TOOL_FAILED',
      safeMetadata: { capability: 'get_client_context' },
    });
  });
});
