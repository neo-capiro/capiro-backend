/**
 * Engagement Phase 0 (plan §3.b2) — the ONE place the grounding auditor decides
 * an outreach draft version's fate.
 *
 * Before this, generation ran the auditor inline and a thrown auditor, a failed
 * ledger write, or a failed review-row write all FAILED OPEN: the draft stayed
 * exactly as sendable as if it had passed. That is the release-blocking hole
 * this service closes — under `enforce`, a control that cannot prove the draft
 * is clean makes the draft NON-sendable (`audit_status='unavailable'`), and the
 * failure is surfaced rather than swallowed.
 *
 * Everything attaches to an EXACT immutable version id, never to a content key:
 * an edit produces a new version that must earn its own verdict.
 *
 * Deliberately does NOT use ReviewsService.createSystem(): that helper is
 * explicitly fail-open (it swallows create errors and returns null), and
 * injecting it here would also create a Reviews↔Engagement module cycle. The
 * review row is written directly through Prisma inside the same transaction that
 * marks the version held — the same rationale the previous
 * EngagementService.persistOutreachHold() documented.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DELIVERABLE_RISK_TIERS, type TenantContext } from '@capiro/shared';
import { runAuditor, type AuditorMode, type LedgerEntry } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { resolveTenantAuditorMode } from '../common/auditor-mode.js';
import {
  OUTREACH_DRAFT_VERSION_SUBJECT_TYPE,
  type DraftApprovalStatus,
  type DraftAuditStatus,
} from './outreach-draft.types.js';

/**
 * Raised when an enforce-mode control FAILED (auditor threw, ledger write
 * failed, review-row write failed). The version has already been persisted as
 * `unavailable` before this is thrown, so the caller's job is only to surface
 * the state — never to retry into a sendable state.
 */
export class OutreachAuditUnavailableError extends ServiceUnavailableException {
  constructor(
    readonly versionId: string,
    reason: string,
  ) {
    super(
      'Draft verification is unavailable, so this draft cannot be sent. ' +
        'Regenerate or edit the draft to produce a new version.',
    );
    this.cause = new Error(reason);
  }
}

export interface OutreachDraftAuditOutcome {
  versionId: string;
  auditStatus: DraftAuditStatus;
  approvalStatus: DraftApprovalStatus;
  auditMode: AuditorMode;
  auditDecision: string | null;
  findingCount: number;
  reviewRequestId: string | null;
  /** INTERNAL note for the lobbyist only — never appended to subject/body. */
  contextNote?: string;
}

/** Only the shape the reviewer needs: check + severity. Never spans or evidence. */
interface SanitizedCheck {
  check: string;
  severity: string;
}

