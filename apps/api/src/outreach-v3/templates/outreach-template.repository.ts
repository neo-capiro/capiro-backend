import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { OutreachTemplateScope, OutreachTemplateSpecV1 } from './outreach-template.contract.js';

export interface OutreachTemplateRow {
  id: string;
  tenantId: string;
  ownerUserId: string;
  clientId: string | null;
  scope: OutreachTemplateScope;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  currentDraftVersionId: string | null;
  publishedVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface OutreachTemplateVersionRow {
  id: string;
  tenantId: string;
  templateId: string;
  versionNumber: number;
  lifecycle: 'draft' | 'published';
  templateSpecJsonb: unknown;
  contentHash: string;
  sourceSessionId: string | null;
  sourceStateVersion: number | null;
  createdByUserId: string;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface OutreachTemplateListRow extends OutreachTemplateRow {
  draftVersionNumber: number | null;
  publishedVersionNumber: number | null;
  previewSpecJsonb: unknown | null;
}

export interface OutreachTemplateApplicationRow {
  id: string;
  templateId: string;
  templateVersionId: string;
  sessionId: string;
  requestKey: string;
  templateContentHash: string;
  resultingStateVersion: number;
  createdAt: Date;
}

function templateNotFound(): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_TEMPLATE_NOT_FOUND',
    'The requested outreach template was not found.',
    404,
  );
}

@Injectable()
export class OutreachTemplateRepository {
  async listVisible(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: { includeArchived: boolean; clientId: string | null },
  ): Promise<OutreachTemplateListRow[]> {
    const clientId = input.clientId ?? '';
    return tx.$queryRaw<OutreachTemplateListRow[]>`
      SELECT
        t.id,
        t.tenant_id AS "tenantId",
        t.owner_user_id AS "ownerUserId",
        t.client_id AS "clientId",
        t.scope,
        t.name,
        t.description,
        t.status,
        t.current_draft_version_id AS "currentDraftVersionId",
        t.published_version_id AS "publishedVersionId",
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt",
        t.archived_at AS "archivedAt",
        draft.version_number AS "draftVersionNumber",
        published.version_number AS "publishedVersionNumber",
        COALESCE(published.template_spec_jsonb, draft.template_spec_jsonb) AS "previewSpecJsonb"
      FROM outreach_v3_templates t
      LEFT JOIN outreach_v3_template_versions draft
        ON draft.id = t.current_draft_version_id
       AND draft.tenant_id = t.tenant_id
      LEFT JOIN outreach_v3_template_versions published
        ON published.id = t.published_version_id
       AND published.tenant_id = t.tenant_id
      WHERE t.tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND (${input.includeArchived} OR t.status = 'active')
        AND (
          t.scope <> 'client'
          OR (
            ${clientId} <> ''
            AND t.client_id = CAST(NULLIF(${clientId}, '') AS uuid)
          )
        )
      ORDER BY t.updated_at DESC, t.id
      LIMIT 200
    `;
  }

