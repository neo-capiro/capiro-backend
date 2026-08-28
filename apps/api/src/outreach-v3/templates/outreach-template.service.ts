import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StarterTemplateSeeder } from './starter-template-seeder.js';
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
  OutreachTemplateVariablesMissingError,
  parseOutreachTemplateSpecV1,
  substituteOutreachTemplateVariables,
  templateSpecFromCampaign,
  type OutreachTemplateDefaultsPolicyField,
  type OutreachTemplateScope,
  type OutreachTemplateSpecV1,
} from './outreach-template.contract.js';
import { compileOutreachTemplateBatch } from './outreach-template.compiler.js';
import {
  OutreachTemplateRepository,
  type OutreachTemplateRow,
  type OutreachTemplateSortKey,
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

export interface OutreachTemplateApplicationReceiptItem {
  field: string;
  label: string;
  detail: string | null;
}

/**
 * Durable application receipt (closeout runbook 5). Persisted verbatim on
 * `outreach_v3_template_applications.receipt_jsonb` so it can be shown again
 * later without recomputation — the append-only trigger on that table means
 * this can never drift from what actually happened at apply time.
 */
export interface OutreachTemplateApplicationReceipt {
  templateId: string;
  templateName: string;
  templateVersionId: string;
  templateVersionNumber: number;
  templateContentHash: string;
  inherited: OutreachTemplateApplicationReceiptItem[];
  refreshed: OutreachTemplateApplicationReceiptItem[];
  unresolved: OutreachTemplateApplicationReceiptItem[];
  unavailable: OutreachTemplateApplicationReceiptItem[];
  nextRequiredStep: string | null;
  requiresLiveTargets: boolean;
  requiresLiveContext: boolean;
}

const DEFAULTS_POLICY_FIELD_LABELS: Record<OutreachTemplateDefaultsPolicyField, string> = {
  goal: 'Goal',
  objective: 'Objective',
  topic: 'Topic',
  desiredOutcome: 'Desired outcome',
  ask: 'Ask',
  whyNow: 'Why now',
  sponsorScope: 'Sponsor scope',
  audience: 'Audience rule',
  delivery: 'Delivery pattern',
  personalization: 'Personalization',
  contextPolicy: 'Context policy',
  campaignAngle: 'Campaign angle',
  tone: 'Tone',
  length: 'Length',
  subjectStyle: 'Subject style',
  ctaStyle: 'Call-to-action style',
  senderPolicy: 'Sender policy',
  signaturePolicy: 'Signature policy',
  schedulingPolicy: 'Scheduling policy',
  attachmentPolicy: 'Attachment policy',
  followUpPolicy: 'Follow-up policy',
};

function truncate(value: string, max = 90): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** A short human preview of what a defaults-policy field currently holds, for the receipt only — never full prose. */
function previewDefaultsField(spec: OutreachTemplateSpecV1, field: OutreachTemplateDefaultsPolicyField): string | null {
  switch (field) {
    case 'goal': return spec.goal.goal ? truncate(spec.goal.goal) : null;
    case 'objective': return spec.goal.objective ? truncate(spec.goal.objective) : null;
    case 'topic': return spec.goal.topic;
    case 'desiredOutcome': return spec.goal.desiredOutcome ? truncate(spec.goal.desiredOutcome) : null;
    case 'ask': return spec.goal.ask.mode === 'explicit' ? truncate(spec.goal.ask.text ?? '') : spec.goal.ask.mode;
    case 'whyNow': return spec.goal.whyNow ? truncate(spec.goal.whyNow) : null;
    case 'sponsorScope': return spec.sponsor.kind;
    case 'delivery': return spec.delivery.pattern === 'undecided' ? null : spec.delivery.pattern;
    case 'personalization': return spec.delivery.personalization === 'undecided' ? null : spec.delivery.personalization;
    case 'campaignAngle': return spec.strategy.campaignAngle ? truncate(spec.strategy.campaignAngle) : null;
    case 'tone': return spec.strategy.tone;
    case 'length': return spec.strategy.length === 'undecided' ? null : spec.strategy.length;
    case 'audience':
      return spec.guidance.audienceRule ? truncate(spec.guidance.audienceRule) : null;
    case 'contextPolicy':
      return spec.guidance.contextPolicy ? truncate(spec.guidance.contextPolicy) : null;
    case 'subjectStyle':
      return spec.guidance.subjectStyle ? truncate(spec.guidance.subjectStyle) : null;
    case 'ctaStyle':
      return spec.guidance.ctaStyle ? truncate(spec.guidance.ctaStyle) : null;
    case 'senderPolicy':
      return spec.guidance.senderPolicy ? truncate(spec.guidance.senderPolicy) : null;
    case 'signaturePolicy':
      return spec.guidance.signaturePolicy ? truncate(spec.guidance.signaturePolicy) : null;
    case 'schedulingPolicy':
      return spec.guidance.schedulingPolicy ? truncate(spec.guidance.schedulingPolicy) : null;
    case 'attachmentPolicy':
      return spec.guidance.attachmentPolicy ? truncate(spec.guidance.attachmentPolicy) : null;
    case 'followUpPolicy':
      return spec.guidance.followUpPolicy ? truncate(spec.guidance.followUpPolicy) : null;
    default:
      return null;
  }
}

/**
 * What this application inherited, what it refreshed, and what still needs a
 * decision (closeout runbook 5/6.3). Targets and context are ALWAYS refreshed
 * — the template never carries a resolved recipient or an evidence body — so
 * they are unconditional entries, not derived from policy.
 */
function buildTemplateApplicationReceipt(
  template: OutreachTemplateRow,
  version: { id: string; versionNumber: number; contentHash: string },
  resolvedSpec: OutreachTemplateSpecV1,
  providedVariableValues: Record<string, string>,
): OutreachTemplateApplicationReceipt {
  const inherited: OutreachTemplateApplicationReceiptItem[] = [];
  const unresolved: OutreachTemplateApplicationReceiptItem[] = [];

  for (const [field, mode] of Object.entries(resolvedSpec.defaultsPolicy) as Array<
    [OutreachTemplateDefaultsPolicyField, string]
  >) {
    if (mode === 'not_applicable') continue;
    const label = DEFAULTS_POLICY_FIELD_LABELS[field];
    const preview = previewDefaultsField(resolvedSpec, field);
    if (mode === 'fixed' || mode === 'suggested') {
      if (preview) inherited.push({ field, label, detail: preview });
    } else {
      // ask_each_campaign / meri_determines_user_confirms / required_unresolved
      unresolved.push({ field, label, detail: preview });
    }
  }

  const refreshed: OutreachTemplateApplicationReceiptItem[] = [
    { field: 'targets', label: 'Recipients', detail: 'Resolved fresh under current directory and suppression rules.' },
    { field: 'context', label: 'Context & evidence', detail: 'Resolved fresh under current authorization and freshness rules.' },
  ];
  for (const variable of resolvedSpec.variables) {
    const wasProvided = Boolean(providedVariableValues[variable.key]?.trim());
    if (wasProvided) {
      refreshed.push({ field: `variable:${variable.key}`, label: variable.label, detail: 'Answered for this campaign.' });
    } else if (variable.defaultValue) {
      inherited.push({ field: `variable:${variable.key}`, label: variable.label, detail: truncate(variable.defaultValue) });
    }
  }
  if (resolvedSpec.guardrails.senderRequirement !== 'not_applicable') {
    refreshed.push({ field: 'sender', label: 'Sender', detail: 'Not carried over — this template requires choosing a current sender.' });
  }
  if (resolvedSpec.guardrails.attachmentRequirement === 'required') {
    refreshed.push({ field: 'attachments', label: 'Attachments', detail: 'Not carried over — a current attachment is required.' });
  }

  return {
    templateId: template.id,
    templateName: template.name,
    templateVersionId: version.id,
    templateVersionNumber: version.versionNumber,
    templateContentHash: version.contentHash,
    inherited,
    refreshed,
    unresolved,
    // Unavailable-source detection depends on live Directory/Context Plane
    // resolution, which happens later in Plan, not at template-apply time —
    // deliberately left empty here rather than guessed.
    unavailable: [],
    nextRequiredStep: !resolvedSpec.targeting.criteria ? 'targets' : unresolved.length ? 'plan' : 'targets',
    requiresLiveTargets: true,
    requiresLiveContext: true,
  };
}

interface TemplateMetadataInput {
  name: string;
  description?: string | null;
  campaignType?: string | null;
  scope: OutreachTemplateScope;
  clientId?: string | null;
}

function normalizeMetadata(input: TemplateMetadataInput) {
  const name = input.name?.trim();
  const description = input.description?.trim() || null;
  const campaignType = input.campaignType?.trim() || null;
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
  if (campaignType && campaignType.length > 60) {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_INVALID',
      'Campaign type exceeds the allowed length.',
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
  return { name, description, campaignType, scope: input.scope, clientId };
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
    private readonly starters: StarterTemplateSeeder,
  ) {}

  async list(
    ctx: TenantContext,
    input: {
      includeArchived?: boolean;
      clientId?: string | null;
      search?: string | null;
      campaignType?: string | null;
      mineOnly?: boolean;
      sort?: OutreachTemplateSortKey;
    } = {},
  ) {
    const clientId = input.clientId ?? null;
    if (clientId) await this.authorizeClient(ctx, clientId, 'list');
    /*
     * Seed the starter content templates on first read of this tenant's
     * library.
     *
     * There is no tenant-bootstrap hook in this codebase to hang seeding off,
     * and a migration-time backfill would cover existing tenants but not
     * future ones. Seeding lazily from the one read that every path into the
     * library goes through covers both, and `StarterTemplateSeeder` keeps the
     * steady-state cost at zero queries once a tenant is known-current.
     *
     * Deliberately awaited rather than fire-and-forget: a user opening the
     * library for the first time should SEE the starters, not find them on a
     * second refresh. It never throws — a seeding failure degrades to "the
     * library shows what already exists" rather than failing the read.
     */
    await this.starters.ensureSeeded(ctx.tenantId);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await this.templates.listVisible(tx, ctx, {
        includeArchived: input.includeArchived ?? false,
        clientId,
        search: input.search ?? null,
        campaignType: input.campaignType ?? null,
        ownerUserId: input.mineOnly ? ctx.userId : null,
        sort: input.sort,
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

  /**
   * Create a private draft with no source campaign at all (closeout runbook
   * 6.1, the wizard's "Create Template" entry point). Only `private` is
   * allowed at creation time — a from-scratch template has no source
   * session to derive a client/firm authority from, so widening scope must
   * go through the normal `updateMetadata()`/`assertSharedPublicationAuthority`
   * path afterward, exactly like any other governance action.
   */
  async createFromScratch(
    ctx: TenantContext,
    input: Omit<TemplateMetadataInput, 'scope' | 'clientId'> & { spec: unknown },
  ) {
    const metadata = normalizeMetadata({ ...input, scope: 'private', clientId: null });
    const spec = parseOutreachTemplateSpecV1(input.spec);
    const contentHash = hashOutreachTemplateSpecV1(spec);
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const created = await this.templates.createWithDraft(tx, ctx, {
          templateId: randomUUID(),
          versionId: randomUUID(),
          ...metadata,
          spec,
          contentHash,
          sourceSessionId: null,
          sourceStateVersion: null,
        });
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'create',
          templateId: created.template.id,
          templateVersionId: created.version.id,
          scope: created.template.scope,
          outcome: 'allowed',
          safeMetadata: { fromScratch: true },
        });
        return {
          template: created.template,
          version: this.verifyVersion(created.version),
          published: false,
        };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'create', error, { scope: 'private' });
      throw error;
    }
  }

  /**
   * Wizard edit of an existing draft (closeout runbook 6.17): draft content
   * is append-only, so an edit is always a NEW draft version, never an
   * in-place mutation — `createDraftVersion()` marks the old current draft
   * `superseded` automatically. A PUBLISHED template is untouched; only its
   * current draft pointer moves.
   */
  async replaceDraftContent(ctx: TenantContext, templateId: string, spec: unknown) {
    const parsed = parseOutreachTemplateSpecV1(spec);
    const contentHash = hashOutreachTemplateSpecV1(parsed);
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const template = await this.templates.lockManaged(tx, ctx, templateId);
        const version = await this.templates.createDraftVersion(tx, ctx, template, {
          versionId: randomUUID(),
          spec: parsed,
          contentHash,
          sourceSessionId: null,
          sourceStateVersion: null,
        });
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'create_version',
          templateId: template.id,
          templateVersionId: version.id,
          scope: template.scope,
          outcome: 'allowed',
          safeMetadata: { fromScratch: true },
        });
        return { templateId: template.id, version: this.verifyVersion(version), published: false };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'create_version', error, { templateId });
      throw error;
    }
  }

  /**
   * Copy a template the actor can already USE into a brand-new, independent
   * template/draft (closeout runbook 6.15). Never aliases the source's
   * published pointer — the copy has its own id, its own version 1 draft,
   * and its own lifecycle from that point forward. Scope only carries over
   * when the actor is independently authorized for it; otherwise the
   * duplicate is created private, the same safe default `createFromScratch`
   * uses, rather than silently escalating shared authority through a copy.
   */
  async duplicate(ctx: TenantContext, templateId: string, input: { clientId?: string | null }) {
    const clientId = input.clientId ?? null;
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const source = await this.templates.getVisible(tx, ctx, templateId, clientId);
        const capabilities = computeTemplateCapabilities(ctx, source);
        if (!capabilities.canDuplicate) {
          throw new OutreachCommandError(
            'OUTREACH_TEMPLATE_FORBIDDEN',
            'This template cannot be duplicated in its current state.',
            409,
          );
        }
        const sourceVersionId = capabilities.canInspect
          ? source.currentDraftVersionId ?? source.publishedVersionId
          : source.publishedVersionId;
        if (!sourceVersionId) {
          throw new OutreachCommandError(
            'OUTREACH_TEMPLATE_NOT_PUBLISHED',
            'This template has no content to duplicate yet.',
            409,
          );
        }
        const sourceVersion = this.verifyVersion(await this.templates.getVersion(tx, ctx, sourceVersionId));

        let scope: OutreachTemplateScope = 'private';
        let resolvedClientId: string | null = null;
        try {
          assertSharedPublicationAuthority(ctx, source.scope);
          scope = source.scope;
          resolvedClientId = source.clientId;
        } catch {
          // Not authorized to keep the shared scope — fall back to a
          // private copy rather than block duplication entirely.
        }

        const created = await this.templates.createWithDraft(tx, ctx, {
          templateId: randomUUID(),
          versionId: randomUUID(),
          name: `${source.name} (copy)`.slice(0, 160),
          description: source.description,
          campaignType: source.campaignType,
          scope,
          clientId: resolvedClientId,
          spec: sourceVersion.spec,
          contentHash: sourceVersion.contentHash,
          sourceSessionId: null,
          sourceStateVersion: null,
          duplicatedFromTemplateId: source.id,
          duplicatedFromVersionId: sourceVersion.id,
        });
        await this.templates.recordAudit(tx, ctx, {
          id: randomUUID(),
          action: 'duplicate',
          templateId: created.template.id,
          templateVersionId: created.version.id,
          scope: created.template.scope,
          outcome: 'allowed',
          safeMetadata: { duplicatedFromTemplateId: source.id },
        });
        return {
          template: created.template,
          version: this.verifyVersion(created.version),
          published: false,
        };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'duplicate', error, { templateId });
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
    input: {
      requestKey: string;
      title?: string | null;
      clientId?: string | null;
      variableValues?: Record<string, string>;
    },
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
    const variableValues = input.variableValues ?? {};

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
          variableValues,
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
            receipt: existing.receiptJsonb,
          };
        }

        let resolvedSpec: OutreachTemplateSpecV1;
        try {
          resolvedSpec = substituteOutreachTemplateVariables(verified.spec, variableValues);
        } catch (error) {
          if (error instanceof OutreachTemplateVariablesMissingError) {
            throw new OutreachCommandError(
              'OUTREACH_TEMPLATE_VARIABLE_REQUIRED',
              `This template needs an answer for: ${error.keys.join(', ')}.`,
              422,
              { keys: error.keys.join(',') },
            );
          }
          throw error;
        }
        const receipt = buildTemplateApplicationReceipt(template, verified, resolvedSpec, variableValues);

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
          spec: resolvedSpec,
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
          receipt,
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
          receipt: replayed ? application.receiptJsonb : receipt,
        };
      });
    } catch (error) {
      await this.auditDenied(ctx, 'use', error, { templateId });
      throw error;
    }
  }

  /**
   * Looks up whether a session was created from a template, for the "From
   * template · name · vN" marker and receipt panel (closeout runbook 7.6/
   * 7.7). Returns null for an ordinary session — that is the normal case,
   * not an error.
   */
  async getProvenance(ctx: TenantContext, sessionId: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.templates.getProvenanceForSession(tx, ctx, sessionId),
    );
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
    action: 'create' | 'create_version' | 'publish' | 'update_metadata' | 'archive' | 'use' | 'duplicate',
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
