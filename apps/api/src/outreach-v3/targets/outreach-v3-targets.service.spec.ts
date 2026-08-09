import type { TenantContext } from '@capiro/shared';
import {
  createManualTargetLocator,
  createResolvedTargetRefV1,
} from '../../capabilities/targets/outreach-target.contract.js';
import { createBlankCampaignSpecV1, hashCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachTargetCoverageService } from './outreach-target-coverage.service.js';
import { OutreachV3TargetsService } from './outreach-v3-targets.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'test',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
} as TenantContext;

const sessionId = '00000000-0000-4000-8000-000000000010';
const locator = createManualTargetLocator({
  id: '00000000-0000-4000-8000-000000000020',
  name: 'Alex Example',
  email: 'alex@example.test',
  title: 'Policy Director',
});
const selected = createResolvedTargetRefV1({
  locator,
  displayName: locator.name,
  email: locator.email,
  phone: locator.phone,
  title: locator.title,
  organization: locator.organization,
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
  sourceSnapshot: { system: 'user_supplied', version: 'v1', lastVerifiedAt: null },
});
const current = createResolvedTargetRefV1({
  ...selected,
  locator,
  title: 'Senior Policy Director',
  sourceSnapshot: { system: 'user_supplied', version: 'v2', lastVerifiedAt: null },
});

function campaign() {
  const spec = createBlankCampaignSpecV1();
  spec.targeting.selectedTargetRefs = [selected];
  return {
    currentStateVersion: 4,
    specHash: hashCampaignSpecV1(spec),
    spec,
  };
}

function capabilityEnvelope(target = current) {
  return {
    capability: 'get_target_profile',
    schemaVersion: 1,
    data: {
      target,
      identity: { displayName: target.displayName, targetType: target.locator.source, clientId: null },
      role: { title: target.title, organization: target.organization, status: target.roleStatus },
      contact: { email: target.email, phone: target.phone, emailStatus: target.emailStatus },
      jurisdiction: target.jurisdiction,
      relationshipMetadata: { lastContactAt: null, notesAvailable: false, ownerLabel: null },
      personalizationFacts: [],
      warnings: [],
      restrictedCategories: [],
    },
    provenance: [],
    exclusions: [],
    scope: { tenantId: ctx.tenantId, clientId: null },
    freshness: { asOf: '2026-08-08T00:00:00.000Z', degraded: false, reasons: [] },
    authorization: { filtered: false, restrictedCount: 0 },
  };
}

function harness() {
  const sessions = { getSession: jest.fn(async () => campaign()) };
  const capabilities = {
    execute: jest.fn(async (name: string) =>
      name === 'get_target_profile'
        ? capabilityEnvelope()
        : {
            capability: name,
            schemaVersion: 1,
            data: {},
            provenance: [],
            exclusions: [],
            scope: { tenantId: ctx.tenantId, clientId: null },
            freshness: { asOf: '2026-08-08T00:00:00.000Z', degraded: false, reasons: [] },
            authorization: { filtered: false, restrictedCount: 0 },
          },
    ),
  };
  const targetReferences = { resolveOne: jest.fn(async () => current) };
  return {
    service: new OutreachV3TargetsService(
      sessions as never,
      capabilities as never,
      targetReferences as never,
      new OutreachTargetCoverageService(),
    ),
    sessions,
    capabilities,
    targetReferences,
  };
}

describe('OutreachV3TargetsService', () => {
  it('derives search criteria and exclusion state from the canonical Campaign Spec', async () => {
    const h = harness();
    await h.service.search(ctx, sessionId, {
      query: 'HASC',
      clientId: null,
      sources: ['directory_member'],
      limit: 10,
    });
    expect(h.capabilities.execute).toHaveBeenCalledWith(
      'search_targets',
      expect.objectContaining({ tenantId: ctx.tenantId, surface: 'outreach' }),
      expect.objectContaining({
        query: 'HASC',
        excludeTargetKeys: [selected.targetKey],
        rejectedRecommendationRefs: [],
      }),
    );
  });

  it('reports selected-profile snapshot drift without mutating Campaign Spec', async () => {
    const h = harness();
    const result = await h.service.getProfile(ctx, sessionId, { targetRef: locator });
    expect(result.selectionSnapshot).toMatchObject({
      status: 'changed',
      selectedSnapshotHash: selected.snapshotHash,
      currentSnapshotHash: current.snapshotHash,
      changedFields: ['sourceVersion', 'title'],
    });
    expect(campaign().spec.targeting.selectedTargetRefs[0]?.snapshotHash).toBe(selected.snapshotHash);
  });

  it('reports unavailable revalidation without leaking a provider error', async () => {
    const h = harness();
    h.targetReferences.resolveOne.mockRejectedValueOnce(new Error('secret directory error'));
    const result = await h.service.getCoverage(ctx, sessionId);
    expect(result.snapshotRevalidation).toEqual([
      {
        targetKey: selected.targetKey,
        status: 'unavailable',
        selectedSnapshotHash: selected.snapshotHash,
        currentSnapshotHash: null,
        changedFields: [],
        currentTarget: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret directory error');
  });
});
