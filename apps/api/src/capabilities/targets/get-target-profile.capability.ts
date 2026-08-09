import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';
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

export interface TargetProfileUnavailableSectionV1 {
  status: 'available' | 'limited' | 'not_loaded' | 'not_available' | 'restricted';
  reason: string | null;
  values: string[];
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
    openAsks: TargetProfileUnavailableSectionV1;
    commitments: TargetProfileUnavailableSectionV1;
  };
  positioning: {
    knownInterests: TargetProfileUnavailableSectionV1;
    knownObjections: TargetProfileUnavailableSectionV1;
    preferredApproach: TargetProfileUnavailableSectionV1;
    publicPositions: TargetProfileUnavailableSectionV1;
  };
  governmentNexus: {
    districtState: TargetProfileUnavailableSectionV1;
    relevantBills: TargetProfileUnavailableSectionV1;
    relevantProgramElements: TargetProfileUnavailableSectionV1;
    fundingInterests: TargetProfileUnavailableSectionV1;
  };
  personalizationFacts: TargetProfileFactV1[];
  personalizationPolicy: {
    approvedFactCodes: string[];
    prohibitedCategories: string[];
  };
  dataQuality: {
    sourceSystem: string;
    sourceVersion: string | null;
    lastVerifiedAt: string | null;
    staleFields: string[];
    disputedFields: string[];
    conflictingFields: string[];
  };
  warnings: Array<{
    code:
      | 'ROLE_HISTORICAL'
      | 'ROLE_UNKNOWN'
      | 'EMAIL_MISSING'
      | 'EMAIL_INVALID'
      | 'PROFILE_LIMITED';
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
        'Read a source-aware government-affairs target profile with safe personalization facts, explicit unavailable sections and freshness warnings.',
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
    const target = await this.targetResolver.resolveOne(toTenantContext(ctx), input.targetRef);
    if (ctx.clientScope && target.clientId && ctx.clientScope.clientId !== target.clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested target does not belong to the authorized client scope.',
        false,
        true,
      );
    }

    const relationship = await this.loadRelationshipMetadata(ctx, target.locator);
    const facts = safeFacts(target);
    const prohibitedCategories = [
      'unscoped relationship note bodies',
      'private meeting-note bodies',
      'private email bodies',
      'sensitive biographical attributes',
      'unverified user-supplied notes',
    ];
    const warnings: TargetProfileDataV1['warnings'] = [];
    if (target.roleStatus === 'historical') {
      warnings.push({ code: 'ROLE_HISTORICAL', message: 'The source indicates this role is historical.' });
    } else if (target.roleStatus === 'unknown') {
      warnings.push({ code: 'ROLE_UNKNOWN', message: 'The current role has not been independently verified.' });
    }
    if (target.emailStatus === 'missing') {
      warnings.push({ code: 'EMAIL_MISSING', message: 'No usable direct email is currently available.' });
    } else if (target.emailStatus === 'invalid') {
      warnings.push({ code: 'EMAIL_INVALID', message: 'The available email does not pass address validation.' });
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
        relationshipMetadata: {
          ...relationship,
          openAsks: unavailable(
            'not_loaded',
            'Use analyze_relationships with an authorized client scope to inspect open asks.',
          ),
          commitments: unavailable(
            'not_loaded',
            'Use analyze_relationships with an authorized client scope to inspect commitments.',
          ),
        },
        positioning: {
          knownInterests: target.jurisdiction.issueAreas.length
            ? available(target.jurisdiction.issueAreas)
            : unavailable('not_available', 'No verified issue portfolio is present in the target source.'),
          knownObjections: unavailable(
            'not_loaded',
            'Known objections require governed target-specific context and are not inferred from role data.',
          ),
          preferredApproach: unavailable(
            'not_loaded',
            'Preferred approach requires governed relationship context and is not inferred.',
          ),
          publicPositions: unavailable(
            'not_loaded',
            'Public-position research is a separate government-research capability.',
          ),
        },
        governmentNexus: {
          districtState: districtStateSection(target),
          relevantBills: unavailable(
            'not_loaded',
            'Relevant bills require a source-backed government-research query.',
          ),
          relevantProgramElements: unavailable(
            'not_loaded',
            'Program Element relevance requires a source-backed intelligence query.',
          ),
          fundingInterests: unavailable(
            'not_loaded',
            'Funding interests require source-backed appropriations, grants or program evidence.',
          ),
        },
        personalizationFacts: facts,
        personalizationPolicy: {
          approvedFactCodes: facts
            .filter((fact) => fact.usableForPersonalization)
            .map((fact) => fact.code)
            .sort(compare),
          prohibitedCategories,
        },
        dataQuality: {
          sourceSystem: target.sourceSnapshot.system,
          sourceVersion: target.sourceSnapshot.version,
          lastVerifiedAt: target.sourceSnapshot.lastVerifiedAt,
          staleFields: target.roleStatus === 'historical' ? ['role', 'title', 'organization'] : [],
          disputedFields: [],
          conflictingFields: [],
        },
        warnings,
        restrictedCategories: prohibitedCategories,
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
          count: relationship.notesAvailable ? 1 : 0,
        },
        {
          category: 'government_research',
          reasonCode: 'requires_explicit_source_backed_query',
          count: 4,
        },
      ],
      scope: { tenantId: ctx.tenantId, clientId: target.clientId },
      freshness: {
        asOf: target.sourceSnapshot.lastVerifiedAt ?? retrievedAt,
        degraded: warnings.length > 0,
        reasons: warnings.map((warning) => warning.code),
      },
      authorization: {
        filtered: relationship.notesAvailable,
        restrictedCount: relationship.notesAvailable ? 1 : 0,
      },
    };
  }

  private async loadRelationshipMetadata(
    ctx: AuthorizedCapabilityContext,
    locator: OutreachTargetLocatorV1,
  ): Promise<Pick<TargetProfileDataV1['relationshipMetadata'], 'lastContactAt' | 'notesAvailable' | 'ownerLabel'>> {
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

function safeFacts(target: OutreachResolvedTargetRefV1): TargetProfileFactV1[] {
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

function districtStateSection(target: OutreachResolvedTargetRefV1): TargetProfileUnavailableSectionV1 {
  const values = [target.jurisdiction.state, target.jurisdiction.district]
    .filter((value): value is string => Boolean(value));
  return values.length
    ? available(values)
    : unavailable('not_available', 'No verified state or district nexus is present in the target source.');
}

function available(values: readonly string[]): TargetProfileUnavailableSectionV1 {
  return { status: 'available', reason: null, values: [...new Set(values)].sort(compare) };
}

function unavailable(
  status: Exclude<TargetProfileUnavailableSectionV1['status'], 'available'>,
  reason: string,
): TargetProfileUnavailableSectionV1 {
  return { status, reason, values: [] };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
