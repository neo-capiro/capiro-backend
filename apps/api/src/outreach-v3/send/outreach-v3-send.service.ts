import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { AttachmentContentService } from '../../engagement/attachment-content.service.js';
import { AttachmentScannerService } from '../../engagement/attachment-scanner.service.js';
import {
  OutreachDraftService,
  type OutreachDraftArtifactDto,
} from '../../engagement/outreach-draft.service.js';
import {
  OutreachSendIntentService,
  type OutreachSendIntentView,
} from '../../engagement/outreach-send-intent.service.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachUserDecisionEventService } from '../services/outreach-user-decision-event.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachV3DraftApprovalService } from '../drafts/outreach-v3-draft-approval.service.js';
import { OutreachV3GenerationService } from '../generation/outreach-v3-generation.service.js';
import type { OutreachV3GenerationPlan } from '../generation/outreach-v3-generation-plan.js';
import {
  emailsFromRecipientSnapshot,
  evaluateOutreachV3Preflight,
  type OutreachV3PreflightDraft,
} from '../preflight/outreach-v3-preflight.js';

const SETTINGS_SCHEMA_VERSION = 'outreach_v3_send_settings_v1' as const;
const SETTINGS_EVENT = 'send_settings_updated' as const;

export interface OutreachV3SendSettingsInput {
  senderConnectionId: string;
  appendSignature: boolean;
  attachmentIds: string[];
}

export interface OutreachV3SendSettings extends OutreachV3SendSettingsInput {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  settingsHash: string;
  stateVersion: number;
  updatedAt: string;
}

export interface OutreachV3PreflightRequest {
  excludedGenerationKeys?: string[];
  testGenerationKey?: string | null;
  acknowledgeHeldOut?: boolean;
}

export type OutreachV3CheckState = 'pass' | 'review' | 'blocked';

export interface OutreachV3NamedPreflightCheck {
  key: string;
  label: string;
  detail: string;
  state: OutreachV3CheckState;
}

export interface OutreachV3ServerPreflight {
  eligible: boolean;
  testMode: boolean;
  blockers: string[];
  checks: OutreachV3NamedPreflightCheck[];
  draftVersionIds: string[];
  excludedGenerationKeys: string[];
  heldOutAcknowledged: boolean;
  plan: OutreachV3GenerationPlan;
  settings: OutreachV3SendSettings | null;
  draftResults: ReturnType<typeof evaluateOutreachV3Preflight>['draftResults'];
}

