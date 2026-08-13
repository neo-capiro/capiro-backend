import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DirectoryService } from '../../directory/directory.service.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import { CapabilityError } from '../capability-errors.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import {
  createResolvedTargetRefV1,
  emailStatusFor,
  normalizeResolvedTargetRefsV1,
  normalizeTargetLocatorV1,
  type OutreachResolvedTargetRefV1,
  type OutreachTargetLocatorV1,
} from './outreach-target.contract.js';

@Injectable()
export class OutreachTargetReferenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  async resolveMany(
    ctx: TenantContext,
    locators: readonly unknown[],
  ): Promise<OutreachResolvedTargetRefV1[]> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.resolveManyWithinTx(tx, ctx, locators),
    );
  }

  async resolveManyWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    rawLocators: readonly unknown[],
  ): Promise<OutreachResolvedTargetRefV1[]> {
    const locators = rawLocators.map(normalizeTargetLocatorV1);
    const resolved: OutreachResolvedTargetRefV1[] = [];
    for (const locator of locators) {
      resolved.push(await this.resolveOneWithinTx(tx, ctx, locator));
    }
    return normalizeResolvedTargetRefsV1(resolved);
  }

  async reauthorizeSnapshotsWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    snapshots: readonly OutreachResolvedTargetRefV1[],
  ): Promise<void> {
    for (const snapshot of snapshots) {
      await this.resolveOneWithinTx(tx, ctx, snapshot.locator);
    }
  }

  async resolveOne(
    ctx: TenantContext,
    rawLocator: unknown,
  ): Promise<OutreachResolvedTargetRefV1> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.resolveOneWithinTx(tx, ctx, normalizeTargetLocatorV1(rawLocator)),
    );
  }

  async resolveOneWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: OutreachTargetLocatorV1,
  ): Promise<OutreachResolvedTargetRefV1> {
    switch (locator.source) {
      case 'directory_member':
        return this.resolveDirectoryMember(locator);
      case 'directory_staff':
        return this.resolveDirectoryStaff(locator);
      case 'state_legislator':
        return this.resolveStateLegislator(tx, locator);
      case 'client_person':
        return this.resolveClientPerson(tx, ctx, locator);
      case 'engagement_contact':
        return this.resolveEngagementContact(tx, ctx, locator);
      case 'manual':
        return createResolvedTargetRefV1({
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
          emailStatus: emailStatusFor(locator.email),
          profileStatus: 'limited',
          sourceSnapshot: {
            system: 'user_supplied',
            version: null,
            lastVerifiedAt: null,
          },
        });
    }
  }

  private async resolveDirectoryMember(
    locator: Extract<OutreachTargetLocatorV1, { source: 'directory_member' }>,
  ): Promise<OutreachResolvedTargetRefV1> {
    let detail;
    let contact;
    try {
      [detail, contact] = await Promise.all([
        this.directory.getMemberDetail(locator.id),
        this.directory
          .getAllContacts()
          .then((contacts) => contacts.find((entry) => entry.id === locator.id) ?? null),
      ]);
    } catch {
      throw targetNotFound();
    }
    if (!contact) throw targetNotFound();
    const currentOffice = detail.offices.find((office) => office.endDate === null) ?? detail.offices[0];
    const email = normalizeEmail(contact.email || emailContactMethod(detail.socialContacts));
    return createResolvedTargetRefV1({
      locator,
      displayName: contact.fullName || contact.memberName,
      email,
      phone: contact.phone || null,
      title: contact.title || currentOffice?.name || null,
      organization: currentOffice?.name || contact.office || null,
      clientId: null,
      jurisdiction: {
        governmentLevel: 'federal',
        chamber: contact.chamber,
        state: contact.state || null,
        district: contact.district || null,
        committees: contact.committees ?? [],
        issueAreas: contact.focusAreas ?? [],
      },
      roleStatus: contact.outgoingStatus || currentOffice?.endDate ? 'historical' : 'current',
      emailStatus: emailStatusFor(email),
      profileStatus: 'complete',
      sourceSnapshot: {
        system: 'capiro_directory',
        version: detail.source.snapshotId,
        lastVerifiedAt: detail.source.lastUpdatedAt,
      },
    });
  }

  private async resolveDirectoryStaff(
    locator: Extract<OutreachTargetLocatorV1, { source: 'directory_staff' }>,
  ): Promise<OutreachResolvedTargetRefV1> {
    let detail;
    try {
      detail = await this.directory.getStaffDetail(locator.id);
    } catch {
      throw targetNotFound();
    }
    const current = detail.positions.find((position) => position.isCurrent) ?? detail.positions[0];
    const displayName = [
      detail.identity.preferredFirstName ?? detail.identity.firstName,
      detail.identity.preferredLastName ?? detail.identity.lastName,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!displayName) throw targetNotFound();
    const email = normalizeEmail(emailContactMethod(detail.emails));
    return createResolvedTargetRefV1({
      locator,
      displayName,
      email,
      phone: detail.officeAddresses.find((address) => address.isMain)?.phone ?? null,
      title: current?.title ?? current?.positionType ?? null,
      organization: current?.officeName ?? current?.member?.fullName ?? null,
      clientId: null,
      jurisdiction: {
        governmentLevel: 'federal',
        chamber: chamberFromOffice(current?.officeName ?? null),
        state: current?.member?.state ?? null,
        district: current?.member?.district ?? null,
        committees: await Promise.all(
          detail.committeeAssociations.map(async (membership) => {
            try {
              const committee = await this.directory.getCommitteeDetail(membership.committeeId);
              return committee.name;
            } catch {
              return membership.committeeId;
            }
          }),
        ),
        issueAreas: detail.issues
          .map((entry) => entry.issueName)
          .filter((value): value is string => Boolean(value)),
      },
      roleStatus: current?.isCurrent ? 'current' : current ? 'historical' : 'unknown',
      emailStatus: emailStatusFor(email),
      profileStatus:
        detail.positions.length || detail.committeeAssociations.length ? 'complete' : 'limited',
      sourceSnapshot: {
        system: 'capiro_directory',
        version: detail.source.snapshotId,
        lastVerifiedAt: detail.source.lastUpdatedAt,
      },
    });
  }

  private async resolveStateLegislator(
    tx: Prisma.TransactionClient,
    locator: Extract<OutreachTargetLocatorV1, { source: 'state_legislator' }>,
  ): Promise<OutreachResolvedTargetRefV1> {
    const row = await tx.stateLegislator.findUnique({
      where: { id: locator.id },
      select: {
        id: true,
        name: true,
        state: true,
        chamber: true,
        district: true,
        committees: true,
        email: true,
        active: true,
        syncedAt: true,
      },
    });
    if (!row) throw targetNotFound();
    const committeeNames = Array.isArray(row.committees)
      ? row.committees
          .map((entry) =>
            entry && typeof entry === 'object' && 'name' in entry
              ? String((entry as { name?: unknown }).name ?? '').trim()
              : '',
          )
          .filter(Boolean)
      : [];
    const email = normalizeEmail(row.email);
    return createResolvedTargetRefV1({
      locator,
      displayName: row.name,
      email,
      phone: null,
      title: `${row.state} ${row.chamber ?? ''} legislator`.trim(),
      organization: null,
      clientId: null,
      jurisdiction: {
        governmentLevel: 'state',
        chamber: row.chamber,
        state: row.state,
        district: row.district,
        committees: committeeNames,
        issueAreas: [],
      },
      roleStatus: row.active ? 'current' : 'historical',
      emailStatus: emailStatusFor(email),
      profileStatus: 'limited',
      sourceSnapshot: {
        system: 'openstates',
        version: row.syncedAt.toISOString(),
        lastVerifiedAt: row.syncedAt.toISOString(),
      },
    });
  }

  private async resolveClientPerson(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: Extract<OutreachTargetLocatorV1, { source: 'client_person' }>,
  ): Promise<OutreachResolvedTargetRefV1> {
    await this.authorizeClient(tx, ctx, locator.clientId);
    const row = await tx.clientPerson.findFirst({
      where: { id: locator.id, tenantId: ctx.tenantId, clientId: locator.clientId },
      select: {
        id: true,
        clientId: true,
        name: true,
        title: true,
        email: true,
        phone: true,
        role: true,
        updatedAt: true,
      },
    });
    if (!row) throw targetNotFound();
    const email = normalizeEmail(row.email);
    return createResolvedTargetRefV1({
      locator,
      displayName: row.name,
      email,
      phone: row.phone,
      title: row.title ?? row.role,
      organization: null,
      clientId: row.clientId,
      jurisdiction: {
        governmentLevel: 'corporate',
        chamber: null,
        state: null,
        district: null,
        committees: [],
        issueAreas: [],
      },
      roleStatus: 'unknown',
      emailStatus: emailStatusFor(email),
      profileStatus: 'limited',
      sourceSnapshot: {
        system: 'capiro_client_person',
        version: row.updatedAt.toISOString(),
        lastVerifiedAt: row.updatedAt.toISOString(),
      },
    });
  }

  private async resolveEngagementContact(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    locator: Extract<OutreachTargetLocatorV1, { source: 'engagement_contact' }>,
  ): Promise<OutreachResolvedTargetRefV1> {
    const row = await tx.engagementContact.findFirst({
      where: { id: locator.id, tenantId: ctx.tenantId },
      select: {
        id: true,
        clientId: true,
        directoryEntryId: true,
        fullName: true,
        email: true,
        phone: true,
        title: true,
        organization: true,
        updatedAt: true,
      },
    });
    if (!row || (locator.clientId !== null && row.clientId !== locator.clientId)) {
      throw targetNotFound();
    }
    if (row.clientId) await this.authorizeClient(tx, ctx, row.clientId);
    const email = normalizeEmail(row.email);
    return createResolvedTargetRefV1({
      locator: { ...locator, clientId: row.clientId },
      displayName: row.fullName || email || 'Unnamed contact',
      email,
      phone: row.phone,
      title: row.title,
      organization: row.organization,
      clientId: row.clientId,
      jurisdiction: {
        governmentLevel: 'unknown',
        chamber: null,
        state: null,
        district: null,
        committees: [],
        issueAreas: [],
      },
      roleStatus: 'unknown',
      emailStatus: emailStatusFor(email),
      profileStatus: row.directoryEntryId ? 'complete' : 'limited',
      sourceSnapshot: {
        system: 'capiro_engagement_contact',
        version: row.updatedAt.toISOString(),
        lastVerifiedAt: row.updatedAt.toISOString(),
      },
    });
  }

  private async authorizeClient(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
  ): Promise<void> {
    const capabilityCtx: AuthorizedCapabilityContext = {
      actorUserId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      role: ctx.role,
      clientScope: null,
      impersonation: null,
      requestId: `outreach-target:${clientId}`,
      surface: 'outreach',
    };
    try {
      await this.authorization.authorizeClientWithinTx(tx, capabilityCtx, clientId);
    } catch (error) {
      if (error instanceof CapabilityError) {
        throw new CapabilityError(
          'CAPABILITY_UNAUTHORIZED',
          'The requested target could not be resolved in the authorized scope.',
        );
      }
      throw error;
    }
  }
}

function targetNotFound(): CapabilityError {
  return new CapabilityError('CAPABILITY_NOT_FOUND', 'The requested target was not found.');
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized.includes('@') ? normalized : null;
}

function emailContactMethod(
  methods: Array<{ type: string | null; value: string }>,
): string | null {
  return (
    methods.find((method) => method.type?.toLowerCase().includes('email'))?.value ??
    methods.find((method) => method.value.includes('@'))?.value ??
    null
  );
}

function chamberFromOffice(office: string | null): string | null {
  const value = office?.toLowerCase() ?? '';
  if (value.includes('senate')) return 'Senate';
  if (value.includes('house')) return 'House';
  return null;
}
