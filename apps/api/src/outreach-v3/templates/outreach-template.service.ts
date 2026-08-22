import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CapabilityAuthorizationService } from '../../capabilities/capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../../capabilities/capability-context.js';
import { CapabilityError } from '../../capabilities/capability-errors.js';
import { OutreachStateRepository } from '../persistence/outreach-state.repository.js';
import { OutreachCommandEngineService } from '../services/outreach-command-engine.service.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import {
  createBlankCampaignSpecV1,
  hashCampaignSpecV1,
  OUTREACH_CAMPAIGN_SPEC_SCHEMA_VERSION,
} from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  hashOutreachTemplateSpecV1,
  parseOutreachTemplateSpecV1,
  templateSpecFromCampaign,
  type OutreachTemplateScope,
} from './outreach-template.contract.js';
import { compileOutreachTemplateBatch } from './outreach-template.compiler.js';
import {
  OutreachTemplateRepository,
  type OutreachTemplateRow,
  type OutreachTemplateVersionRow,
} from './outreach-template.repository.js';
import {
  assertDestinationScopeAllowed,
  assertSharedPublicationAuthority,
  assertVersionSourceMatchesTemplateScope,
  classifySourceScope,
  computeTemplateApplicationFingerprint,
  computeTemplateCapabilities,
  toTemplateCardSummary,
} from './outreach-template-authorization.js';

interface TemplateMetadataInput {
  name: string;
  description?: string | null;
  scope: OutreachTemplateScope;
  clientId?: string | null;
}

function normalizeMetadata(input: TemplateMetadataInput) {
  const name = input.name?.trim();
  const description = input.description?.trim() || null;
  const clientId = input.scope === 'client' ? input.clientId ?? null : null;
  if (!name || name.length > 160) {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_INVALID',
      'Template name must be between 1 and 160 characters.',
      400,
    );
  }
  if (description && description.length > 1_000) {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_INVALID',
      'Template description exceeds the allowed length.',
      400,
    );
  }
  if (input.scope === 'client' && !clientId) {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_INVALID',
      'Client-scoped templates require a client.',
      400,
    );
  }
  return { name, description, scope: input.scope, clientId };
}

