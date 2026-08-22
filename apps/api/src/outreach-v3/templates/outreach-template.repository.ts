import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isTenantAdmin, type TenantContext } from '@capiro/shared';
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
  requestFingerprint: string;
  templateContentHash: string;
  resultingStateVersion: number;
  createdAt: Date;
}

/** Postgres unique_violation. Used to detect and replay a losing idempotent race. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; meta?: { code?: unknown } } | null)?.code;
  if (code === UNIQUE_VIOLATION || code === 'P2002') return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes(UNIQUE_VIOLATION) || message.includes('outreach_v3_template_applications');
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
  /**
   * Visibility rule (closeout runbook 3.2 / 3.5):
   *  - private templates: owner only, regardless of RLS (capiro_app bypasses
   *    RLS, so this predicate — not the migration's policy — is the real
   *    boundary for this app connection);
   *  - firm/client templates: visible to any tenant user (client-scoped ones
   *    are additionally client-filtered below), but a DRAFT-ONLY shared
   *    template (no published_version_id yet) is hidden from everyone except
   *    its owner or a tenant admin — an ordinary reader has nothing safe to
   *    see there yet.
   * Client-level authorization (grants/ethical walls) is enforced separately
   * by the service via CapabilityAuthorizationService before/around this
   * call; a client_id match here is identity, not authorization.
   */
  async listVisible(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: { includeArchived: boolean; clientId: string | null },
  ): Promise<OutreachTemplateListRow[]> {
    const clientId = input.clientId ?? '';
    const isAdmin = isTenantAdmin(ctx.role);
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
        CASE
          WHEN t.owner_user_id = CAST(${ctx.userId} AS uuid) OR ${isAdmin}
            THEN COALESCE(published.template_spec_jsonb, draft.template_spec_jsonb)
          ELSE published.template_spec_jsonb
        END AS "previewSpecJsonb"
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
          t.scope <> 'private'
          OR t.owner_user_id = CAST(${ctx.userId} AS uuid)
        )
        AND (
          t.owner_user_id = CAST(${ctx.userId} AS uuid)
          OR ${isAdmin}
          OR t.published_version_id IS NOT NULL
        )
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

  /**
   * Same owner-only-private / draft-hidden-from-non-managers rule as
   * listVisible(). `clientId` is the CALLER's asserted current client, used
   * only to decide whether a client-scoped template is even in scope for
   * this request — it is not authorization (see class doc above).
   */
  async getVisible(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    templateId: string,
    clientId: string | null,
  ): Promise<OutreachTemplateRow> {
    const requestedClientId = clientId ?? '';
    const isAdmin = isTenantAdmin(ctx.role);
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
          scope = 'private'
          OR owner_user_id = CAST(${ctx.userId} AS uuid)
          OR ${isAdmin}
          OR published_version_id IS NOT NULL
        )
        AND (
          scope <> 'private'
          OR owner_user_id = CAST(${ctx.userId} AS uuid)
        )
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

  /**
   * Locks a template row for a mutating operation (version/publish/metadata/
   * archive). The owner may always manage their own template. A tenant admin
   * may additionally manage a FIRM or CLIENT (i.e. shared, non-private)
   * template — private templates remain owner-only even for admins, so an
   * admin cannot reach into another user's private draft (closeout runbook
   * 3.4: "Firm/client publication requires an authorized administrator").
   */
  async lockManaged(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    templateId: string,
  ): Promise<OutreachTemplateRow> {
    const isAdmin = isTenantAdmin(ctx.role);
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
          owner_user_id = CAST(${ctx.userId} AS uuid)
          OR (${isAdmin} AND scope <> 'private')
        )
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw templateNotFound();
    return row;
  }

  /**
   * `onlyPublished` must be true for any caller who is not the owner or an
   * admin (closeout runbook 3.5: "Ordinary authorized user: may see only the
   * current published version and safe card metadata" — draft rows, their
   * IDs, and full history are owner/admin-only).
   */
  async listVersions(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    templateId: string,
    onlyPublished: boolean,
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
        AND (${onlyPublished} = false OR lifecycle = 'published')
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
    // `template` was already fetched+authorized by lockManaged() in this same
    // transaction; this WHERE re-applies the identical owner-or-admin-on-shared
    // predicate (against the row's CURRENT scope) rather than trusting the
    // earlier read alone.
    const isAdmin = isTenantAdmin(ctx.role);
    const rows = await tx.$queryRaw<OutreachTemplateRow[]>`
      UPDATE outreach_v3_templates
      SET name = ${input.name},
          description = ${input.description},
          scope = ${input.scope},
          client_id = CAST(${input.clientId} AS uuid),
          updated_at = NOW()
      WHERE id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND (
          owner_user_id = CAST(${ctx.userId} AS uuid)
          OR (${isAdmin} AND scope <> 'private')
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
    const row = rows[0];
    if (!row) throw templateNotFound();
    return row;
  }

  async archive(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    template: OutreachTemplateRow,
  ): Promise<void> {
    const isAdmin = isTenantAdmin(ctx.role);
    await tx.$executeRaw`
      UPDATE outreach_v3_templates
      SET status = 'archived', archived_at = NOW(), updated_at = NOW()
      WHERE id = CAST(${template.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND (
          owner_user_id = CAST(${ctx.userId} AS uuid)
          OR (${isAdmin} AND scope <> 'private')
        )
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
        request_fingerprint AS "requestFingerprint",
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

  /**
   * Inserts the application + its session provenance row. If a CONCURRENT
   * call already committed the same (tenant, actor, request_key) — the
   * "losing" side of an idempotent race — the unique constraint on
   * outreach_v3_template_applications raises 23505 here rather than letting
   * a duplicate campaign through. That violation is caught and converted into
   * a lookup of the winner so the loser can replay it instead of surfacing a
   * raw database error (closeout runbook 3.8).
   */
  async recordApplication(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      applicationId: string;
      template: OutreachTemplateRow;
      version: OutreachTemplateVersionRow;
      sessionId: string;
      requestKey: string;
      requestFingerprint: string;
      commandBatch: unknown;
      resultingStateVersion: number;
    },
  ): Promise<{ application: OutreachTemplateApplicationRow; replayed: boolean }> {
    const commandBatchJson = JSON.stringify(input.commandBatch);
    let application: OutreachTemplateApplicationRow | undefined;
    try {
      const rows = await tx.$queryRaw<OutreachTemplateApplicationRow[]>`
        INSERT INTO outreach_v3_template_applications (
          id, tenant_id, template_id, template_version_id, session_id,
          applied_by_user_id, request_key, request_fingerprint, command_batch_jsonb,
          template_content_hash, resulting_state_version
        ) VALUES (
          CAST(${input.applicationId} AS uuid), CAST(${ctx.tenantId} AS uuid),
          CAST(${input.template.id} AS uuid), CAST(${input.version.id} AS uuid),
          CAST(${input.sessionId} AS uuid), CAST(${ctx.userId} AS uuid),
          CAST(${input.requestKey} AS uuid), ${input.requestFingerprint}, CAST(${commandBatchJson} AS jsonb),
          ${input.version.contentHash}, ${input.resultingStateVersion}
        )
        RETURNING
          id,
          template_id AS "templateId",
          template_version_id AS "templateVersionId",
          session_id AS "sessionId",
          request_key AS "requestKey",
          request_fingerprint AS "requestFingerprint",
          template_content_hash AS "templateContentHash",
          resulting_state_version AS "resultingStateVersion",
          created_at AS "createdAt"
      `;
      application = rows[0];
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findApplicationByRequestKey(tx, ctx, input.requestKey);
      if (!winner) throw error;
      if (winner.requestFingerprint !== input.requestFingerprint) {
        throw new OutreachCommandError(
          'OUTREACH_TEMPLATE_REQUEST_REUSE',
          'This template request key was already used for a different request.',
          409,
        );
      }
      return { application: winner, replayed: true };
    }
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
    return { application, replayed: false };
  }

  /**
   * Append-only, safe-metadata-only audit row (closeout runbook 3.7). Never
   * pass confidential spec content (goal text, style samples, campaign angle,
   * etc.) as `safeMetadata` — identifiers, scope, and outcome only.
   */
  async recordAudit(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      id: string;
      action:
        | 'create'
        | 'create_version'
        | 'publish'
        | 'update_metadata'
        | 'archive'
        | 'restore'
        | 'duplicate'
        | 'use'
        | 'denied';
      templateId?: string | null;
      templateVersionId?: string | null;
      scope?: OutreachTemplateScope | null;
      outcome: 'allowed' | 'denied';
      reasonCode?: string | null;
      safeMetadata?: Record<string, string | number | boolean | null>;
    },
  ): Promise<void> {
    const metadataJson = JSON.stringify(input.safeMetadata ?? {});
    await tx.$executeRaw`
      INSERT INTO outreach_v3_template_audit_log (
        id, tenant_id, actor_user_id, action, template_id, template_version_id,
        scope, outcome, reason_code, safe_metadata
      ) VALUES (
        CAST(${input.id} AS uuid), CAST(${ctx.tenantId} AS uuid), CAST(${ctx.userId} AS uuid),
        ${input.action}, CAST(${input.templateId ?? null} AS uuid), CAST(${input.templateVersionId ?? null} AS uuid),
        ${input.scope ?? null}, ${input.outcome}, ${input.reasonCode ?? null}, CAST(${metadataJson} AS jsonb)
      )
    `;
  }
}
