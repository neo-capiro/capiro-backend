import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { CapabilityError } from '../capability-errors.js';
import type { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { OutreachTargetReferenceService } from '../targets/outreach-target-reference.service.js';
import { AttachmentContentService } from '../../engagement/attachment-content.service.js';
import type { AttachmentScannerService } from '../../engagement/attachment-scanner.service.js';
import type { OutreachContextSelectionV1 } from './outreach-context.contract.js';
import { OutreachContextReferenceService } from './outreach-context-reference.service.js';

// Regression coverage for the production bug reproduced live on
// os.capiro.ai (L3 Harris "Request to meet" campaign,
// session 3b677b84-a53b-4b31-bdd8-810c95609ed4): accepting a CLIENT DOCUMENT
// candidate the UI itself offered as valid for the session failed with
// 403 OUTREACH_REFERENCE_UNAUTHORIZED.
//
// Root cause confirmed against the live capiro-dev database: the attachment
// (id 28d5a267-0b3c-4f16-af62-880cf2b3f79f, "Capiro 2.0.pdf") had
// lifecycle_status='quarantined' with scan_status='scanner_not_required' /
// scan_provider='none' (no scanner configured in this environment — the
// deployment default). `resolveDocument` gated on a hand-rolled
// `lifecycleStatus IN ('ready', 'legacy_ready')` allowlist that excluded
// 'quarantined' unconditionally, even though the centralized readiness
// policy (AttachmentContentService.readiness, the same gate the outreach
// SEND path uses) correctly treats a quarantined-but-unscanned row as usable
// when scanning isn't required. The clientId/tenant comparison itself was
// never wrong — the row was simply never fetched, so the resulting
// CAPABILITY_NOT_FOUND got relabeled OUTREACH_REFERENCE_UNAUTHORIZED by the
// command engine's catch-all.

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const ctx: TenantContext = {
  tenantId,
  tenantSlug: 'test',
  userId,
  clerkUserId: 'user_test',
  role: 'standard_user',
};

const authorizedClientId = '0e042626-ecde-44b3-88f1-9c2aed31d910';
const otherClientId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '28d5a267-0b3c-4f16-af62-880cf2b3f79f';

/** The exact row shape resolveDocument selects, matching the live production row. */
function attachmentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: attachmentId,
    prospectId: null,
    tenantId,
    supersededByAttachmentId: null,
    clientId: authorizedClientId,
    meetingId: null,
    fileName: 'Capiro 2.0.pdf',
    contentType: 'application/pdf',
    source: 'manual',
    sourceEntityType: null,
    sourceEntityId: null,
    calculatedSha256: 'deadbeef',
    indexedAt: new Date('2026-08-19T16:23:08.184Z'),
    extractionStatus: 'pending',
    approvedAt: null,
    sharedAt: null,
    createdAt: new Date('2026-08-19T16:23:01.358Z'),
    lifecycleStatus: 'quarantined',
    scanStatus: 'scanner_not_required',
    ...overrides,
  };
}

/**
 * Minimal stand-in for Prisma's `findFirst` filtering, so this test exercises
 * the actual `where` clause resolveDocument sends — not just the in-memory
 * readiness check after the row comes back. Without this, reintroducing the
 * old `lifecycleStatus: { in: ['ready', 'legacy_ready'] }` filter (the actual
 * production bug) would leave every test here green, since a naive mock that
 * ignores `where` entirely ~would~ hand back the fixture regardless of what
 * the query asked for.
 */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && 'in' in condition) {
      return (condition as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === condition;
  });
}