  async getVisible(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    templateId: string,
    clientId: string | null,
  ): Promise<OutreachTemplateRow> {
    const requestedClientId = clientId ?? '';
    const rows = await tx.$queryRaw<OutreachTemplateRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        owner_user_id AS "ownerUserId",
        client_id AS "clientId",
        scope,
        name,
        description,
        status,
        current_draft_version_id AS "currentDraftVersionId",
        published_version_id AS "publishedVersionId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM outreach_v3_templates
      WHERE id = CAST(${templateId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND (
          scope = 'firm'
          OR owner_user_id = CAST(${ctx.userId} AS uuid)
          OR (
            scope = 'client'
            AND ${requestedClientId} <> ''
            AND client_id = CAST(NULLIF(${requestedClientId}, '') AS uuid)
          )
        )
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw templateNotFound();
    return row;
  }

  async lockOwned(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    templateId: string,
  ): Promise<OutreachTemplateRow> {
    const rows = await tx.$queryRaw<OutreachTemplateRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        owner_user_id AS "ownerUserId",
        client_id AS "clientId",
        scope,
        name,
        description,
        status,
        current_draft_version_id AS "currentDraftVersionId",
        published_version_id AS "publishedVersionId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM outreach_v3_templates
      WHERE id = CAST(${templateId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND owner_user_id = CAST(${ctx.userId} AS uuid)
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw templateNotFound();
    return row;
  }

  async listVersions(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    templateId: string,
  ): Promise<OutreachTemplateVersionRow[]> {
    return tx.$queryRaw<OutreachTemplateVersionRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        template_id AS "templateId",
        version_number AS "versionNumber",
        lifecycle,
        template_spec_jsonb AS "templateSpecJsonb",
        content_hash AS "contentHash",
        source_session_id AS "sourceSessionId",
        source_state_version AS "sourceStateVersion",
        created_by_user_id AS "createdByUserId",
        created_at AS "createdAt",
        published_at AS "publishedAt"
      FROM outreach_v3_template_versions
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND template_id = CAST(${templateId} AS uuid)
      ORDER BY version_number DESC
      LIMIT 100
    `;
  }

  async getVersion(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    versionId: string,
  ): Promise<OutreachTemplateVersionRow> {
    const rows = await tx.$queryRaw<OutreachTemplateVersionRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        template_id AS "templateId",
        version_number AS "versionNumber",
        lifecycle,
        template_spec_jsonb AS "templateSpecJsonb",
        content_hash AS "contentHash",
        source_session_id AS "sourceSessionId",
        source_state_version AS "sourceStateVersion",
        created_by_user_id AS "createdByUserId",
        created_at AS "createdAt",
        published_at AS "publishedAt"
      FROM outreach_v3_template_versions
      WHERE id = CAST(${versionId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw templateNotFound();
    return row;
  }

  async createWithDraft(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      templateId: string;
      versionId: string;
      name: string;
      description: string | null;
      scope: OutreachTemplateScope;
      clientId: string | null;
      spec: OutreachTemplateSpecV1;
      contentHash: string;
      sourceSessionId: string;
      sourceStateVersion: number;
    },
  ): Promise<{ template: OutreachTemplateRow; version: OutreachTemplateVersionRow }> {
    const specJson = JSON.stringify(input.spec);
    const templates = await tx.$queryRaw<OutreachTemplateRow[]>`
      INSERT INTO outreach_v3_templates (
        id, tenant_id, owner_user_id, client_id, scope, name, description,
        status, current_draft_version_id, published_version_id
      ) VALUES (
        CAST(${input.templateId} AS uuid), CAST(${ctx.tenantId} AS uuid),
        CAST(${ctx.userId} AS uuid), CAST(${input.clientId} AS uuid), ${input.scope},
        ${input.name}, ${input.description}, 'active', NULL, NULL
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        owner_user_id AS "ownerUserId",
        client_id AS "clientId",
        scope,
        name,
        description,
        status,
        current_draft_version_id AS "currentDraftVersionId",
        published_version_id AS "publishedVersionId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
    `;
    const template = templates[0];
    if (!template) throw new Error('OUTREACH_TEMPLATE_CREATE_FAILED');

    const versions = await tx.$queryRaw<OutreachTemplateVersionRow[]>`
      INSERT INTO outreach_v3_template_versions (
        id, tenant_id, template_id, version_number, lifecycle,
        template_spec_jsonb, content_hash, source_session_id,
        source_state_version, created_by_user_id
      ) VALUES (
        CAST(${input.versionId} AS uuid), CAST(${ctx.tenantId} AS uuid),
        CAST(${input.templateId} AS uuid), 1, 'draft', CAST(${specJson} AS jsonb),
        ${input.contentHash}, CAST(${input.sourceSessionId} AS uuid),
        ${input.sourceStateVersion}, CAST(${ctx.userId} AS uuid)
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        template_id AS "templateId",
        version_number AS "versionNumber",
        lifecycle,
        template_spec_jsonb AS "templateSpecJsonb",
        content_hash AS "contentHash",
        source_session_id AS "sourceSessionId",
        source_state_version AS "sourceStateVersion",
        created_by_user_id AS "createdByUserId",
        created_at AS "createdAt",
        published_at AS "publishedAt"
    `;
    const version = versions[0];
    if (!version) throw new Error('OUTREACH_TEMPLATE_VERSION_CREATE_FAILED');

    await tx.$executeRaw`
      UPDATE outreach_v3_templates
      SET current_draft_version_id = CAST(${version.id} AS uuid), updated_at = NOW()
      WHERE id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
    `;
    return {
      template: { ...template, currentDraftVersionId: version.id },
      version,
    };
  }

  async createDraftVersion(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    template: OutreachTemplateRow,
    input: {
      versionId: string;
      spec: OutreachTemplateSpecV1;
      contentHash: string;
      sourceSessionId: string;
      sourceStateVersion: number;
    },
  ): Promise<OutreachTemplateVersionRow> {
    if (template.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_TEMPLATE_FORBIDDEN',
        'Archived templates cannot receive new versions.',
        409,
      );
    }
    const numbers = await tx.$queryRaw<Array<{ nextVersion: number }>>`
      SELECT COALESCE(MAX(version_number), 0)::integer + 1 AS "nextVersion"
      FROM outreach_v3_template_versions
      WHERE template_id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
    `;
    const versionNumber = numbers[0]?.nextVersion ?? 1;
    const specJson = JSON.stringify(input.spec);
    const rows = await tx.$queryRaw<OutreachTemplateVersionRow[]>`
      INSERT INTO outreach_v3_template_versions (
        id, tenant_id, template_id, version_number, lifecycle,
        template_spec_jsonb, content_hash, source_session_id,
        source_state_version, created_by_user_id
      ) VALUES (
        CAST(${input.versionId} AS uuid), CAST(${ctx.tenantId} AS uuid),
        CAST(${template.id} AS uuid), ${versionNumber}, 'draft',
        CAST(${specJson} AS jsonb), ${input.contentHash},
        CAST(${input.sourceSessionId} AS uuid), ${input.sourceStateVersion},
        CAST(${ctx.userId} AS uuid)
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        template_id AS "templateId",
        version_number AS "versionNumber",
        lifecycle,
        template_spec_jsonb AS "templateSpecJsonb",
        content_hash AS "contentHash",
        source_session_id AS "sourceSessionId",
        source_state_version AS "sourceStateVersion",
        created_by_user_id AS "createdByUserId",
        created_at AS "createdAt",
        published_at AS "publishedAt"
    `;
    const version = rows[0];
    if (!version) throw new Error('OUTREACH_TEMPLATE_VERSION_CREATE_FAILED');
    await tx.$executeRaw`
      UPDATE outreach_v3_templates
      SET current_draft_version_id = CAST(${version.id} AS uuid), updated_at = NOW()
      WHERE id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
    `;
    return version;
  }

  async publishDraft(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    template: OutreachTemplateRow,
  ): Promise<OutreachTemplateVersionRow> {
    if (!template.currentDraftVersionId) {
      throw new OutreachCommandError(
        'OUTREACH_TEMPLATE_VERSION_IMMUTABLE',
        'This template has no draft version to publish.',
        409,
      );
    }
    const rows = await tx.$queryRaw<OutreachTemplateVersionRow[]>`
      UPDATE outreach_v3_template_versions
      SET lifecycle = 'published', published_at = NOW()
      WHERE id = CAST(${template.currentDraftVersionId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND template_id = CAST(${template.id} AS uuid)
        AND lifecycle = 'draft'
      RETURNING
        id,
        tenant_id AS "tenantId",
        template_id AS "templateId",
        version_number AS "versionNumber",
        lifecycle,
        template_spec_jsonb AS "templateSpecJsonb",
        content_hash AS "contentHash",
        source_session_id AS "sourceSessionId",
        source_state_version AS "sourceStateVersion",
        created_by_user_id AS "createdByUserId",
        created_at AS "createdAt",
        published_at AS "publishedAt"
    `;
    const version = rows[0];
    if (!version) {
      throw new OutreachCommandError(
        'OUTREACH_TEMPLATE_VERSION_IMMUTABLE',
        'The draft version changed before it could be published.',
        409,
      );
    }
    await tx.$executeRaw`
      UPDATE outreach_v3_templates
      SET published_version_id = CAST(${version.id} AS uuid),
          current_draft_version_id = NULL,
          updated_at = NOW()
      WHERE id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
    `;
    return version;
  }

  async updateMetadata(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    template: OutreachTemplateRow,
    input: { name: string; description: string | null; scope: OutreachTemplateScope; clientId: string | null },
  ): Promise<OutreachTemplateRow> {
    const rows = await tx.$queryRaw<OutreachTemplateRow[]>`
      UPDATE outreach_v3_templates
      SET name = ${input.name},
          description = ${input.description},
          scope = ${input.scope},
          client_id = CAST(${input.clientId} AS uuid),
          updated_at = NOW()
      WHERE id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND owner_user_id = CAST(${ctx.userId} AS uuid)
      RETURNING
        id,
        tenant_id AS "tenantId",
        owner_user_id AS "ownerUserId",
        client_id AS "clientId",
        scope,
        name,
        description,
        status,
        current_draft_version_id AS "currentDraftVersionId",
        published_version_id AS "publishedVersionId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
    `;
    const row = rows[0];
    if (!row) throw templateNotFound();
    return row;
  }

  async archive(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    template: OutreachTemplateRow,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE outreach_v3_templates
      SET status = 'archived', archived_at = NOW(), updated_at = NOW()
      WHERE id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND owner_user_id = CAST(${ctx.userId} AS uuid)
    `;
  }

  async findApplicationByRequestKey(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    requestKey: string,
  ): Promise<OutreachTemplateApplicationRow | null> {
    const rows = await tx.$queryRaw<OutreachTemplateApplicationRow[]>`
      SELECT
        id,
        template_id AS "templateId",
        template_version_id AS "templateVersionId",
        session_id AS "sessionId",
        request_key AS "requestKey",
        template_content_hash AS "templateContentHash",
        resulting_state_version AS "resultingStateVersion",
        created_at AS "createdAt"
      FROM outreach_v3_template_applications
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND applied_by_user_id = CAST(${ctx.userId} AS uuid)
        AND request_key = CAST(${requestKey} AS uuid)
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async recordApplication(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      applicationId: string;
      template: OutreachTemplateRow;
      version: OutreachTemplateVersionRow;
      sessionId: string;
      requestKey: string;
      commandBatch: unknown;
      resultingStateVersion: number;
    },
  ): Promise<OutreachTemplateApplicationRow> {
    const commandBatchJson = JSON.stringify(input.commandBatch);
    const rows = await tx.$queryRaw<OutreachTemplateApplicationRow[]>`
      INSERT INTO outreach_v3_template_applications (
        id, tenant_id, template_id, template_version_id, session_id,
        applied_by_user_id, request_key, command_batch_jsonb,
        template_content_hash, resulting_state_version
      ) VALUES (
        CAST(${input.applicationId} AS uuid), CAST(${ctx.tenantId} AS uuid),
        CAST(${input.template.id} AS uuid), CAST(${input.version.id} AS uuid),
        CAST(${input.sessionId} AS uuid), CAST(${ctx.userId} AS uuid),
        CAST(${input.requestKey} AS uuid), CAST(${commandBatchJson} AS jsonb),
        ${input.version.contentHash}, ${input.resultingStateVersion}
      )
      RETURNING
        id,
        template_id AS "templateId",
        template_version_id AS "templateVersionId",
        session_id AS "sessionId",
        request_key AS "requestKey",
        template_content_hash AS "templateContentHash",
        resulting_state_version AS "resultingStateVersion",
        created_at AS "createdAt"
    `;
    const application = rows[0];
    if (!application) throw new Error('OUTREACH_TEMPLATE_APPLICATION_CREATE_FAILED');
    await tx.$executeRaw`
      INSERT INTO outreach_v3_session_template_provenance (
        session_id, tenant_id, template_id, template_version_id,
        application_id, applied_by_user_id
      ) VALUES (
        CAST(${input.sessionId} AS uuid), CAST(${ctx.tenantId} AS uuid),
        CAST(${input.template.id} AS uuid), CAST(${input.version.id} AS uuid),
        CAST(${application.id} AS uuid), CAST(${ctx.userId} AS uuid)
      )
    `;
    return application;
  }
}
