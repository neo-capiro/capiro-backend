import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
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
  type OutreachTemplateVersionRow,
} from './outreach-template.repository.js';

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
  ) {}

  async list(
    ctx: TenantContext,
    input: { includeArchived?: boolean; clientId?: string | null } = {},
  ) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await this.templates.listVisible(tx, ctx, {
        includeArchived: input.includeArchived ?? false,
        clientId: input.clientId ?? null,
      });
      return rows.map((row) => ({
        ...row,
        previewSpec: row.previewSpecJsonb
          ? parseOutreachTemplateSpecV1(row.previewSpecJsonb)
          : null,
        previewSpecJsonb: undefined,
      }));
    });
  }

  async get(ctx: TenantContext, templateId: string, clientId?: string | null) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const template = await this.templates.getVisible(tx, ctx, templateId, clientId ?? null);
      const versions = await this.templates.listVersions(tx, ctx, template.id);
      return {
        template,
        versions: versions.map((version) => this.verifyVersion(version)),
      };
    });
  }

  async createFromSession(
    ctx: TenantContext,
    input: TemplateMetadataInput & { sessionId: string },
  ) {
    const metadata = normalizeMetadata(input);
    const source = await this.sessions.getSession(ctx, input.sessionId);
    const spec = templateSpecFromCampaign(source.spec);
    const contentHash = hashOutreachTemplateSpecV1(spec);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const created = await this.templates.createWithDraft(tx, ctx, {
        templateId: randomUUID(),
        versionId: randomUUID(),
        ...metadata,
        spec,
        contentHash,
        sourceSessionId: source.session.id,
        sourceStateVersion: source.currentStateVersion,
      });
      return {
        template: created.template,
        version: this.verifyVersion(created.version),
        published: false,
      };
    });
  }

  async createVersionFromSession(
    ctx: TenantContext,
    templateId: string,
    input: { sessionId: string },
  ) {
    const source = await this.sessions.getSession(ctx, input.sessionId);
    const spec = templateSpecFromCampaign(source.spec);
    const contentHash = hashOutreachTemplateSpecV1(spec);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const template = await this.templates.lockOwned(tx, ctx, templateId);
      const version = await this.templates.createDraftVersion(tx, ctx, template, {
        versionId: randomUUID(),
        spec,
        contentHash,
        sourceSessionId: source.session.id,
        sourceStateVersion: source.currentStateVersion,
      });
      return {
        templateId: template.id,
        version: this.verifyVersion(version),
        published: false,
      };
    });
  }

  async publish(ctx: TenantContext, templateId: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const template = await this.templates.lockOwned(tx, ctx, templateId);
      const version = await this.templates.publishDraft(tx, ctx, template);
      return {
        templateId: template.id,
        version: this.verifyVersion(version),
        published: true,
      };
    });
  }

  async updateMetadata(
    ctx: TenantContext,
    templateId: string,
    input: TemplateMetadataInput,
  ) {
    const metadata = normalizeMetadata(input);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const template = await this.templates.lockOwned(tx, ctx, templateId);
      return this.templates.updateMetadata(tx, ctx, template, metadata);
    });
  }

  async archive(ctx: TenantContext, templateId: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const template = await this.templates.lockOwned(tx, ctx, templateId);
      await this.templates.archive(tx, ctx, template);
      return { id: template.id, status: 'archived' as const };
    });
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

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const replay = await this.templates.findApplicationByRequestKey(tx, ctx, input.requestKey);
      if (replay) {
        if (replay.templateId !== templateId) {
          throw new OutreachCommandError(
            'OUTREACH_TEMPLATE_REQUEST_REUSE',
            'This template request key was already used for a different template.',
            409,
          );
        }
        return {
          sessionId: replay.sessionId,
          stateVersion: replay.resultingStateVersion,
          templateId: replay.templateId,
          templateVersionId: replay.templateVersionId,
          replayed: true,
        };
      }

      const template = await this.templates.getVisible(
        tx,
        ctx,
        templateId,
        input.clientId ?? null,
      );
      if (template.status !== 'active') {
        throw new OutreachCommandError(
          'OUTREACH_TEMPLATE_FORBIDDEN',
          'Archived templates cannot start new campaigns.',
          409,
        );
      }
      if (
        template.scope === 'client' &&
        (!input.clientId || template.clientId !== input.clientId)
      ) {
        throw new OutreachCommandError(
          'OUTREACH_TEMPLATE_FORBIDDEN',
          'This template is available only inside its client scope.',
          403,
        );
      }
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
        clientId: input.clientId ?? null,
      });
      const batch = this.commands.parseNormalizeAndValidateBatch(rawBatch);
      const result = await this.commands.applyBatchWithinTx(
        tx,
        ctx,
        session.id,
        batch,
        { source: 'user_control', prelockedSession: session },
      );
      const application = await this.templates.recordApplication(tx, ctx, {
        applicationId: randomUUID(),
        template,
        version,
        sessionId: session.id,
        requestKey: input.requestKey,
        commandBatch: batch,
        resultingStateVersion: result.stateVersion,
      });
      return {
        sessionId: session.id,
        stateVersion: result.stateVersion,
        templateId: template.id,
        templateVersionId: version.id,
        applicationId: application.id,
        replayed: false,
        requiresLiveTargets: true,
        requiresLiveContext: true,
      };
    });
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