@Injectable()
export class OutreachTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: OutreachTemplateRepository,
    private readonly sessions: OutreachSessionService,
    private readonly state: OutreachStateRepository,
    private readonly commands: OutreachCommandEngineService,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  async list(
    ctx: TenantContext,
    input: { includeArchived?: boolean; clientId?: string | null } = {},
  ) {
    const clientId = input.clientId ?? null;
    if (clientId) await this.authorizeClient(ctx, clientId, 'list');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await this.templates.listVisible(tx, ctx, {
        includeArchived: input.includeArchived ?? false,
        clientId,
      });
      return rows.map((row) => {
        const { previewSpecJsonb, ...rest } = row;
        return {
          ...rest,
          previewSummary: previewSpecJsonb
            ? toTemplateCardSummary(parseOutreachTemplateSpecV1(previewSpecJsonb))
            : null,
          capabilities: computeTemplateCapabilities(ctx, row),
        };
      });
    });
  }

  async get(ctx: TenantContext, templateId: string, clientId?: string | null) {
    const requestedClientId = clientId ?? null;
    if (requestedClientId) await this.authorizeClient(ctx, requestedClientId, 'get');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const template = await this.templates.getVisible(tx, ctx, templateId, requestedClientId);
      const capabilities = computeTemplateCapabilities(ctx, template);
      const versions = await this.templates.listVersions(tx, ctx, template.id, !capabilities.canInspect);
      return {
        // Non-managers never learn the current draft version id (closeout
        // runbook 3.5/5.8) even though it is harmless-looking metadata — it is
        // still a pointer into content they cannot otherwise reach.
        template: capabilities.canInspect
          ? template
          : { ...template, currentDraftVersionId: null },
        versions: versions.map((version) => this.verifyVersion(version)),
        capabilities,
      };
    });
  }

  async createFromSession(
    ctx: TenantContext,
    input: TemplateMetadataInput & { sessionId: string },
  ) {
    const metadata = normalizeMetadata(input);
    const source = await this.sessions.getSession(ctx, input.sessionId);
    const sourceScope = classifySourceScope(source.spec.sponsor);
    try {
      const resolved = assertDestinationScopeAllowed(sourceScope, metadata.scope, metadata.clientId);
      if (resolved.clientId) await this.authorizeClient(ctx, resolved.clientId, 'createFromSession');
      const spec = templateSpecFromCampaign(source.spec);
      const contentHash = hashOutreachTemplateSpecV1(spec);
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const created = await this.templates.createWithDraft(tx, ctx, {
          templateId: randomUUID(),
          versionId: randomUUID(),
          ...metadata,
          clientId: resolved.clientId,
          spec,
          contentHash,
          sourceSessionId: source.session.id,
          sourceStateVersion: source.currentStateVersion,
        });
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'create',
          templateId: created.template.id,
          templateVersionId: created.version.id,
          scope: created.template.scope,
          outcome: 'allowed',
        });
        return {
          template: created.template,
          version: this.verifyVersion(created.version),
          published: false,
        };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'create', error, { scope: metadata.scope });
      throw error;
    }
  }

  async createVersionFromSession(
    ctx: TenantContext,
    templateId: string,
    input: { sessionId: string },
  ) {
    const source = await this.sessions.getSession(ctx, input.sessionId);
    const sourceScope = classifySourceScope(source.spec.sponsor);
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const template = await this.templates.lockManaged(tx, ctx, templateId);
        assertVersionSourceMatchesTemplateScope(sourceScope, template);
        if (template.clientId) await this.authorizeClientWithinTx(tx, ctx, template.clientId, 'createVersionFromSession');
        const spec = templateSpecFromCampaign(source.spec);
        const contentHash = hashOutreachTemplateSpecV1(spec);
        const version = await this.templates.createDraftVersion(tx, ctx, template, {
          versionId: randomUUID(),
          spec,
          contentHash,
          sourceSessionId: source.session.id,
          sourceStateVersion: source.currentStateVersion,
        });
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'create_version',
          templateId: template.id,
          templateVersionId: version.id,
          scope: template.scope,
          outcome: 'allowed',
        });
        return {
          templateId: template.id,
          version: this.verifyVersion(version),
          published: false,
        };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'create_version', error, { templateId });
      throw error;
    }
  }

  async publish(ctx: TenantContext, templateId: string) {
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const template = await this.templates.lockManaged(tx, ctx, templateId);
        assertSharedPublicationAuthority(ctx, template.scope);
        const version = await this.templates.publishDraft(tx, ctx, template);
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'publish',
          templateId: template.id,
          templateVersionId: version.id,
          scope: template.scope,
          outcome: 'allowed',
        });
        return {
          templateId: template.id,
          version: this.verifyVersion(version),
          published: true,
        };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'publish', error, { templateId });
      throw error;
    }
  }

  async updateMetadata(
    ctx: TenantContext,
    templateId: string,
    input: TemplateMetadataInput,
  ) {
    const metadata = normalizeMetadata(input);
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const template = await this.templates.lockManaged(tx, ctx, templateId);
        const isScopeOrClientChange =
          metadata.scope !== template.scope || metadata.clientId !== template.clientId;
        // Changing scope/client either direction is a governance action, not
        // routine metadata editing (closeout runbook 6.18): require the same
        // shared publication authority a firm/client publish would require,
        // on whichever of the old/new scope is non-private.
        if (isScopeOrClientChange) {
          assertSharedPublicationAuthority(ctx, template.scope);
          assertSharedPublicationAuthority(ctx, metadata.scope);
        }
        if (metadata.clientId) await this.authorizeClientWithinTx(tx, ctx, metadata.clientId, 'updateMetadata');
        const updated = await this.templates.updateMetadata(tx, ctx, template, metadata);
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'update_metadata',
          templateId: updated.id,
          scope: updated.scope,
          outcome: 'allowed',
          safeMetadata: { scopeChanged: isScopeOrClientChange },
        });
        return updated;
      });
    } catch (error) {
      await this.auditDenied(ctx, 'update_metadata', error, { templateId });
      throw error;
    }
  }

  async archive(ctx: TenantContext, templateId: string) {
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const template = await this.templates.lockManaged(tx, ctx, templateId);
        await this.templates.archive(tx, ctx, template);
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'archive',
          templateId: template.id,
          scope: template.scope,
          outcome: 'allowed',
        });
        return { id: template.id, status: 'archived' as const };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'archive', error, { templateId });
      throw error;
    }
  }

  async usePublished(
    ctx: TenantContext,
    templateId: string,
    input: { requestKey: string; title?: string | null; clientId?: string | null },
  ) {
    const title = input.title?.trim() || null;
    if (title && title.length > 240) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_INVALID',
        'Campaign title exceeds the allowed length.',
        400,
      );
    }
    const clientId = input.clientId ?? null;

    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const template = await this.templates.getVisible(tx, ctx, templateId, clientId);
        if (template.status !== 'active') {
          throw new OutreachCommandError(
            'OUTREACH_TEMPLATE_FORBIDDEN',
            'Archived templates cannot start new campaigns.',
            409,
          );
        }
        if (template.scope === 'client' && (!clientId || template.clientId !== clientId)) {
          throw new OutreachCommandError(
            'OUTREACH_TEMPLATE_FORBIDDEN',
            'This template is available only inside its client scope.',
            403,
          );
        }
        if (clientId) await this.authorizeClientWithinTx(tx, ctx, clientId, 'usePublished');
        if (!template.publishedVersionId) {
          throw new OutreachCommandError(
            'OUTREACH_TEMPLATE_NOT_PUBLISHED',
            'Publish this template before using it.',
            409,
          );
        }

        const version = await this.templates.getVersion(tx, ctx, template.publishedVersionId);
        if (version.lifecycle !== 'published' || version.templateId !== template.id) {
          throw new OutreachCommandError(
            'OUTREACH_STATE_CORRUPT',
            'The template publication pointer is invalid.',
            500,
          );
        }
        const verified = this.verifyVersion(version);

        const fingerprint = computeTemplateApplicationFingerprint({
          actorUserId: ctx.userId,
          templateId: template.id,
          templateVersionId: version.id,
          clientId,
          title,
        });

        const existing = await this.templates.findApplicationByRequestKey(tx, ctx, input.requestKey);
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) {
            throw new OutreachCommandError(
              'OUTREACH_TEMPLATE_REQUEST_REUSE',
              'This template request key was already used for a different request.',
              409,
            );
          }
          return {
            sessionId: existing.sessionId,
            stateVersion: existing.resultingStateVersion,
            templateId: existing.templateId,
            templateVersionId: existing.templateVersionId,
            applicationId: existing.id,
            replayed: true,
            requiresLiveTargets: true,
            requiresLiveContext: true,
          };
        }

        const blank = createBlankCampaignSpecV1();
        const session = await this.state.createSessionWithinTx(tx, ctx, {
          title: title || template.name,
          schemaVersion: OUTREACH_CAMPAIGN_SPEC_SCHEMA_VERSION,
          specJsonb: blank,
          specHash: hashCampaignSpecV1(blank),
        });
        const rawBatch = compileOutreachTemplateBatch({
          batchId: input.requestKey,
          expectedStateVersion: 1,
          spec: verified.spec,
          clientId,
        });
        const batch = this.commands.parseNormalizeAndValidateBatch(rawBatch);
        const result = await this.commands.applyBatchWithinTx(
          tx,
          ctx,
          session.id,
          batch,
          { source: 'user_control', prelockedSession: session },
        );
        const { application, replayed } = await this.templates.recordApplication(tx, ctx, {
          applicationId: randomUUID(),
          template,
          version,
          sessionId: session.id,
          requestKey: input.requestKey,
          requestFingerprint: fingerprint,
          commandBatch: batch,
          resultingStateVersion: result.stateVersion,
        });
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'use',
          templateId: template.id,
          templateVersionId: version.id,
          scope: template.scope,
          outcome: 'allowed',
          safeMetadata: { replayed },
        });
        return {
          sessionId: replayed ? application.sessionId : session.id,
          stateVersion: replayed ? application.resultingStateVersion : result.stateVersion,
          templateId: template.id,
          templateVersionId: version.id,
          applicationId: application.id,
          replayed,
          requiresLiveTargets: true,
          requiresLiveContext: true,
        };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'use', error, { templateId });
      throw error;
    }
  }

  /** Reads the client outside any open transaction (list/get path). */
  private async authorizeClient(
    ctx: TenantContext,
    clientId: string,
    requestId: string,
  ): Promise<void> {
    const capabilityContext = this.buildCapabilityContext(ctx, requestId);
    try {
      await this.authorization.authorizeClient(capabilityContext, clientId);
    } catch (error) {
      if (error instanceof CapabilityError) {
        throw new OutreachCommandError(
          'OUTREACH_TEMPLATE_SCOPE_UNAUTHORIZED',
          'This client is not authorized for the current actor.',
          403,
        );
      }
      throw error;
    }
  }

  /** Same check as authorizeClient(), but on a transaction the caller already owns. */
  private async authorizeClientWithinTx(
    tx: Parameters<CapabilityAuthorizationService['authorizeClientWithinTx']>[0],
    ctx: TenantContext,
    clientId: string,
    requestId: string,
  ): Promise<void> {
    const capabilityContext = this.buildCapabilityContext(ctx, requestId);
    try {
      await this.authorization.authorizeClientWithinTx(tx, capabilityContext, clientId);
    } catch (error) {
      if (error instanceof CapabilityError) {
        throw new OutreachCommandError(
          'OUTREACH_TEMPLATE_SCOPE_UNAUTHORIZED',
          'This client is not authorized for the current actor.',
          403,
        );
      }
      throw error;
    }
  }

  private buildCapabilityContext(ctx: TenantContext, requestId: string): AuthorizedCapabilityContext {
    return {
      actorUserId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      role: ctx.role,
      clientScope: null,
      requestId: `outreach-v3-template:${requestId}`,
      surface: 'outreach',
    };
  }

  /**
   * Best-effort denial audit in its OWN transaction — the transaction that
   * hit the authorization error is about to roll back, so an insert made
   * inside it would be rolled back too. A logging failure here must never
   * mask the real error, hence the swallow.
   */
  private async auditDenied(
    ctx: TenantContext,
    action: 'create' | 'create_version' | 'publish' | 'update_metadata' | 'archive' | 'use',
    error: unknown,
    extra: { templateId?: string; scope?: OutreachTemplateScope },
  ): Promise<void> {
    if (!(error instanceof OutreachCommandError)) return;
    const deniedCodes = new Set([
      'OUTREACH_TEMPLATE_FORBIDDEN',
      'OUTREACH_TEMPLATE_NOT_FOUND',
      'OUTREACH_TEMPLATE_NOT_PUBLISHED',
      'OUTREACH_TEMPLATE_SCOPE_UNAUTHORIZED',
      'OUTREACH_TEMPLATE_SCOPE_UNSUPPORTED',
      'OUTREACH_TEMPLATE_SCOPE_MISMATCH',
      'OUTREACH_TEMPLATE_PUBLISH_UNAUTHORIZED',
    ]);
    if (!deniedCodes.has(error.code)) return;
    try {
      await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'denied',
          templateId: extra.templateId ?? null,
          scope: extra.scope ?? null,
          outcome: 'denied',
          reasonCode: error.code,
          safeMetadata: { attemptedAction: action },
        }),
      );
    } catch {
      // Audit logging must never mask the original authorization error.
    }
  }

  private verifyVersion(version: OutreachTemplateVersionRow) {
    const spec = parseOutreachTemplateSpecV1(version.templateSpecJsonb);
    if (hashOutreachTemplateSpecV1(spec) !== version.contentHash) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The stored template version hash does not match its content.',
        500,
        { version: version.versionNumber },
      );
    }
    return { ...version, spec, templateSpecJsonb: undefined };
  }
}
