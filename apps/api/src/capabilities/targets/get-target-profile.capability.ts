import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DirectoryService } from '../../directory/directory.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import { CapabilityError } from '../capability-errors.js';
import {
  outreachTargetLocatorV1Schema,
  type OutreachResolvedTargetRefV1,
  type OutreachTargetLocatorV1,
} from './outreach-target.contract.js';
import { OutreachTargetReferenceService } from './outreach-target-reference.service.js';

const inputSchemaZod = z.object({ targetRef: outreachTargetLocatorV1Schema }).strict();
export type GetTargetProfileInput = z.infer<typeof inputSchemaZod>;

export interface TargetProfileFactV1 {
  code: string;
  label: string;
  value: string | string[] | null;
  status: 'verified' | 'historical' | 'user_supplied' | 'needs_confirmation';
  usableForPersonalization: boolean;
}

export interface TargetProfileDataV1 {
  target: OutreachResolvedTargetRefV1;
  identity: {
    displayName: string;
    targetType: OutreachTargetLocatorV1['source'];
    clientId: string | null;
  };
  role: {
    title: string | null;
    organization: string | null;
    status: 'current' | 'historical' | 'unknown';
  };
  contact: {
    email: string | null;
    phone: string | null;
    emailStatus: 'available' | 'missing' | 'invalid';
  };
  jurisdiction: OutreachResolvedTargetRefV1['jurisdiction'];
  relationshipMetadata: {
    lastContactAt: string | null;
    notesAvailable: boolean;
    ownerLabel: string | null;
  };
  personalizationFacts: TargetProfileFactV1[];
  warnings: Array<{
    code: 'ROLE_HISTORICAL' | 'ROLE_UNKNOWN' | 'EMAIL_MISSING' | 'PROFILE_LIMITED';
    message: string;
  }>;
  restrictedCategories: string[];
}

