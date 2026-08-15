import { Injectable } from '@nestjs/common';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import {
  normalizeDomain,
  normalizeEntityIdentifier,
} from './entity-normalization.js';
import type {
  EntityAliasInput,
  EntityIdentifierInput,
  EntityIdentifierRegistrationInput,
  EntityResolutionPreview,
} from './entity-resolution.types.js';
import type {
  CanonicalSourceSyncOptions,
  CanonicalSourceSyncResult,
  ClientIdentitySource,
  ClientPersonIdentitySource,
  ConfirmedClientMappingIdentitySource,
  EngagementContactIdentitySource,
} from './canonical-source-adapter.types.js';
import { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

const GENERIC_MAILBOX_LOCAL_PARTS = new Set([
  'accounts',
  'admin',
  'billing',
  'careers',
  'communications',
  'contact',
  'hello',
  'hr',
  'info',
  'marketing',
  'media',
  'office',
  'press',
  'sales',
  'support',
  'team',
]);

/**
 * Deterministic adapters from Capiro's existing identity-bearing records into
 * the single canonical registry. No fuzzy or model path exists here.
 */
@Injectable()
export class CanonicalSourceAdapterService {
  constructor(
    private readonly resolver: UniversalEntityResolutionService,
    private readonly registration: CanonicalEntityRegistrationService,
  ) {}

  async syncClient(
    source: ClientIdentitySource,
    options: CanonicalSourceSyncOptions = {},
  ): Promise<CanonicalSourceSyncResult> {
    const aliases: EntityAliasInput[] = [
      {
        value: source.name,
        sourceType: 'crm_client',
        sourceId: source.id,
        confidence: 1,
      },
    ];
    const identifiers = clientIdentifiers(source);
    return this.syncTenantPrivateSource({
      tenantId: source.tenantId,
      sourceKind: 'client',
      sourceId: source.id,
      entityType: 'organization',
      canonicalName: source.name,
      aliases,
      identifiers,
      metadata: { crmClientId: source.id },
      options,
    });
  }

  async syncClientPerson(
    source: ClientPersonIdentitySource,
    options: CanonicalSourceSyncOptions = {},
  ): Promise<CanonicalSourceSyncResult> {
    const identifiers: EntityIdentifierRegistrationInput[] = [
      {
        type: 'crm_contact_id',
        value: source.id,
        sourceType: 'crm_contact',
        sourceId: source.id,
        confidence: 1,
      },
    ];
    const email = safeEmail(source.email);
    if (email) {
      identifiers.push({
        type: 'email',
        value: email,
        sourceType: 'crm_contact',
        sourceId: source.id,
        confidence: 1,
      });
    }

    return this.syncTenantPrivateSource({
      tenantId: source.tenantId,
      sourceKind: 'client_person',
      sourceId: source.id,
      entityType: 'person',
      canonicalName: source.name,
      aliases: [
        {
          value: source.name,
          sourceType: 'crm_contact',
          sourceId: source.id,
          confidence: 1,
        },
      ],
      identifiers,
      metadata: {
        crmContactId: source.id,
        clientId: source.clientId,
        ...(source.title ? { title: source.title } : {}),
      },
      options,
    });
  }

  async syncEngagementContact(
    source: EngagementContactIdentitySource,
    options: CanonicalSourceSyncOptions = {},
  ): Promise<CanonicalSourceSyncResult> {
    const email = safeEmail(source.email);
    const canonicalName = source.fullName?.trim() || email;
    if (!canonicalName) {
      return skipped('engagement_contact', source.id, 'Contact has no name or email.');
    }
    if (!source.fullName?.trim() && email && isGenericMailbox(email)) {
      return skipped(
        'engagement_contact',
        source.id,
        'Generic mailbox without a person name is not safe to canonicalize as a person.',
      );
    }

    const identifiers: EntityIdentifierRegistrationInput[] = [
      {
        type: 'engagement_contact_id',
        value: source.id,
        sourceType: 'engagement_contact',
        sourceId: source.id,
        confidence: 1,
      },
    ];
    if (email) {
      identifiers.push({
        type: 'email',
        value: email,
        sourceType: 'engagement_contact',
        sourceId: source.id,
        confidence: 1,
      });
    }
    if (source.directoryEntryId?.trim()) {
      identifiers.push({
        type: 'directory_person_id',
        value: source.directoryEntryId,
        sourceType: 'capiro_directory',
        sourceId: source.directoryEntryId,
        confidence: 1,
      });
    }
    if (source.acquisitionPersonnelId?.trim()) {
      identifiers.push({
        type: 'acquisition_personnel_id',
        value: source.acquisitionPersonnelId,
        sourceType: 'acquisition_personnel',
        sourceId: source.acquisitionPersonnelId,
        confidence: 1,
      });
    }

    const aliases: EntityAliasInput[] = source.fullName?.trim()
      ? [
          {
            value: source.fullName,
            sourceType: 'engagement_contact',
            sourceId: source.id,
            confidence: 1,
          },
        ]
      : [];

    return this.syncTenantPrivateSource({
      tenantId: source.tenantId,
      sourceKind: 'engagement_contact',
      sourceId: source.id,
      entityType: 'person',
      canonicalName,
      aliases,
      identifiers,
      metadata: {
        engagementContactId: source.id,
        ...(source.clientId ? { clientId: source.clientId } : {}),
        ...(source.organization ? { organization: source.organization } : {}),
        ...(source.title ? { title: source.title } : {}),
      },
      options,
    });
  }

  async syncConfirmedClientMapping(
    source: ConfirmedClientMappingIdentitySource,
    options: CanonicalSourceSyncOptions = {},
  ): Promise<CanonicalSourceSyncResult> {
    if (!source.confirmed || source.reviewStatus !== 'confirmed') {
      return skipped(
        'confirmed_client_mapping',
        source.id,
        'Only confirmed, reviewed client mappings may establish public identity.',
      );
    }
    if (source.publicIdentifiers.length === 0) {
      return skipped(
        'confirmed_client_mapping',
        source.id,
        'Confirmed mapping has no authoritative public identifier.',
      );
    }

    const preview = await this.resolver.preview(source.tenantId, {
      query: source.externalName,
      entityTypeHint: 'organization',
      identifiers: asLookupIdentifiers(source.publicIdentifiers),
    });
    if (options.dryRun) {
      if (preview.status === 'ambiguous' && !findConvergencePair(preview, source.tenantId)) {
        return fromAmbiguous(
          'confirmed_client_mapping',
          source.id,
          preview,
          'Public identifiers conflict with multiple visible entities.',
        );
      }
      const existingGlobal = preview.candidates.find(
        (candidate) => candidate.entity.identityScope === 'global_public',
      )?.entity;
      return {
        sourceKind: 'confirmed_client_mapping',
        sourceId: source.id,
        status: existingGlobal ? 'would_link' : 'would_create',
        entityId: existingGlobal?.id ?? null,
        resolutionId: null,
        candidates: preview.candidates,
        reason: null,
      };
    }

    const entity = await this.registration.registerGlobalPublicEntity({
      actorUserId: options.actorUserId ?? null,
      entityType: 'organization',
      canonicalName: source.externalName,
      resolutionMethod:
        source.source === 'contracting' ? 'federal_contractor' : 'lda_client',
      resolutionConfidence: 1,
      metadata: {
        publicSource: source.source,
        publicSourceId: source.externalId,
      },
      aliases: source.publicAliases ?? [],
      identifiers: source.publicIdentifiers,
    });

    const postRegistrationPreview = await this.resolver.preview(source.tenantId, {
      query: source.clientName,
      actorUserId: options.actorUserId ?? null,
      entityTypeHint: 'organization',
      identifiers: asLookupIdentifiers(source.publicIdentifiers),
    });
    if (postRegistrationPreview.status === 'ambiguous') {
      const convergence = findConvergencePair(
        postRegistrationPreview,
        source.tenantId,
        entity.id,
      );
      if (!convergence) {
        const ambiguous = await this.resolver.resolve(source.tenantId, {
          query: source.clientName,
          actorUserId: options.actorUserId ?? null,
          entityTypeHint: 'organization',
          identifiers: asLookupIdentifiers(source.publicIdentifiers),
        });
        return fromAmbiguous(
          'confirmed_client_mapping',
          source.id,
          ambiguous,
          'Public identifiers conflict with multiple visible entities.',
        );
      }

      await this.registration.mergeTenantPrivateEntity(source.tenantId, {
        sourceEntityId: convergence.privateEntityId,
        targetEntityId: convergence.globalEntityId,
        actorUserId: options.actorUserId ?? null,
        reasonCode: 'confirmed_public_mapping',
        reason: `Confirmed ${source.source} mapping ${source.id}`,
        provenance: [
          {
            sourceType: 'client_intel_mapping',
            sourceId: source.id,
            matchBasis: source.matchBasis ?? null,
            matchTier: source.matchTier ?? null,
          },
        ],
      });
    }

    const resolution = await this.resolver.resolve(source.tenantId, {
      query: source.clientName,
      actorUserId: options.actorUserId ?? null,
      entityTypeHint: 'organization',
      identifiers: asLookupIdentifiers(source.publicIdentifiers),
    });
    if (resolution.status !== 'resolved' || resolution.entity?.id !== entity.id) {
      return {
        sourceKind: 'confirmed_client_mapping',
        sourceId: source.id,
        status: 'ambiguous',
        entityId: null,
        resolutionId: resolution.resolutionId,
        candidates: resolution.candidates,
        reason: 'Canonical registration and tenant resolution did not converge on one entity.',
      };
    }

    await this.registration.linkTenantIdentity(source.tenantId, {
      entityId: entity.id,
      aliases: [
        {
          value: source.clientName,
          sourceType: 'crm_client',
          sourceId: source.clientId,
          confidence: 1,
        },
      ],
      identifiers: mappingTenantIdentifiers(source),
    });

    return {
      sourceKind: 'confirmed_client_mapping',
      sourceId: source.id,
      status:
        preview.candidates.some(
          (candidate) => candidate.entity.identityScope === 'global_public',
        )
          ? 'linked'
          : 'created',
      entityId: entity.id,
      resolutionId: resolution.resolutionId,
      candidates: resolution.candidates,
      reason: null,
    };
  }

  private async syncTenantPrivateSource(input: {
    tenantId: string;
    sourceKind: 'client' | 'client_person' | 'engagement_contact';
    sourceId: string;
    entityType: 'organization' | 'person';
    canonicalName: string;
    aliases: EntityAliasInput[];
    identifiers: EntityIdentifierRegistrationInput[];
    metadata: Record<string, unknown>;
    options: CanonicalSourceSyncOptions;
  }): Promise<CanonicalSourceSyncResult> {
    const resolveInput = {
      query: input.canonicalName,
      actorUserId: input.options.actorUserId ?? null,
      entityTypeHint: input.entityType,
      identifiers: asLookupIdentifiers(input.identifiers),
    };
    const preview = await this.resolver.preview(input.tenantId, resolveInput);
    if (preview.status === 'ambiguous') {
      return fromAmbiguous(
        input.sourceKind,
        input.sourceId,
        preview,
        'Deterministic identity signals resolve to multiple entities.',
      );
    }
    if (input.options.dryRun) {
      return {
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        status: preview.status === 'resolved' ? 'would_link' : 'would_create',
        entityId: preview.entity?.id ?? null,
        resolutionId: null,
        candidates: preview.candidates,
        reason: null,
      };
    }

    const resolution = await this.resolver.resolve(input.tenantId, resolveInput);
    if (resolution.status === 'ambiguous') {
      return fromAmbiguous(
        input.sourceKind,
        input.sourceId,
        resolution,
        'Deterministic identity signals resolve to multiple entities.',
      );
    }

    if (resolution.status === 'resolved' && resolution.entity) {
      const entity = await this.registration.linkTenantIdentity(input.tenantId, {
        entityId: resolution.entity.id,
        aliases: input.aliases,
        identifiers: input.identifiers,
      });
      return {
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        status: 'linked',
        entityId: entity.id,
        resolutionId: resolution.resolutionId,
        candidates: resolution.candidates,
        reason: null,
      };
    }

    const entity = await this.resolver.registerTenantPrivateEntity(input.tenantId, {
      actorUserId: input.options.actorUserId ?? null,
      entityType: input.entityType,
      canonicalName: input.canonicalName,
      resolutionMethod: `${input.sourceKind}_registration`,
      resolutionConfidence: 1,
      metadata: input.metadata,
      aliases: input.aliases,
      identifiers: input.identifiers,
    });
    return {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      status: 'created',
      entityId: entity.id,
      resolutionId: resolution.resolutionId,
      candidates: resolution.candidates,
      reason: null,
    };
  }
}

function clientIdentifiers(
  source: ClientIdentitySource,
): EntityIdentifierRegistrationInput[] {
  const values: EntityIdentifierRegistrationInput[] = [
    {
      type: 'crm_client_id',
      value: source.id,
      sourceType: 'crm_client',
      sourceId: source.id,
      confidence: 1,
    },
  ];
  const domain = safeDomain(source.website);
  if (domain) {
    values.push({
      type: 'domain',
      value: domain,
      sourceType: 'crm_client',
      sourceId: source.id,
      confidence: 0.95,
    });
  }
  if (source.uei?.trim()) {
    values.push({
      type: 'uei',
      value: source.uei,
      sourceType: 'crm_client',
      sourceId: source.id,
      confidence: 1,
    });
  }
  if (source.cageCode?.trim()) {
    values.push({
      type: 'cage',
      value: source.cageCode,
      sourceType: 'crm_client',
      sourceId: source.id,
      confidence: 1,
    });
  }
  for (const ldaClientId of source.ldaClientIds ?? []) {
    values.push({
      type: 'lda_client_id',
      value: String(ldaClientId),
      sourceType: 'crm_client',
      sourceId: source.id,
      confidence: 1,
    });
  }
  return values;
}

function mappingTenantIdentifiers(
  source: ConfirmedClientMappingIdentitySource,
): EntityIdentifierRegistrationInput[] {
  return clientIdentifiers({
    id: source.clientId,
    tenantId: source.tenantId,
    name: source.clientName,
    website: source.clientWebsite,
    uei: source.clientUei,
    cageCode: source.clientCageCode,
  });
}

function asLookupIdentifiers(
  values: readonly EntityIdentifierRegistrationInput[],
): EntityIdentifierInput[] {
  return values.map((value) => ({ type: value.type, value: value.value }));
}

function findConvergencePair(
  preview: EntityResolutionPreview,
  tenantId: string,
  expectedGlobalEntityId?: string,
): { globalEntityId: string; privateEntityId: string } | null {
  const uniqueEntities = new Map(
    preview.candidates.map((candidate) => [candidate.entity.id, candidate.entity]),
  );
  const entities = [...uniqueEntities.values()];
  const globals = entities.filter(
    (entity) =>
      entity.identityScope === 'global_public' &&
      (!expectedGlobalEntityId || entity.id === expectedGlobalEntityId),
  );
  const privates = entities.filter(
    (entity) =>
      entity.identityScope === 'tenant_private' && entity.tenantId === tenantId,
  );
  if (globals.length !== 1 || privates.length !== 1 || entities.length !== 2) {
    return null;
  }
  if (globals[0]!.entityType !== privates[0]!.entityType) return null;
  return {
    globalEntityId: globals[0]!.id,
    privateEntityId: privates[0]!.id,
  };
}

function safeDomain(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return normalizeDomain(value);
  } catch {
    return null;
  }
}

function safeEmail(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return normalizeEntityIdentifier('email', value);
  } catch {
    return null;
  }
}

function isGenericMailbox(email: string): boolean {
  const localPart = email.slice(0, email.indexOf('@')).toLocaleLowerCase('en-US');
  return GENERIC_MAILBOX_LOCAL_PARTS.has(localPart);
}

function skipped(
  sourceKind: CanonicalSourceSyncResult['sourceKind'],
  sourceId: string,
  reason: string,
): CanonicalSourceSyncResult {
  return {
    sourceKind,
    sourceId,
    status: 'skipped',
    entityId: null,
    resolutionId: null,
    candidates: [],
    reason,
  };
}

function fromAmbiguous(
  sourceKind: CanonicalSourceSyncResult['sourceKind'],
  sourceId: string,
  preview: EntityResolutionPreview & { resolutionId?: string },
  reason: string,
): CanonicalSourceSyncResult {
  return {
    sourceKind,
    sourceId,
    status: 'ambiguous',
    entityId: null,
    resolutionId: preview.resolutionId ?? null,
    candidates: preview.candidates,
    reason,
  };
}