@Injectable()
export class OutreachDraftAuditService {
  private readonly logger = new Logger(OutreachDraftAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Audit ONE exact version and persist the verdict onto that row.
   *
   * Never throws for a clean/warning outcome. Throws
   * {@link OutreachAuditUnavailableError} only after the version has been
   * durably marked non-sendable under enforce.
   */
  async runForVersion(ctx: TenantContext, versionId: string): Promise<OutreachDraftAuditOutcome> {
    const version = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftVersion.findFirst({
        where: { id: versionId, tenantId: ctx.tenantId },
        select: {
          id: true,
          subject: true,
          body: true,
          contentHash: true,
          version: true,
          artifactId: true,
          auditLedger: true,
          provider: true,
          model: true,
          promptSpecVersion: true,
          artifact: {
            select: {
              generationKey: true,
              recipientKey: true,
              recipientSnapshot: true,
              outreachRecordId: true,
              outreachRecord: { select: { clientId: true } },
            },
          },
        },
      }),
    );
    if (!version) {
      // Not a control failure — the version genuinely does not exist for this
      // tenant. Callers treat this as a programming error, not a hold.
      throw new ServiceUnavailableException('Draft version not found for audit');
    }

    // ONE tenant.settings read for the whole call (the env mode with a
    // per-tenant override). Resolved before the try so a settings-read failure
    // cannot be mistaken for an auditor failure — resolveTenantAuditorMode is
    // itself fail-safe and falls back to the env mode.
    const mode = await resolveTenantAuditorMode(this.prisma, ctx.tenantId);

    // Auditor off for this tenant: nothing to verify, so nothing to hold.
    if (mode === 'off') {
      await this.writeState(ctx, versionId, {
        auditStatus: 'not_required',
        approvalStatus: 'not_required',
        auditMode: mode,
        auditDecision: null,
        auditFindings: null,
      });
      return {
        versionId,
        auditStatus: 'not_required',
        approvalStatus: 'not_required',
        auditMode: mode,
        auditDecision: null,
        findingCount: 0,
        reviewRequestId: null,
      };
    }

    try {
      // Audit the EXACT text a recipient would receive: subject AND body. The
      // old inline auditor read only the body, so a contradiction introduced in
      // the subject line was never checked.
      const ledgerEntries = this.readLedgerEntries(version.auditLedger);
      const verdict = runAuditor({
        output: `${version.subject}\n${version.body}`,
        ledger: { entries: ledgerEntries },
        surface: 'outreach',
        mode,
      });
      const checks: SanitizedCheck[] = verdict.findings.map((f) => ({
        check: String(f.check),
        severity: String(f.severity),
      }));

      // Clean: no findings at all. Passed under every non-off mode.
      if (verdict.findings.length === 0) {
        await this.writeState(ctx, versionId, {
          auditStatus: 'passed',
          approvalStatus: 'not_required',
          auditMode: mode,
          auditDecision: verdict.decision,
          auditFindings: [],
        });
        return {
          versionId,
          auditStatus: 'passed',
          approvalStatus: 'not_required',
          auditMode: mode,
          auditDecision: verdict.decision,
          findingCount: 0,
          reviewRequestId: null,
        };
      }

      this.logger.warn(
        `[meri-auditor:${mode}] outreach draft version ${versionId} — ` +
          `${verdict.findings.length} finding(s), top=${verdict.topSeverity}, ` +
          `decision=${verdict.decision}: ${checks.map((c) => `${c.check}/${c.severity}`).join(', ')}`,
      );

      // The audit ledger row is the durable evidence. It is written BEFORE the
      // version is marked passed/held so a ledger failure can never leave a
      // released draft with no record of why it was released.
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.meriAuditLedger.create({
          data: {
            tenantId: ctx.tenantId,
            surface: 'outreach',
            mode,
            decision: verdict.decision,
            topSeverity: verdict.topSeverity ?? null,
            findingCount: verdict.findings.length,
            findings: verdict.findings as unknown as Prisma.InputJsonValue,
            outputChars: version.body.length,
            ...(version.model ? { model: version.model.slice(0, 80) } : {}),
          },
        }),
      );

      // Non-blocking modes: visible warning, still sendable. Never a banner in
      // subject/body — outreach bodies stay recipient-facing and citation-free;
      // the note is internal to the lobbyist.
      if (mode === 'shadow' || mode === 'annotate') {
        await this.writeState(ctx, versionId, {
          auditStatus: 'warning',
          approvalStatus: 'not_required',
          auditMode: mode,
          auditDecision: verdict.decision,
          auditFindings: checks,
        });
        return {
          versionId,
          auditStatus: 'warning',
          approvalStatus: 'not_required',
          auditMode: mode,
          auditDecision: verdict.decision,
          findingCount: verdict.findings.length,
          reviewRequestId: null,
          ...(mode === 'annotate' ? { contextNote: this.contextNote(checks) } : {}),
        };
      }

      // enforce + any finding on this fully-blocking surface = HOLD. The review
      // row and the held version state are written in ONE transaction: a held
      // version without its review (unreviewable, and therefore permanently
      // stuck) is exactly the state edge case 5 forbids.
      const reviewRequestId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const review = await tx.reviewRequest.create({
          data: {
            tenantId: ctx.tenantId,
            // Outreach IS an external send — the blueprint's restricted tier.
            // @capiro/shared has no 'outreach' key; external_send is the typed
            // constant the previous hold path already used for these rows.
            riskTier: DELIVERABLE_RISK_TIERS.external_send ?? 'restricted',
            surface: 'outreach',
            subjectType: OUTREACH_DRAFT_VERSION_SUBJECT_TYPE,
            subjectId: version.id,
            clientId: version.artifact.outreachRecord?.clientId ?? null,
            title: `Held outreach draft v${version.version} — ${this.recipientLabel(version.artifact)}`.slice(
              0,
              300,
            ),
            reason:
              `The grounding auditor held this draft under enforce mode ` +
              `(${checks.map((c) => `${c.check} (${c.severity})`).join(', ')}). ` +
              `Approving releases ONLY this exact version; any edit creates a new ` +
              `version that must earn its own verdict.`,
            // IDs, hashes and check names ONLY. The reviewer reads the protected
            // subject/body through GET /api/reviews/:id, which is access-checked
            // — duplicating the body here would copy it into a second store with
            // a looser read path.
            payload: {
              versionId: version.id,
              artifactId: version.artifactId,
              outreachRecordId: version.artifact.outreachRecordId,
              generationKey: version.artifact.generationKey,
              recipientKey: version.artifact.recipientKey,
              version: version.version,
              contentHash: version.contentHash,
              auditMode: mode,
              auditDecision: verdict.decision,
              topSeverity: verdict.topSeverity ?? null,
              findingCount: verdict.findings.length,
              checks,
              provider: version.provider,
              model: version.model,
              promptSpecVersion: version.promptSpecVersion,
            } as unknown as Prisma.InputJsonValue,
            requestedBy: ctx.userId ?? null,
          },
          select: { id: true },
        });
        await tx.outreachDraftVersion.updateMany({
          where: { id: versionId, tenantId: ctx.tenantId },
          data: {
            auditStatus: 'held',
            approvalStatus: 'pending',
            auditMode: mode,
            auditDecision: verdict.decision,
            auditFindings: checks as unknown as Prisma.InputJsonValue,
            reviewRequestId: review.id,
          },
        });
        return review.id;
      });

      return {
        versionId,
        auditStatus: 'held',
        approvalStatus: 'pending',
        auditMode: mode,
        auditDecision: verdict.decision,
        findingCount: verdict.findings.length,
        reviewRequestId,
        contextNote: this.contextNote(checks),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.handleControlFailure(ctx, versionId, mode, reason);
    }
  }

  /**
   * A control (auditor / ledger write / review write) failed.
   *
   * enforce            → the version is marked `unavailable` + approval pending
   *                      (NON-sendable) and the failure is thrown. Fail closed.
   * shadow | annotate  → visible `warning` with auditDecision
   *                      'audit_unavailable'; generation may continue.
   */
  private async handleControlFailure(
    ctx: TenantContext,
    versionId: string,
    mode: AuditorMode,
    reason: string,
  ): Promise<OutreachDraftAuditOutcome> {
    const enforcing = mode === 'enforce';
    this.logger.error(
      `[meri-auditor:${mode}] outreach draft version ${versionId} — CONTROL FAILURE ` +
        `(${enforcing ? 'blocking send' : 'non-blocking mode'}): ${reason}`,
    );

    const auditStatus: DraftAuditStatus = enforcing ? 'unavailable' : 'warning';
    const approvalStatus: DraftApprovalStatus = enforcing ? 'pending' : 'not_required';
    try {
      await this.writeState(ctx, versionId, {
        auditStatus,
        approvalStatus,
        auditMode: mode,
        auditDecision: 'audit_unavailable',
        auditFindings: null,
      });
    } catch (writeErr) {
      // Even the state write failed. Under enforce we still throw, so the draft
      // cannot be presented as ready; the version keeps its 'pending' audit
      // status from creation, which isDraftVersionSendable() already blocks.
      this.logger.error(
        `[meri-auditor:${mode}] could not persist audit-unavailable state for version ` +
          `${versionId}: ${(writeErr as Error).message}`,
      );
      if (enforcing) throw new OutreachAuditUnavailableError(versionId, reason);
    }

    if (enforcing) throw new OutreachAuditUnavailableError(versionId, reason);

    return {
      versionId,
      auditStatus,
      approvalStatus,
      auditMode: mode,
      auditDecision: 'audit_unavailable',
      findingCount: 0,
      reviewRequestId: null,
      contextNote:
        '⚠️ Verification was unavailable for this draft. Treat any factual claim as unconfirmed.',
    };
  }

  /** Write the audit verdict onto the exact version row (tenant-scoped). */
  private async writeState(
    ctx: TenantContext,
    versionId: string,
    state: {
      auditStatus: DraftAuditStatus;
      approvalStatus: DraftApprovalStatus;
      auditMode: AuditorMode;
      auditDecision: string | null;
      auditFindings: SanitizedCheck[] | null;
    },
  ): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftVersion.updateMany({
        where: { id: versionId, tenantId: ctx.tenantId },
        data: {
          auditStatus: state.auditStatus,
          approvalStatus: state.approvalStatus,
          auditMode: state.auditMode,
          auditDecision: state.auditDecision,
          ...(state.auditFindings
            ? { auditFindings: state.auditFindings as unknown as Prisma.InputJsonValue }
            : {}),
        },
      }),
    );
  }

  /** The stored ledger, defensively narrowed — a corrupt column must not throw. */
  private readLedgerEntries(raw: unknown): LedgerEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is LedgerEntry => !!e && typeof e === 'object' && 'tool' in e);
  }

  private contextNote(checks: SanitizedCheck[]): string {
    const names = [...new Set(checks.map((c) => c.check))].join(', ');
    return (
      `⚠️ Unverified — ${checks.length} grounding finding(s) held for review (${names}). ` +
      `Treat flagged claims as unconfirmed until a reviewer clears them.`
    );
  }

  private recipientLabel(artifact: {
    recipientKey: string;
    recipientSnapshot: unknown;
  }): string {
    const snap = (artifact.recipientSnapshot ?? {}) as Record<string, unknown>;
    const name = typeof snap.name === 'string' ? snap.name.trim() : '';
    return name || artifact.recipientKey;
  }
}