const inputSchema: CapabilityRuntimeSchema<GetTargetProfileInput> = {
  name: 'get_target_profile.input.v1',
  parse(value) {
    return inputSchemaZod.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<TargetProfileDataV1>> = {
  name: 'get_target_profile.output.v1',
  parse(value) {
    return assertCapabilityResult<TargetProfileDataV1>(value, 'get_target_profile');
  },
};

@Injectable()
export class GetTargetProfileCapability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
    private readonly targetResolver: OutreachTargetReferenceService,
  ) {}

  definition(): CapabilityDefinition<GetTargetProfileInput, TargetProfileDataV1> {
    return {
      name: 'get_target_profile',
      description:
        'Read a source-aware target profile with safe personalization facts and explicit freshness warnings.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 10_000,
      maxResultCount: 1,
      maxResultBytes: 128_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    input: GetTargetProfileInput,
  ): Promise<CapabilityResult<TargetProfileDataV1>> {
    const tenantCtx = toTenantContext(ctx);
    const target = await this.targetResolver.resolveOne(tenantCtx, input.targetRef);
    if (ctx.clientScope && target.clientId && ctx.clientScope.clientId !== target.clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested target does not belong to the authorized client scope.',
        false,
        true,
      );
    }

    const metadata = await this.loadRelationshipMetadata(ctx, target.locator);
    const facts = await this.safeFacts(target);
    const warnings: TargetProfileDataV1['warnings'] = [];
    if (target.roleStatus === 'historical') {
      warnings.push({ code: 'ROLE_HISTORICAL', message: 'The source indicates this role is historical.' });
    } else if (target.roleStatus === 'unknown') {
      warnings.push({ code: 'ROLE_UNKNOWN', message: 'The current role has not been independently verified.' });
    }
    if (target.emailStatus !== 'available') {
      warnings.push({ code: 'EMAIL_MISSING', message: 'No usable direct email is currently available.' });
    }
    if (target.profileStatus !== 'complete') {
      warnings.push({ code: 'PROFILE_LIMITED', message: 'Only a limited target profile is available.' });
    }

    const retrievedAt = new Date().toISOString();
    return {
      capability: 'get_target_profile',
      schemaVersion: 1,
      data: {
        target,
        identity: {
          displayName: target.displayName,
          targetType: target.locator.source,
          clientId: target.clientId,
        },
        role: {
          title: target.title,
          organization: target.organization,
          status: target.roleStatus,
        },
        contact: {
          email: target.email,
          phone: target.phone,
          emailStatus: target.emailStatus,
        },
        jurisdiction: target.jurisdiction,
        relationshipMetadata: metadata,
        personalizationFacts: facts,
        warnings,
        restrictedCategories: [
          'unscoped relationship note bodies',
          'private meeting-note bodies',
          'private email bodies',
          'sensitive biographical attributes',
        ],
      },
      provenance: [
        {
          recordType: target.locator.source,
          recordId: target.locator.id,
          sourceSystem: target.sourceSnapshot.system,
          sourceDate: target.sourceSnapshot.lastVerifiedAt,
          lastVerifiedAt: target.sourceSnapshot.lastVerifiedAt,
          retrievedAt,
          verificationClass:
            target.sourceSnapshot.system === 'user_supplied'
              ? 'unverified'
              : target.sourceSnapshot.system === 'capiro_directory'
                ? 'authoritative'
                : 'first_party',
          classification: 'fact',
        },
      ],
      exclusions: [
        {
          category: 'relationship_content',
          reasonCode: 'requires_governed_context_phase',
          count: metadata.notesAvailable ? 1 : 0,
        },
      ],
      scope: { tenantId: ctx.tenantId, clientId: target.clientId },
      freshness: {
        asOf: target.sourceSnapshot.lastVerifiedAt ?? retrievedAt,
        degraded: warnings.length > 0,
        reasons: warnings.map((warning) => warning.code),
      },
      authorization: { filtered: metadata.notesAvailable, restrictedCount: metadata.notesAvailable ? 1 : 0 },
    };
  }

  private async safeFacts(target: OutreachResolvedTargetRefV1): Promise<TargetProfileFactV1[]> {
    const sourceStatus: TargetProfileFactV1['status'] =
      target.locator.source === 'manual'
        ? 'user_supplied'
        : target.roleStatus === 'current'
          ? 'verified'
          : target.roleStatus === 'historical'
            ? 'historical'
            : 'needs_confirmation';
    const facts: TargetProfileFactV1[] = [
      {
        code: 'current_role',
        label: 'Role',
        value: [target.title, target.organization].filter(Boolean).join(' — ') || null,
        status: sourceStatus,
        usableForPersonalization: target.roleStatus === 'current',
      },
      {
        code: 'jurisdiction',
        label: 'Jurisdiction',
        value: [target.jurisdiction.chamber, target.jurisdiction.state, target.jurisdiction.district]
          .filter(Boolean)
          .join(' · ') || null,
        status: sourceStatus,
        usableForPersonalization: target.roleStatus === 'current',
      },
      {
        code: 'committees',
        label: 'Committees',
        value: target.jurisdiction.committees,
        status: sourceStatus,
        usableForPersonalization: target.roleStatus === 'current',
      },
      {
        code: 'issue_areas',
        label: 'Issue areas',
        value: target.jurisdiction.issueAreas,
        status: sourceStatus,
        usableForPersonalization: target.roleStatus === 'current',
      },
    ];
    if (target.locator.source === 'manual' && target.locator.note) {
      facts.push({
        code: 'user_note',
        label: 'User-provided target note',
        value: target.locator.note,
        status: 'user_supplied',
        usableForPersonalization: false,
      });
    }
    return facts.filter((fact) =>
      Array.isArray(fact.value) ? fact.value.length > 0 : fact.value !== null && fact.value !== '',
    );
  }

  private async loadRelationshipMetadata(
    ctx: AuthorizedCapabilityContext,
    locator: OutreachTargetLocatorV1,
  ): Promise<TargetProfileDataV1['relationshipMetadata']> {
    if (locator.source === 'directory_member') {
      const contact = (await this.directory.getAllContacts()).find((entry) => entry.id === locator.id);
      const noteCount = await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, (tx) =>
        tx.directoryContactNote.count({
          where: { tenantId: ctx.tenantId, directoryContactId: locator.id },
        }),
      );
      return {
        lastContactAt: contact?.lastTouchpoint || null,
        notesAvailable: noteCount > 0,
        ownerLabel: contact?.owner || null,
      };
    }
    if (locator.source === 'directory_staff') {
      const noteCount = await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, (tx) =>
        tx.directoryContactNote.count({
          where: { tenantId: ctx.tenantId, directoryContactId: locator.id },
        }),
      );
      return { lastContactAt: null, notesAvailable: noteCount > 0, ownerLabel: null };
    }
    if (locator.source === 'client_person') {
      return this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, async (tx) => {
        const row = await tx.clientPerson.findFirst({
          where: { id: locator.id, tenantId: ctx.tenantId, clientId: locator.clientId },
          select: { lastContact: true, notes: true },
        });
        return {
          lastContactAt: row?.lastContact?.toISOString() ?? null,
          notesAvailable: Boolean(row?.notes),
          ownerLabel: null,
        };
      });
    }
    return { lastContactAt: null, notesAvailable: false, ownerLabel: null };
  }
}

function toTenantContext(ctx: AuthorizedCapabilityContext) {
  return {
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug ?? '',
    clerkOrgId: '',
    userId: ctx.actorUserId,
    clerkUserId: ctx.clerkUserId ?? '',
    role: ctx.role as never,
    impersonation: ctx.impersonation ?? undefined,
  };
}