function harness(options: {
  attachment?: ReturnType<typeof attachmentRow> | null;
  scanRequired?: boolean;
  meeting?: { id: string } | null;
  clientCapability?: Record<string, unknown> | null;
  clientFacility?: Record<string, unknown> | null;
  resolvedTarget?: Record<string, unknown> | null;
  federalAward?: Record<string, unknown> | null;
}) {
  const findFirstAttachment = jest.fn(async (args: { where: Record<string, unknown> }) => {
    if (!options.attachment) return null;
    return matchesWhere(options.attachment, args.where) ? options.attachment : null;
  });
  const findFirstMeeting = jest.fn(async () => options.meeting ?? null);
  const findFirstClientCapability = jest.fn(async (args: { where: Record<string, unknown> }) => {
    if (!options.clientCapability) return null;
    return matchesWhere(options.clientCapability, args.where) ? options.clientCapability : null;
  });
  const findFirstClientFacility = jest.fn(async (args: { where: Record<string, unknown> }) => {
    if (!options.clientFacility) return null;
    return matchesWhere(options.clientFacility, args.where) ? options.clientFacility : null;
  });
  const tx = {
    engagementAttachment: { findFirst: findFirstAttachment },
    meeting: { findFirst: findFirstMeeting },
    clientCapability: { findFirst: findFirstClientCapability },
    clientFacility: { findFirst: findFirstClientFacility },
    federalAward: { findUnique: jest.fn(async () => options.federalAward ?? null) },
  } as unknown as Prisma.TransactionClient;

  const authorizeClientWithinTx = jest.fn(async (_tx: unknown, _c: unknown, clientId: string) => ({
    id: clientId,
    name: 'Client',
    website: null,
    description: null,
    sectorTag: null,
    status: 'active',
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  }));
  const authorization = { authorizeClientWithinTx } as unknown as CapabilityAuthorizationService;
  const resolveOneWithinTx = jest.fn(async () => {
    if (!options.resolvedTarget) throw new CapabilityError('CAPABILITY_NOT_FOUND', 'Target not found.');
    return options.resolvedTarget;
  });
  const targetReferences = { resolveOneWithinTx } as unknown as OutreachTargetReferenceService;
  const attachmentContent = new AttachmentContentService();
  const attachmentScanner = {
    scanRequired: options.scanRequired ?? false,
  } as unknown as AttachmentScannerService;

  const service = new OutreachContextReferenceService(
    // prisma is unused by resolveOneWithinTx — callers pass their own tx.
    {} as never,
    authorization,
    targetReferences,
    attachmentContent,
    attachmentScanner,
  );

  return {
    service,
    tx,
    findFirstAttachment,
    findFirstMeeting,
    findFirstClientCapability,
    findFirstClientFacility,
    authorizeClientWithinTx,
    resolveOneWithinTx,
  };
}

function documentSelection(clientId: string | null): OutreachContextSelectionV1 {
  return {
    locator: { source: 'document', id: attachmentId, clientId },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
  };
}

const capabilityId = 'a1a1a1a1-0000-4000-8000-000000000001';
const facilityId = 'b2b2b2b2-0000-4000-8000-000000000002';

function capabilityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: capabilityId,
    tenantId,
    clientId: authorizedClientId,
    name: 'Autonomy Kit — Ground Robotics',
    type: 'product',
    description: 'Modular autonomy retrofit for tracked ground vehicles.',
    sector: 'Defense',
    serviceBranch: 'Army',
    keywords: ['autonomy', 'ground robotics'],
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function facilityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: facilityId,
    tenantId,
    clientId: authorizedClientId,
    name: 'Huntsville Plant',
    addressLine: '100 Rocket Rd',
    city: 'Huntsville',
    state: 'AL',
    zip: '35806',
    congressionalDistrict: '05',
    employeeCount: 240,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function capabilitySelection(clientId: string): OutreachContextSelectionV1 {
  return {
    locator: { source: 'capiro_record', recordType: 'client_capability', id: capabilityId, clientId },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
  };
}

function facilitySelection(clientId: string): OutreachContextSelectionV1 {
  return {
    locator: { source: 'capiro_record', recordType: 'client_facility', id: facilityId, clientId },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
  };
}

const targetKey = 'target:directory_staff:staff-9001';

function careerBackgroundSelection(): OutreachContextSelectionV1 {
  return {
    locator: {
      source: 'target_profile_fact',
      targetRef: { source: 'directory_staff', id: 'staff-9001' },
      factCode: 'career_background',
    },
    contextClass: 'target_specific',
    scope: { kind: 'target', targetKey },
  };
}

function resolvedTargetFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    targetKey,
    locator: { source: 'directory_staff', id: 'staff-9001' },
    displayName: 'Jordan Rivera',
    clientId: null,
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'house',
      state: 'AL',
      district: '05',
      committees: [],
      issueAreas: [],
    },
    roleStatus: 'current',
    sourceSnapshot: { system: 'capiro_directory', version: 'v1', lastVerifiedAt: '2026-08-01' },
    ...overrides,
  };
}

