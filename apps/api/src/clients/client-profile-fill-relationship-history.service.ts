import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AssociationEntityType } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement/engagement.service.js';
import {
  ownMailThreadWhere,
  ownMeetingWhere,
} from '../engagement/engagement-access.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { FillEvidence } from './client-profile-fill.helpers.js';

const MAX_RELATIONSHIP_CANDIDATES_PER_SOURCE = 250;
const GENERIC_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

export type ClientProfileRelationshipEntityType = 'meeting' | 'mail_thread';

export interface RelationshipHistoryFindingLike {
  id: string;
  kind: string;
  targetKey: string;
  source: string;
  currentValue: unknown;
  proposedValue: unknown;
}

export interface RelationshipHistoryAddFindingInput {
  kind: 'relationship_link';
  targetKey: string;
  source: 'synced_email';
  factKind: 'fact';
  currentValue: unknown;
  proposedValue: unknown;
  confidence: number;
  evidence: FillEvidence[];
}

export type RelationshipHistoryAddFinding = (
  tenantId: string,
  clientId: string,
  runId: string,
  input: RelationshipHistoryAddFindingInput,
) => Promise<boolean>;

export interface RelationshipHistoryKnownPerson {
  email?: string | null;
}

interface RelationshipCandidate {
  entityType: ClientProfileRelationshipEntityType;
  entityId: string;
  title: string;
  occurredAt: Date;
  emails: string[];
}

export interface RelationshipMatch {
  confidence: number;
  matchedEmails: string[];
  matchedDomains: string[];
  matchReason: 'known_client_contact' | 'official_company_domain' | 'multiple_company_domain_participants';
}

interface RelationshipLinkProposal {
  action: 'associate_to_client';
  entityType: ClientProfileRelationshipEntityType;
  entityId: string;
  title: string;
  occurredAt: string;
  matchedEmails: string[];
  matchedDomains: string[];
  matchReason: RelationshipMatch['matchReason'];
}

/**
 * Phase 4 relationship-history reconstruction.
 *
 * This specialist never copies message bodies, meeting descriptions, or source
 * records into a second CRM history table. It emits reviewable association
 * proposals for authoritative meeting/mail-thread rows. Once accepted, the
 * existing association-override path links the source record to the client, and
 * ClientActivityService projects it into Relationships > History.
 */