@Injectable()
export class OutreachV3SendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    private readonly sessions: OutreachSessionService,
    private readonly generation: OutreachV3GenerationService,
    private readonly drafts: OutreachDraftService,
    private readonly approvals: OutreachV3DraftApprovalService,
    private readonly decisions: OutreachUserDecisionEventService,
    private readonly sendIntents: OutreachSendIntentService,
    private readonly attachmentContent: AttachmentContentService,
    private readonly attachmentScanner: AttachmentScannerService,
  ) {}

  async getSettings(ctx: TenantContext, sessionId: string): Promise<OutreachV3SendSettings | null> {
    await this.sessions.getSession(ctx, sessionId);
    return (await this.latestSettingsEvent(ctx, sessionId))?.settings ?? null;
  }

  async saveSettings(
    ctx: TenantContext,
    sessionId: string,
    input: OutreachV3SendSettingsInput,
  ): Promise<{
    settings: OutreachV3SendSettings;
    idempotent: boolean;
    invalidatedDraftVersionIds: string[];
    invalidationFailures: string[];
  }> {
    const current = await this.sessions.getSession(ctx, sessionId);
    const normalized = normalizeSettingsInput(input);
    await this.engagement.findCampaignSendConnection(ctx, normalized.senderConnectionId);
    const attachmentReadiness = await this.attachmentReadiness(ctx, normalized.attachmentIds);
    if (!attachmentReadiness.ready) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'One or more attachments are not ready to send.',
        409,
        { blockers: attachmentReadiness.blockers },
      );
    }

    const settingsHash = hashSettings(normalized);
    const prior = await this.latestSettingsEvent(ctx, sessionId);
    if (prior?.settings.settingsHash === settingsHash) {
      return {
        settings: prior.settings,
        idempotent: true,
        invalidatedDraftVersionIds: [],
        invalidationFailures: [],
      };
    }

    const committed = await this.decisions.append(ctx, sessionId, {
      eventType: SETTINGS_EVENT,
      expectedStateVersion: current.currentStateVersion,
      payloadHash: settingsHash,
      safeMetadata: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        settings: normalized,
        settingsHash,
      },
    });

    const settings: OutreachV3SendSettings = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      ...normalized,
      settingsHash,
      stateVersion: current.currentStateVersion,
      updatedAt: committed.event.createdAt.toISOString(),
    };

    // Changing sender/signature/attachments is an upstream change. Preserve the
    // old approved versions and append a byte-identical V+1 for each current
    // draft so approval is visibly cleared without rewriting history. The
    // settings event itself is the fail-closed boundary if any re-versioning
    // attempt fails: preflight compares approval sequence to this event.
    const invalidatedDraftVersionIds: string[] = [];
    const invalidationFailures: string[] = [];
    const artifacts = await this.drafts.listForOutreach(ctx, sessionId);
    for (const artifact of artifacts) {
      if (!artifact.current) continue;
      try {
        const next = await this.drafts.createEditedVersion(ctx, artifact.id, {
          baseVersionId: artifact.current.id,
          subject: artifact.current.subject,
          body: artifact.current.body,
          editKind: 'manual',
        });
        invalidatedDraftVersionIds.push(next.id);
      } catch (error) {
        invalidationFailures.push(`${artifact.generationKey}: ${(error as Error).message}`);
      }
    }

    return {
      settings,
      idempotent: committed.idempotent,
      invalidatedDraftVersionIds,
      invalidationFailures,
    };
  }

  async preflight(
    ctx: TenantContext,
    sessionId: string,
    request: OutreachV3PreflightRequest = {},
  ): Promise<OutreachV3ServerPreflight> {
    const current = await this.sessions.getSession(ctx, sessionId);
    const plan = await this.generation.plan(ctx, sessionId);
    const settingsEvent = await this.latestSettingsEvent(ctx, sessionId);
    const settings = settingsEvent?.settings ?? null;
    const testMode = Boolean(request.testGenerationKey);
    const excludedGenerationKeys = testMode
      ? plan.slots
          .map((slot) => slot.generationKey)
          .filter((key) => key !== request.testGenerationKey)
      : uniqueStrings(request.excludedGenerationKeys ?? []);

    if (testMode && !plan.slots.some((slot) => slot.generationKey === request.testGenerationKey)) {
      throw new BadRequestException('The selected test draft is not part of the current plan.');
    }

    let senderAuthorized = false;
    if (settings?.senderConnectionId) {
      try {
        await this.engagement.findCampaignSendConnection(ctx, settings.senderConnectionId);
        senderAuthorized = true;
      } catch {
        senderAuthorized = false;
      }
    }
    const attachmentReadiness = await this.attachmentReadiness(ctx, settings?.attachmentIds ?? []);
    const artifacts = await this.drafts.listForOutreach(ctx, sessionId);
    const recipientSnapshots = await this.recipientSnapshots(ctx, sessionId);
    const preflightDrafts: OutreachV3PreflightDraft[] = [];

    for (const artifact of artifacts) {
      if (!artifact.current) continue;
      const snapshot = recipientSnapshots.get(artifact.generationKey) ?? {};
      const approval = await this.approvals.getCurrentApproval(
        ctx,
        sessionId,
        artifact.current.id,
        plan,
      );
      const approvalSequence = approval
        ? await this.latestApprovalSequence(ctx, sessionId, artifact.current.id)
        : null;
      const settingsSequence = settingsEvent?.sequence ?? null;
      const approvalAfterSettings =
        approval &&
        (settingsSequence === null ||
          (approvalSequence !== null && approvalSequence > settingsSequence));
      preflightDrafts.push({
        version: {
          versionId: artifact.current.id,
          artifactId: artifact.id,
          generationKey: artifact.generationKey,
          contentHash: artifact.current.contentHash,
          planHash: plan.planHash,
          generationStatus: artifact.current.generationStatus,
          auditStatus: artifact.current.auditStatus,
          baseApprovalStatus: artifact.current.approvalStatus,
        },
        approval: approvalAfterSettings ? approval : null,
        localDirty: false,
        recipientSnapshotCurrent: recipientSnapshotMatchesPlan(plan, artifact, snapshot),
        recipientSnapshot: snapshot,
      });
    }

    const evaluated = evaluateOutreachV3Preflight({
      plan,
      drafts: preflightDrafts,
      senderConnectionId: settings?.senderConnectionId ?? null,
      senderAuthorized,
      attachmentsReady: attachmentReadiness.ready,
      excludedGenerationKeys,
      testMode,
    });

    const blockers = [...evaluated.blockers];
    const internalOnly = current.spec.sponsor.kind === 'internal_team';
    if (internalOnly) blockers.push('SPONSOR_SCOPE_BLOCKED');
    const heldOutAcknowledged =
      excludedGenerationKeys.length === 0 || request.acknowledgeHeldOut === true;
    if (!heldOutAcknowledged) blockers.push('HELD_RECIPIENTS_NOT_ACKNOWLEDGED');
    if (attachmentReadiness.blockers.length) blockers.push(...attachmentReadiness.blockers);

    const uniqueBlockers = uniqueStrings(blockers);
    const eligible = evaluated.eligible && !internalOnly && heldOutAcknowledged;
    return {
      eligible,
      testMode,
      blockers: uniqueBlockers,
      checks: buildNamedChecks({
        plan,
        evaluated,
        settings,
        senderAuthorized,
        attachmentsReady: attachmentReadiness.ready,
        internalOnly,
        heldOutAcknowledged,
        intentReady: eligible,
      }),
      draftVersionIds: evaluated.draftVersionIds,
      excludedGenerationKeys: evaluated.excludedGenerationKeys,
      heldOutAcknowledged,
      plan,
      settings,
      draftResults: evaluated.draftResults,
    };
  }

  async createIntent(
    ctx: TenantContext,
    sessionId: string,
    requestKey: string,
    request: OutreachV3PreflightRequest = {},
  ): Promise<{ intentId: string; deduped: boolean; preflight: OutreachV3ServerPreflight }> {
    const preflight = await this.preflight(ctx, sessionId, request);
    if (!preflight.eligible || !preflight.settings) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'The campaign did not pass server-authoritative preflight.',
        409,
        { blockers: preflight.blockers, checks: preflight.checks },
      );
    }
    const created = await this.sendIntents.createIntent(ctx, {
      outreachRecordId: sessionId,
      requestKey,
      senderConnectionId: preflight.settings.senderConnectionId,
      draftVersionIds: preflight.draftVersionIds,
      attachmentIds: preflight.settings.attachmentIds,
      appendSignature: preflight.settings.appendSignature,
      testMode: preflight.testMode,
      runtimeAction: preflight.testMode ? 'outreach_v3_test_send' : 'outreach_v3_send',
    });
    return { ...created, preflight };
  }

  getIntent(ctx: TenantContext, intentId: string): Promise<OutreachSendIntentView> {
    return this.sendIntents.getIntent(ctx, intentId);
  }

  cancelIntent(
    ctx: TenantContext,
    intentId: string,
  ): Promise<{ canceled: boolean; skipped: number; inFlight: number; terminal: number }> {
    return this.sendIntents.cancelIntent(ctx, intentId);
  }

  async refreshIntent(
    ctx: TenantContext,
    intentId: string,
  ): Promise<OutreachSendIntentView & { reconciliation: Record<string, unknown> }> {
    const intent = await this.sendIntents.getIntent(ctx, intentId);
    return {
      ...intent,
      reconciliation: {
        automaticRetry: false,
        automaticResend: false,
        unknownIsTerminal: true,
        source: 'durable_delivery_state',
      },
    };
  }

  private async latestSettingsEvent(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<{ settings: OutreachV3SendSettings; sequence: bigint } | null> {
    const event = await this.decisions.latest(ctx, sessionId, SETTINGS_EVENT);
    if (!event) return null;
    const metadata = asRecord(event.safeMetadataJsonb);
    const raw = asRecord(metadata.settings);
    const normalized = normalizeSettingsInput({
      senderConnectionId: String(raw.senderConnectionId ?? ''),
      appendSignature: raw.appendSignature !== false,
      attachmentIds: Array.isArray(raw.attachmentIds)
        ? raw.attachmentIds.filter((value): value is string => typeof value === 'string')
        : [],
    });
    return {
      settings: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        ...normalized,
        settingsHash: String(metadata.settingsHash ?? event.payloadHash),
        stateVersion: event.stateVersionAfter,
        updatedAt: event.createdAt.toISOString(),
      },
      sequence: event.sequence,
    };
  }

  private async latestApprovalSequence(
    ctx: TenantContext,
    sessionId: string,
    versionId: string,
  ): Promise<bigint | null> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>`
        SELECT sequence
        FROM outreach_events
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${sessionId} AS uuid)
          AND event_type = 'draft_version_approved'
          AND safe_metadata_jsonb -> 'approval' ->> 'versionId' = ${versionId}
        ORDER BY sequence DESC
        LIMIT 1
      `;
      return rows[0]?.sequence ?? null;
    });
  }

  private async recipientSnapshots(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<Map<string, Record<string, unknown>>> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftArtifact.findMany({
        where: {
          tenantId: ctx.tenantId,
          outreachRecordId: sessionId,
          createdByUserId: ctx.userId,
        },
        select: { generationKey: true, recipientSnapshot: true },
      }),
    );
    return new Map(
      rows.map((row) => [row.generationKey, asRecord(row.recipientSnapshot)] as const),
    );
  }

  private async attachmentReadiness(
    ctx: TenantContext,
    attachmentIds: string[],
  ): Promise<{ ready: boolean; blockers: string[] }> {
    if (!attachmentIds.length) return { ready: true, blockers: [] };
    const ids = uniqueStrings(attachmentIds);
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.findMany({
        where: { tenantId: ctx.tenantId, id: { in: ids } },
        select: {
          id: true,
          fileName: true,
          contentType: true,
          lifecycleStatus: true,
          scanStatus: true,
          verifiedContentType: true,
        },
      }),
    );
    const blockers: string[] = [];
    if (rows.length !== ids.length) blockers.push('ATTACHMENT_NOT_FOUND');
    for (const row of rows) {
      const verdict = this.attachmentContent.readiness(row, this.attachmentScanner.scanRequired);
      if (!verdict.usable) blockers.push(verdict.code ?? 'ATTACHMENT_NOT_READY');
    }
    return { ready: blockers.length === 0, blockers: uniqueStrings(blockers) };
  }
}

