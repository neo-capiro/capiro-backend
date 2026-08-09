import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { CapabilityError } from '../capability-errors.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import {
  outreachTargetLocatorV1Schema,
  type OutreachTargetLocatorV1,
} from './outreach-target.contract.js';
import { OutreachTargetReferenceService } from './outreach-target-reference.service.js';

const inputSchemaZod = z
  .object({
    targetRef: outreachTargetLocatorV1Schema,
    clientId: z.string().uuid(),
  })
  .strict();

export type AnalyzeRelationshipsInput = z.infer<typeof inputSchemaZod>;

export interface RelationshipInteractionV1 {
  type: 'meeting' | 'email';
  occurredAt: string;
  label: string;
  responseStatus: string | null;
}

export interface AnalyzeRelationshipsDataV1 {
  targetKey: string;
  clientId: string;
  status: 'strong' | 'active' | 'known' | 'none';
  interactionCount: number;
  meetingCount: number;
  emailCount: number;
  lastInteractionAt: string | null;
  recentInteractions: RelationshipInteractionV1[];
  openCommitments: Array<{
    id: string;
    title: string;
    dueDate: string | null;
    status: string;
  }>;
  limitations: string[];
}

const inputSchema: CapabilityRuntimeSchema<AnalyzeRelationshipsInput> = {
  name: 'analyze_relationships.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<AnalyzeRelationshipsDataV1>> = {
  name: 'analyze_relationships.output.v1',
  parse(value) {
    return assertCapabilityResult<AnalyzeRelationshipsDataV1>(value, 'analyze_relationships');
  },
};

@Injectable()
export class AnalyzeRelationshipsCapability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: CapabilityAuthorizationService,
    private readonly targetResolver: OutreachTargetReferenceService,
  ) {}

  definition(): CapabilityDefinition<AnalyzeRelationshipsInput, AnalyzeRelationshipsDataV1> {
    return {
      name: 'analyze_relationships',
      description:
        'Analyze client-scoped meetings, email metadata and open tasks for one reauthorized target.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 10_000,
      maxResultCount: 25,
      maxResultBytes: 96_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: AnalyzeRelationshipsInput,
  ): Promise<CapabilityResult<AnalyzeRelationshipsDataV1>> {
    const input = inputSchemaZod.parse(rawInput);
    if (ctx.clientScope && ctx.clientScope.clientId !== input.clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested relationship scope is not authorized.',
        false,
        true,
      );
    }
    await this.authorization.authorizeClient(ctx, input.clientId);
    const target = await this.targetResolver.resolveOne(toTenantContext(ctx), input.targetRef);
    if (target.clientId && target.clientId !== input.clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested target is not available in the authorized client scope.',
        false,
        true,
      );
    }

    const email = target.email?.toLowerCase() ?? null;
    const contactId =
      target.locator.source === 'engagement_contact'
        ? target.locator.id
        : await this.findEngagementContactId(ctx, input.clientId, email);

    const data = await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, async (tx) => {
      const attendees = email || contactId
        ? await tx.meetingAttendee.findMany({
            where: {
              tenantId: ctx.tenantId,
              OR: [
                ...(email ? [{ email }] : []),
                ...(contactId ? [{ contactId }] : []),
              ],
              meeting: {
                tenantId: ctx.tenantId,
                clientId: input.clientId,
                OR: [{ visibility: 'shared' }, { createdByUserId: ctx.actorUserId }],
              },
            },
            select: {
              responseStatus: true,
              meeting: {
                select: {
                  id: true,
                  subject: true,
                  startsAt: true,
                  status: true,
                },
              },
            },
            take: 100,
          })
        : [];

      const messages = email
        ? await tx.mailMessage.findMany({
            where: {
              tenantId: ctx.tenantId,
              removedAt: null,
              thread: { clientId: input.clientId },
            },
            select: {
              id: true,
              subject: true,
              fromEmail: true,
              toRecipients: true,
              ccRecipients: true,
              bccRecipients: true,
              sentAt: true,
              receivedAt: true,
            },
            orderBy: [{ receivedAt: 'desc' }, { sentAt: 'desc' }],
            take: 200,
          })
        : [];

      const tasks = contactId
        ? await tx.engagementTask.findMany({
            where: {
              tenantId: ctx.tenantId,
              clientId: input.clientId,
              contactId,
              status: { in: ['todo', 'in_progress', 'blocked'] },
            },
            select: { id: true, title: true, dueDate: true, status: true },
            orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
            take: 25,
          })
        : [];

      return { attendees, messages, tasks };
    });

    const interactions: RelationshipInteractionV1[] = data.attendees.map((attendee) => ({
      type: 'meeting',
      occurredAt: attendee.meeting.startsAt.toISOString(),
      label: attendee.meeting.subject,
      responseStatus: attendee.responseStatus,
    }));
    if (email) {
      for (const message of data.messages) {
        if (!messageTouchesEmail(message, email)) continue;
        const occurredAt = message.receivedAt ?? message.sentAt;
        if (!occurredAt) continue;
        interactions.push({
          type: 'email',
          occurredAt: occurredAt.toISOString(),
          label: message.subject || 'Email interaction',
          responseStatus: null,
        });
      }
    }
    interactions.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const uniqueInteractions = dedupeInteractions(interactions);
    const meetingCount = uniqueInteractions.filter((item) => item.type === 'meeting').length;
    const emailCount = uniqueInteractions.filter((item) => item.type === 'email').length;
    const lastInteractionAt = uniqueInteractions[0]?.occurredAt ?? null;
    const interactionCount = uniqueInteractions.length;
    const status = relationshipStatus(interactionCount, lastInteractionAt);
    const retrievedAt = new Date().toISOString();

    return {
      capability: 'analyze_relationships',
      schemaVersion: 1,
      data: {
        targetKey: target.targetKey,
        clientId: input.clientId,
        status,
        interactionCount,
        meetingCount,
        emailCount,
        lastInteractionAt,
        recentInteractions: uniqueInteractions.slice(0, 10),
        openCommitments: data.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
          status: task.status,
        })),
        limitations: [
          'Relationship analysis uses client-scoped meeting, email-envelope and task metadata only.',
          'Private note and email bodies are excluded until governed context review.',
        ],
      },
      provenance: [
        {
          recordType: 'relationship_analysis',
          recordId: target.targetKey,
          sourceSystem: 'capiro_engagement',
          sourceDate: lastInteractionAt,
          lastVerifiedAt: lastInteractionAt,
          retrievedAt,
          verificationClass: 'first_party',
          classification: 'inference',
        },
      ],
      exclusions: [
        {
          category: 'message_bodies',
          reasonCode: 'not_required_for_relationship_metadata',
          count: 1,
        },
        {
          category: 'private_notes',
          reasonCode: 'requires_governed_context_phase',
          count: 1,
        },
      ],
      scope: { tenantId: ctx.tenantId, clientId: input.clientId },
      freshness: {
        asOf: lastInteractionAt ?? retrievedAt,
        degraded: !email && !contactId,
        reasons: !email && !contactId ? ['TARGET_HAS_NO_RESOLVABLE_CONTACT_IDENTITY'] : [],
      },
      authorization: { filtered: true, restrictedCount: 2 },
    };
  }

  private async findEngagementContactId(
    ctx: AuthorizedCapabilityContext,
    clientId: string,
    email: string | null,
  ): Promise<string | null> {
    if (!email) return null;
    return this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, async (tx) => {
      const row = await tx.engagementContact.findFirst({
        where: { tenantId: ctx.tenantId, clientId, email },
        select: { id: true },
      });
      return row?.id ?? null;
    });
  }
}