@Injectable()
export class ClientProfileFillRelationshipHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
  ) {}

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    knownPeople: readonly RelationshipHistoryKnownPerson[],
    addFinding: RelationshipHistoryAddFinding,
  ): Promise<number> {
    const snapshot = await this.loadSnapshot(ctx, clientId);
    const knownEmails = new Set<string>();
    for (const person of knownPeople) addNormalizedEmail(knownEmails, person.email);
    addNormalizedEmail(knownEmails, snapshot.client.primaryContactEmail);
    for (const contact of snapshot.contacts) addNormalizedEmail(knownEmails, contact.email);

    const officialDomain = normalizeWebsiteDomain(snapshot.client.website);
    const officialDomains = new Set<string>();
    if (officialDomain && !GENERIC_EMAIL_DOMAINS.has(officialDomain)) {
      officialDomains.add(officialDomain);
    }

    // Fail closed when there is no stable identity anchor. A company name by
    // itself is not enough to associate private mail or meetings.
    if (knownEmails.size === 0 && officialDomains.size === 0) return 0;

    const candidates: RelationshipCandidate[] = [
      ...snapshot.meetings.map((meeting) => ({
        entityType: 'meeting' as const,
        entityId: meeting.id,
        title: safeTitle(meeting.subject, 'Meeting'),
        occurredAt: meeting.startsAt,
        emails: uniqueEmails([
          meeting.organizerEmail,
          ...meeting.attendees.map((attendee) => attendee.email),
        ]),
      })),
      ...snapshot.threads.map((thread) => ({
        entityType: 'mail_thread' as const,
        entityId: thread.id,
        title: safeTitle(thread.subject, 'Email thread'),
        occurredAt: thread.lastMessageAt ?? thread.createdAt,
        emails: extractEmailsFromUnknown(thread.participants),
      })),
    ];

    let count = 0;
    for (const candidate of candidates) {
      const match = matchRelationshipCandidate(candidate.emails, knownEmails, officialDomains);
      if (!match) continue;
      const proposedValue: RelationshipLinkProposal = {
        action: 'associate_to_client',
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        title: candidate.title,
        occurredAt: candidate.occurredAt.toISOString(),
        matchedEmails: match.matchedEmails,
        matchedDomains: match.matchedDomains,
        matchReason: match.matchReason,
      };
      const inserted = await addFinding(ctx.tenantId, clientId, runId, {
        kind: 'relationship_link',
        targetKey: `relationship:${candidate.entityType}:${candidate.entityId}`,
        source: 'synced_email',
        factKind: 'fact',
        currentValue: { clientId: null },
        proposedValue,
        confidence: match.confidence,
        evidence: [
          {
            label:
              candidate.entityType === 'meeting'
                ? 'Meeting participants match the client relationship identity'
                : 'Email participants match the client relationship identity',
            source: candidate.entityType === 'meeting' ? 'Synced calendar metadata' : 'Synced email metadata',
            metadata: {
              entityType: candidate.entityType,
              entityId: candidate.entityId,
              occurredAt: candidate.occurredAt.toISOString(),
              matchedEmails: match.matchedEmails,
              matchedDomains: match.matchedDomains,
              matchReason: match.matchReason,
              // Deliberately no body, body preview, snippet, description, or transcript.
              association: 'review_required',
            },
          },
        ],
      });
      if (inserted) count += 1;
    }
    return count;
  }

  async apply(
    ctx: TenantContext,
    clientId: string,
    finding: RelationshipHistoryFindingLike,
  ): Promise<void> {
    const proposal = parseProposal(finding.proposedValue);
    const entityType =
      proposal.entityType === 'meeting'
        ? AssociationEntityType.meeting
        : AssociationEntityType.mail_thread;

    const source = await this.loadSourceForApply(ctx, proposal.entityType, proposal.entityId);
    if (source.clientId && source.clientId !== clientId) {
      throw new BadRequestException(
        'This relationship event is already associated with a different client. Refresh Fill with Meri before applying it.',
      );
    }

    if (source.clientId !== clientId) {
      await this.engagement.overrideAssociation(ctx, {
        entityType,
        entityId: proposal.entityId,
        clientId,
        reason: 'Fill with Meri relationship-history review',
      });
    }

    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: (ctx as unknown as { role?: string }).role ?? null,
          action: 'client_profile_fill.apply',
          entityType: 'client_profile_fill:relationship_link',
          entityId: clientId,
          before: {
            findingId: finding.id,
            sourceEntityType: proposal.entityType,
            sourceEntityId: proposal.entityId,
            clientId: source.clientId,
          } as any,
          after: {
            findingId: finding.id,
            targetKey: finding.targetKey,
            source: finding.source,
            sourceEntityType: proposal.entityType,
            sourceEntityId: proposal.entityId,
            clientId,
            deduplicated: source.clientId === clientId,
          } as any,
        },
      }),
    );
  }

  private async loadSnapshot(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const client = await tx.client.findFirst({
        where: {
          id: clientId,
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
          OR: [
            { memoryWall: false },
            { memoryAccessGrants: { some: { userId: ctx.userId } } },
          ],
        },
        select: {
          id: true,
          website: true,
          primaryContactEmail: true,
        },
      });
      if (!client) throw new NotFoundException('Client not found');

      const [contacts, meetings, threads] = await Promise.all([
        tx.engagementContact.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          select: { email: true },
          take: MAX_RELATIONSHIP_CANDIDATES_PER_SOURCE,
        }),
        tx.meeting.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId: null,
            isInternal: false,
            ...ownMeetingWhere(ctx.userId),
          },
          select: {
            id: true,
            subject: true,
            startsAt: true,
            organizerEmail: true,
            attendees: { select: { email: true } },
          },
          orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
          take: MAX_RELATIONSHIP_CANDIDATES_PER_SOURCE,
        }),
        tx.mailThread.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId: null,
            ...ownMailThreadWhere(ctx.userId),
          },
          select: {
            id: true,
            subject: true,
            participants: true,
            lastMessageAt: true,
            createdAt: true,
          },
          orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
          take: MAX_RELATIONSHIP_CANDIDATES_PER_SOURCE,
        }),
      ]);
      return { client, contacts, meetings, threads };
    });
  }

  private async loadSourceForApply(
    ctx: TenantContext,
    entityType: ClientProfileRelationshipEntityType,
    entityId: string,
  ): Promise<{ clientId: string | null }> {
    if (entityType === 'meeting') {
      const meeting = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.meeting.findFirst({
          where: {
            id: entityId,
            tenantId: ctx.tenantId,
            ...ownMeetingWhere(ctx.userId),
          },
          select: { clientId: true },
        }),
      );
      if (!meeting) throw new NotFoundException('Meeting is no longer available');
      return meeting;
    }

    const thread = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.mailThread.findFirst({
        where: {
          id: entityId,
          tenantId: ctx.tenantId,
          ...ownMailThreadWhere(ctx.userId),
        },
        select: { clientId: true },
      }),
    );
    if (!thread) throw new NotFoundException('Email thread is no longer available');
    return thread;
  }
}