function normalizeSettingsInput(input: OutreachV3SendSettingsInput): OutreachV3SendSettingsInput {
  const senderConnectionId = input.senderConnectionId?.trim() ?? '';
  if (!senderConnectionId) throw new BadRequestException('Select a connected sending mailbox.');
  return {
    senderConnectionId,
    appendSignature: input.appendSignature !== false,
    attachmentIds: uniqueStrings(input.attachmentIds ?? []),
  };
}

function hashSettings(input: OutreachV3SendSettingsInput): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function recipientSnapshotMatchesPlan(
  plan: OutreachV3GenerationPlan,
  artifact: OutreachDraftArtifactDto,
  snapshot: Record<string, unknown>,
): boolean {
  const slot = plan.slots.find((candidate) => candidate.generationKey === artifact.generationKey);
  if (!slot) return false;
  const expected = slot.recipients
    .map((recipient) => recipient.email?.trim().toLowerCase() ?? '')
    .filter(Boolean)
    .sort();
  const actual = emailsFromRecipientSnapshot(snapshot).sort();
  return expected.length > 0 && expected.join('\n') === actual.join('\n');
}

function buildNamedChecks(input: {
  plan: OutreachV3GenerationPlan;
  evaluated: ReturnType<typeof evaluateOutreachV3Preflight>;
  settings: OutreachV3SendSettings | null;
  senderAuthorized: boolean;
  attachmentsReady: boolean;
  internalOnly: boolean;
  heldOutAcknowledged: boolean;
  intentReady: boolean;
}): OutreachV3NamedPreflightCheck[] {
  const draftBlockers = input.evaluated.draftResults.flatMap((row) => row.blockers);
  const has = (code: string) =>
    input.evaluated.blockers.includes(code as never) || draftBlockers.includes(code as never);
  const state = (blocked: boolean, review = false): OutreachV3CheckState =>
    blocked ? 'blocked' : review ? 'review' : 'pass';
  return [
    check(
      'campaign',
      'Campaign plan',
      input.plan.eligible
        ? 'Current plan is generation-eligible.'
        : 'Campaign planning is incomplete.',
      state(!input.plan.eligible),
    ),
    check(
      'scope',
      'Sponsor scope',
      input.internalOnly
        ? 'Internal-only campaigns cannot send externally.'
        : 'Sponsor scope permits external outreach.',
      state(input.internalOnly),
    ),
    check(
      'sender',
      'Sender',
      input.settings ? 'A connected sender is selected.' : 'Select a sending mailbox.',
      state(!input.settings),
    ),
    check(
      'sender-auth',
      'Sender authorization',
      input.senderAuthorized
        ? 'Sender ownership was verified server-side.'
        : 'The selected sender is not authorized.',
      state(!input.senderAuthorized),
    ),
    check(
      'signature',
      'Signature',
      input.settings?.appendSignature
        ? 'Your current signature will be appended.'
        : 'Signature is intentionally disabled.',
      'pass',
    ),
    check(
      'attachments',
      'Attachments',
      input.attachmentsReady
        ? 'Every selected attachment is ready.'
        : 'One or more attachments are not ready.',
      state(!input.attachmentsReady),
    ),
    check(
      'drafts',
      'Draft coverage',
      has('DRAFT_MISSING') || has('DRAFT_DUPLICATE')
        ? 'Every required generation slot needs exactly one current draft.'
        : 'Every required slot has one current draft.',
      state(has('DRAFT_MISSING') || has('DRAFT_DUPLICATE')),
    ),
    check(
      'versions',
      'Exact versions',
      has('DRAFT_STALE') || has('DRAFT_DIRTY')
        ? 'A draft changed after generation or approval.'
        : 'Exact immutable versions are selected.',
      state(has('DRAFT_STALE') || has('DRAFT_DIRTY')),
    ),
    check(
      'approval',
      'Author approval',
      has('DRAFT_NOT_EXACTLY_APPROVED')
        ? 'Approve every exact current version after the latest settings change.'
        : 'Exact current versions are approved.',
      state(has('DRAFT_NOT_EXACTLY_APPROVED')),
    ),
    check(
      'audit',
      'Assurance review',
      has('DRAFT_HELD') || has('DRAFT_FAILED') || has('AUDIT_UNAVAILABLE')
        ? 'A draft is held, failed, or lacks an audit verdict.'
        : 'All selected versions passed the send assurance boundary.',
      state(has('DRAFT_HELD') || has('DRAFT_FAILED') || has('AUDIT_UNAVAILABLE')),
    ),
    check(
      'recipients',
      'Recipient snapshots',
      has('RECIPIENT_SNAPSHOT_STALE')
        ? 'A recipient changed after generation.'
        : 'Recipient snapshots match the current target set.',
      state(has('RECIPIENT_SNAPSHOT_STALE')),
    ),
    check(
      'emails',
      'Recipient email',
      has('RECIPIENT_EMAIL_MISSING') || has('RECIPIENT_EMAIL_COLLISION')
        ? 'Fix missing or duplicate recipient addresses.'
        : 'Recipient addresses are present and unique.',
      state(has('RECIPIENT_EMAIL_MISSING') || has('RECIPIENT_EMAIL_COLLISION')),
    ),
    check(
      'held',
      'Held-out recipients',
      input.heldOutAcknowledged
        ? 'Any held-out recipients were explicitly acknowledged.'
        : 'Acknowledge held-out recipients before sending.',
      state(!input.heldOutAcknowledged),
    ),
    check(
      'intent',
      'Send intent',
      input.intentReady
        ? 'A durable intent will be committed before the provider call.'
        : 'The send intent cannot be created until every blocker is cleared.',
      state(!input.intentReady, true),
    ),
  ];
}

function check(
  key: string,
  label: string,
  detail: string,
  state: OutreachV3CheckState,
): OutreachV3NamedPreflightCheck {
  return { key, label, detail, state };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