function messageTouchesEmail(
  message: {
    fromEmail: string | null;
    toRecipients: unknown;
    ccRecipients: unknown;
    bccRecipients: unknown;
  },
  email: string,
): boolean {
  if (message.fromEmail?.toLowerCase() === email) return true;
  return [message.toRecipients, message.ccRecipients, message.bccRecipients].some((value) =>
    recipientEmails(value).includes(email),
  );
}

function recipientEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (typeof entry === 'string') return [entry.toLowerCase()];
      if (entry && typeof entry === 'object') {
        const object = entry as Record<string, unknown>;
        const raw = object.email ?? object.address ?? object.mail;
        return typeof raw === 'string' ? [raw.toLowerCase()] : [];
      }
      return [];
    })
    .filter((entry) => entry.includes('@'));
}

function dedupeInteractions(input: RelationshipInteractionV1[]): RelationshipInteractionV1[] {
  const seen = new Set<string>();
  return input.filter((item) => {
    const key = `${item.type}|${item.occurredAt}|${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relationshipStatus(
  interactionCount: number,
  lastInteractionAt: string | null,
): AnalyzeRelationshipsDataV1['status'] {
  if (!interactionCount || !lastInteractionAt) return 'none';
  const ageDays = Math.max(0, (Date.now() - new Date(lastInteractionAt).getTime()) / 86_400_000);
  if (interactionCount >= 5 || (interactionCount >= 3 && ageDays <= 45)) return 'strong';
  if (interactionCount >= 2 || ageDays <= 90) return 'active';
  return 'known';
}

function toTenantContext(ctx: AuthorizedCapabilityContext): TenantContext {
  return {
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug ?? '',
    userId: ctx.actorUserId,
    clerkUserId: ctx.clerkUserId ?? '',
    role: ctx.role as TenantContext['role'],
  };
}
