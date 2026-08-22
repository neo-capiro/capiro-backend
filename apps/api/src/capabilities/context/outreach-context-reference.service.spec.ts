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
  attachment: ReturnType<typeof attachmentRow> | null;
  scanRequired?: boolean;
  meeting?: { id: string } | null;
}) {
  const findFirstAttachment = jest.fn(async (args: { where: Record<string, unknown> }) => {
    if (!options.attachment) return null;
    return matchesWhere(options.attachment, args.where) ? options.attachment : null;
  });
  const findFirstMeeting = jest.fn(async () => options.meeting ?? null);
  const tx = {
    engagementAttachment: { findFirst: findFirstAttachment },
    meeting: { findFirst: findFirstMeeting },
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
  const targetReferences = {} as unknown as OutreachTargetReferenceService;
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

  return { service, tx, findFirstAttachment, findFirstMeeting, authorizeClientWithinTx };
}

function documentSelection(clientId: string | null): OutreachContextSelectionV1 {
  return {
    locator: { source: 'document', id: attachmentId, clientId },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
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