export function matchRelationshipCandidate(
  candidateEmails: readonly string[],
  knownClientEmails: ReadonlySet<string>,
  officialDomains: ReadonlySet<string>,
): RelationshipMatch | null {
  const normalizedEmails = uniqueEmails(candidateEmails);
  const exactMatches = normalizedEmails.filter((email) => knownClientEmails.has(email));
  const domainMatches = normalizedEmails.filter((email) => {
    const domain = domainOfEmail(email);
    return !!domain && officialDomains.has(domain);
  });
  const matchedDomains = [...new Set(domainMatches.map(domainOfEmail).filter(isString))].sort();

  if (exactMatches.length > 0) {
    return {
      confidence: 0.98,
      matchedEmails: exactMatches.sort(),
      matchedDomains,
      matchReason: 'known_client_contact',
    };
  }
  if (domainMatches.length >= 2) {
    return {
      confidence: 0.95,
      matchedEmails: domainMatches.sort(),
      matchedDomains,
      matchReason: 'multiple_company_domain_participants',
    };
  }
  if (domainMatches.length === 1) {
    return {
      confidence: 0.92,
      matchedEmails: domainMatches,
      matchedDomains,
      matchReason: 'official_company_domain',
    };
  }
  return null;
}

export function extractEmailsFromUnknown(value: unknown): string[] {
  const emails = new Set<string>();
  collectEmails(value, emails, 0);
  return [...emails].sort();
}

function collectEmails(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    for (const match of matches) addNormalizedEmail(out, match);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEmails(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectEmails(nested, out, depth + 1);
    }
  }
}

function parseProposal(value: unknown): RelationshipLinkProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Relationship-history proposal is invalid');
  }
  const input = value as Record<string, unknown>;
  const action = input.action;
  const entityType = input.entityType;
  const entityId = typeof input.entityId === 'string' ? input.entityId.trim() : '';
  if (
    action !== 'associate_to_client' ||
    (entityType !== 'meeting' && entityType !== 'mail_thread') ||
    !entityId
  ) {
    throw new BadRequestException('Relationship-history proposal is incomplete');
  }
  return {
    action,
    entityType,
    entityId,
    title: typeof input.title === 'string' ? input.title : '',
    occurredAt: typeof input.occurredAt === 'string' ? input.occurredAt : '',
    matchedEmails: stringArray(input.matchedEmails),
    matchedDomains: stringArray(input.matchedDomains),
    matchReason:
      input.matchReason === 'known_client_contact' ||
      input.matchReason === 'official_company_domain' ||
      input.matchReason === 'multiple_company_domain_participants'
        ? input.matchReason
        : 'known_client_contact',
  };
}

function normalizeWebsiteDomain(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function addNormalizedEmail(target: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeEmail(value);
  if (normalized) target.add(normalized);
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function uniqueEmails(values: readonly (string | null | undefined)[]): string[] {
  const emails = new Set<string>();
  for (const value of values) addNormalizedEmail(emails, value);
  return [...emails].sort();
}

function domainOfEmail(email: string): string | null {
  const separator = email.lastIndexOf('@');
  if (separator < 0 || separator === email.length - 1) return null;
  return email.slice(separator + 1).toLowerCase();
}

function safeTitle(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 300) : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 100)
    : [];
}

function isString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}