describe('OutreachContextReferenceService — document locator authorization', () => {
  it('accepts a client document belonging to the authorized client, even when quarantined with no scanner configured', async () => {
    const { service, tx } = harness({
      attachment: attachmentRow(), // lifecycleStatus: 'quarantined', scanRequired: false (default)
    });

    const resolved = await service.resolveOneWithinTx(tx, ctx, documentSelection(authorizedClientId));

    expect(resolved.title).toBe('Capiro 2.0.pdf');
    expect(resolved.clientId).toBe(authorizedClientId);
    expect(resolved.locator).toEqual({
      source: 'document',
      id: attachmentId,
      clientId: authorizedClientId,
    });
  });

  it('still rejects a document belonging to a DIFFERENT client — this must keep failing', async () => {
    const { service, tx, authorizeClientWithinTx } = harness({
      // The stored row genuinely belongs to a different client than the one
      // the caller's locator claims.
      attachment: attachmentRow({ clientId: otherClientId }),
    });

    await expect(
      service.resolveOneWithinTx(tx, ctx, documentSelection(authorizedClientId)),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_FOUND' });
    // Cross-client mismatch must short-circuit before any client authorization
    // call — a wrong-client document is never even auth-checked, let alone served.
    expect(authorizeClientWithinTx).not.toHaveBeenCalled();
  });

  it('"All Clients" (a null-clientId locator) does not bypass tenant/client isolation for a client-owned document', async () => {
    const { service, tx, authorizeClientWithinTx } = harness({
      // The document is genuinely owned by a specific client...
      attachment: attachmentRow({ clientId: authorizedClientId }),
    });

    // ...but the selection was built as if no specific client were chosen
    // (the "All Clients" case), so the locator carries clientId: null.
    await expect(
      service.resolveOneWithinTx(tx, ctx, documentSelection(null)),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(authorizeClientWithinTx).not.toHaveBeenCalled();
  });

  it('still rejects a lifecycle-blocked document even though the client and scan state would otherwise match', async () => {
    const { service, tx } = harness({
      attachment: attachmentRow({ lifecycleStatus: 'blocked' }),
    });

    await expect(
      service.resolveOneWithinTx(tx, ctx, documentSelection(authorizedClientId)),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('still rejects a scan-pending document when this deployment requires scanning', async () => {
    const { service, tx } = harness({
      attachment: attachmentRow({ scanStatus: 'pending' }),
      scanRequired: true,
    });

    await expect(
      service.resolveOneWithinTx(tx, ctx, documentSelection(authorizedClientId)),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects when the attachment does not exist at all', async () => {
    const { service, tx } = harness({ attachment: null });

    await expect(
      service.resolveOneWithinTx(tx, ctx, documentSelection(authorizedClientId)),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

// Request-a-meeting context enrichment: sponsor capabilities/locations
// surface as real capiro_record Sources, same authorization/isolation
// pattern as the existing client/meeting/engagement_task branches above.
describe('OutreachContextReferenceService — capiro_record client capability', () => {
  it('resolves a capability belonging to the authorized client', async () => {
    const { service, tx } = harness({ clientCapability: capabilityRow() });

    const resolved = await service.resolveOneWithinTx(
      tx,
      ctx,
      capabilitySelection(authorizedClientId),
    );

    expect(resolved.title).toBe('Autonomy Kit — Ground Robotics');
    expect(resolved.summary).toContain('Modular autonomy retrofit');
    expect(resolved.summary).toContain('Sector: Defense');
    expect(resolved.summary).toContain('Service branch: Army');
    expect(resolved.summary).toContain('Keywords: autonomy, ground robotics');
    expect(resolved.clientId).toBe(authorizedClientId);
  });

  it('rejects a capability belonging to a DIFFERENT client', async () => {
    const { service, tx, authorizeClientWithinTx } = harness({
      clientCapability: capabilityRow({ clientId: otherClientId }),
    });

    await expect(
      service.resolveOneWithinTx(tx, ctx, capabilitySelection(authorizedClientId)),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_FOUND' });
    expect(authorizeClientWithinTx).not.toHaveBeenCalled();
  });

  it('rejects when the capability does not exist at all', async () => {
    const { service, tx } = harness({ clientCapability: null });

    await expect(
      service.resolveOneWithinTx(tx, ctx, capabilitySelection(authorizedClientId)),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('OutreachContextReferenceService — capiro_record client facility', () => {
  it('resolves a facility belonging to the authorized client', async () => {
    const { service, tx } = harness({ clientFacility: facilityRow() });

    const resolved = await service.resolveOneWithinTx(tx, ctx, facilitySelection(authorizedClientId));

    expect(resolved.title).toBe('Huntsville Plant');
    expect(resolved.summary).toContain('100 Rocket Rd');
    expect(resolved.summary).toContain('Huntsville, AL 35806');
    expect(resolved.summary).toContain('Congressional district: 05');
    expect(resolved.summary).toContain('Employees: 240');
    expect(resolved.clientId).toBe(authorizedClientId);
  });

  it('rejects a facility belonging to a DIFFERENT client', async () => {
    const { service, tx, authorizeClientWithinTx } = harness({
      clientFacility: facilityRow({ clientId: otherClientId }),
    });

    await expect(
      service.resolveOneWithinTx(tx, ctx, facilitySelection(authorizedClientId)),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_FOUND' });
    expect(authorizeClientWithinTx).not.toHaveBeenCalled();
  });

  it('rejects when the facility does not exist at all', async () => {
    const { service, tx } = harness({ clientFacility: null });

    await expect(
      service.resolveOneWithinTx(tx, ctx, facilitySelection(authorizedClientId)),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('OutreachContextReferenceService — target_profile_fact career_background', () => {
  it('builds one fact from whichever career-background fields a member/staffer has', async () => {
    const { service, tx } = harness({
      resolvedTarget: resolvedTargetFixture({
        careerBackground: { hometown: 'Huntsville, AL', occupation: 'Legislative aide', education: null, military: null },
      }),
    });

    const resolved = await service.resolveOneWithinTx(tx, ctx, careerBackgroundSelection());

    expect(resolved.title).toBe('Jordan Rivera — career background');
    expect(resolved.summary).toContain('Hometown: Huntsville, AL');
    expect(resolved.summary).toContain('Occupation: Legislative aide');
    // A staffer's fact never carries these — Capiro has no such source for staff.
    expect(resolved.summary).not.toContain('Education:');
    expect(resolved.summary).not.toContain('Military');
  });

  it('includes education/military when the resolved target carries them (members only)', async () => {
    const { service, tx } = harness({
      resolvedTarget: resolvedTargetFixture({
        displayName: 'Rep. Robert Aderholt',
        careerBackground: {
          hometown: 'Haleyville, AL',
          occupation: 'Attorney',
          education: 'University of Alabama (BA); Cumberland School of Law (JD)',
          military: 'U.S. Army Reserve',
        },
      }),
    });

    const resolved = await service.resolveOneWithinTx(tx, ctx, careerBackgroundSelection());

    expect(resolved.summary).toContain('Education: University of Alabama');
    expect(resolved.summary).toContain('Military service: U.S. Army Reserve');
  });

  it('rejects (contextNotFound) when the target has no career background at all', async () => {
    const { service, tx } = harness({
      resolvedTarget: resolvedTargetFixture({ careerBackground: null }),
    });

    await expect(
      service.resolveOneWithinTx(tx, ctx, careerBackgroundSelection()),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects (contextNotFound) for a target type with no career background field at all — e.g. a state legislator', async () => {
    const { service, tx } = harness({
      // resolvedTargetFixture never sets careerBackground unless asked to —
      // this is exactly what resolveOneWithinTx returns for a state legislator.
      resolvedTarget: resolvedTargetFixture(),
    });

    await expect(
      service.resolveOneWithinTx(tx, ctx, careerBackgroundSelection()),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('OutreachContextReferenceService — award-date rollout', () => {
  const selection: OutreachContextSelectionV1 = {
    locator: { source: 'government_record', category: 'award', id: 'award-1' },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
  };
  const award = {
    contractorName: 'Acme Defense',
    awardingAgency: 'Department of Defense',
    awardedAt: new Date('2026-03-01T00:00:00Z'),
    baseAwardSignedDate: new Date('2026-02-15T00:00:00Z'),
    latestActionDate: new Date('2026-03-01T00:00:00Z'),
  };

  it('preserves the exact legacy summary when off', async () => {
    const { service, tx } = harness({ federalAward: award });
    const resolved = await service.resolveOneWithinTx(tx, ctx, selection);
    expect(resolved.summary).toBe('Department of Defense\n2026-03-01');
  });

  it('uses and labels the base signed date when outreach enforcement is enabled', async () => {
    const keys = ['MERI_EVIDENCE_ACCURACY_MODE', 'MERI_EVIDENCE_ACCURACY_TENANTS', 'MERI_EVIDENCE_ACCURACY_SURFACES'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: tenantId,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'outreach',
    });
    try {
      const { service, tx } = harness({ federalAward: award });
      const resolved = await service.resolveOneWithinTx(tx, ctx, selection);
      expect(resolved.summary).toBe('Department of Defense\nBase award signed: 2026-02-15');
      expect(resolved.sourceSnapshot.lastVerifiedAt).toBe('2026-02-15T00:00:00.000Z');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
