import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { ResearchService } from './research.service.js';
import { isFolderAdmin, hash } from '../folders/folder-tracker.service.js';
import { object } from '../reports/report-domain.js';
import { checkedVersion, requestKey } from '../keywords/keyword-rule.service.js';
import { legalTargetMatches, type LegalReference } from '@capiro/shared';
@Injectable()
export class ResearchImportService {
  constructor(readonly research: ResearchService) {}
  async decide(ctx: WorkspaceTenantContext, input: unknown) {
    return this.research.run(ctx, input, async (tx, b, scope) => {
      if (!isFolderAdmin(ctx)) throw new ForbiddenException('IMPORT_REVIEW_REQUIRES_ADMIN');
      const key = requestKey(b.requestKey),
        inputHash = hash(b);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':legal-import:' + key},0))`;
      const prior = await tx.$queryRaw<
        Array<{ input_hash: string; outcome: unknown }>
      >`SELECT input_hash,outcome FROM intel_legiwatch_legal_import_decision WHERE tenant_id=${ctx.tenantId} AND actor_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (prior[0]) {
        if (prior[0].input_hash !== inputHash)
          throw new ConflictException('IMPORT_REQUEST_CHANGED');
        return prior[0].outcome;
      }
      const staged = await tx.legiWatchStagedConfiguration.findFirst({
        where: { tenantId: ctx.tenantId, id: String(b.stagedId), kind: 'statute' },
      });
      if (!staged) throw new NotFoundException('STAGED_MEMBERSHIP_NOT_FOUND');
      if (
        staged.version !== checkedVersion(b.expectedVersion) ||
        hash(staged.payload) !== b.sourceHash
      )
        throw new ConflictException('STAGED_SOURCE_CHANGED');
      const raw = object(staged.payload),
        status = String(b.status),
        reason = String(b.reason ?? '');
      if (
        !['imported', 'unresolved', 'excluded'].includes(status) ||
        reason.length < 3 ||
        reason.length > 2000
      )
        throw new BadRequestException('EXPLICIT_IMPORT_DECISION_AND_REASON_REQUIRED');
      let outcome: Record<string, unknown> = {
        stagedId: staged.id,
        sourceId: staged.sourceId,
        sourceVersion: staged.version,
        sourceHash: b.sourceHash,
        status,
        reason,
        raw: staged.payload,
        provenance: staged.provenance,
        edition: null,
        targetFolderId: null,
        targetVersion: null,
        referenceId: null,
      };
      if (status === 'imported') {
        const mapping = await tx.legiWatchSourceMapping.findUnique({
          where: {
            tenantId_sourceAccount_kind_sourceId: {
              tenantId: ctx.tenantId,
              sourceAccount: staged.sourceAccount,
              kind: 'folder',
              sourceId: String(raw.folder_id),
            },
          },
        });
        if (!mapping || scope.folderId !== mapping.targetId)
          throw new ConflictException('REVIEWED_FOLDER_MAPPING_REQUIRED');
        await this.research.context(tx, ctx, scope, true);
        const edition = String(b.edition ?? ''),
          referenceId = String(b.referenceId ?? ''),
          revisionId = String(b.revisionId ?? '');
        if (!/^20\d{2}$/.test(edition) || String(b.resolutionBasis ?? '').length < 8)
          throw new BadRequestException('SOURCE_EDITION_AND_RESOLUTION_BASIS_REQUIRED');
        const refs = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT r.id FROM legal_reference r WHERE r.id=${referenceId} AND r.jurisdiction=${scope.jurisdiction} AND r.code_kind='statute' AND EXISTS(SELECT 1 FROM legal_text_revision v JOIN legal_reference child ON child.id=v.reference_id WHERE v.id=${revisionId} AND v.edition=${edition} AND v.complete AND (v.reference_id=r.id OR r.reference_kind='chapter' AND child.chapter=r.chapter))`;
        if (!refs.length) throw new BadRequestException('QUALIFIED_SOURCE_IDENTITY_REQUIRED');
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${mapping.targetId} FOR UPDATE`;
        const old = await tx.$queryRaw<
          Array<{ version: number; removed: boolean; source_memberships: unknown[] }>
        >`SELECT version,removed,source_memberships FROM intel_legiwatch_legal_membership WHERE tenant_id=${ctx.tenantId} AND folder_id=${mapping.targetId} AND reference_id=${referenceId} FOR UPDATE`;
        if (old[0]?.removed)
          outcome = {
            ...outcome,
            status: 'unresolved',
            reason: 'MANUAL_REMOVAL_PRESERVED',
            targetFolderId: mapping.targetId,
            referenceId,
            targetVersion: old[0].version,
          };
        else {
          if ((old[0]?.version ?? 0) !== checkedVersion(b.expectedMembershipVersion))
            throw new ConflictException('LOCAL_MEMBERSHIP_CHANGED');
          const sources = old[0]?.source_memberships ?? [];
          const duplicate = sources.some(
            (item) =>
              object(item).stagedId === staged.id && object(item).sourceHash === b.sourceHash,
          );
          const source = {
            stagedId: staged.id,
            sourceId: staged.sourceId,
            sourceHash: b.sourceHash,
            sourceVersion: staged.version,
            raw: staged.payload,
            provenance: staged.provenance,
            revisionId,
            resolutionBasis: b.resolutionBasis,
          };
          if (!duplicate)
            await tx.$executeRaw`INSERT INTO intel_legiwatch_legal_membership(tenant_id,folder_id,reference_id,edition,version,source_memberships) VALUES(${ctx.tenantId},${mapping.targetId},${referenceId},${edition},1,${JSON.stringify([source])}::jsonb) ON CONFLICT(tenant_id,folder_id,reference_id) DO UPDATE SET source_memberships=intel_legiwatch_legal_membership.source_memberships||EXCLUDED.source_memberships,version=intel_legiwatch_legal_membership.version+1`;
          outcome = {
            ...outcome,
            targetFolderId: mapping.targetId,
            referenceId,
            edition,
            targetVersion: (old[0]?.version ?? 0) + (duplicate ? 0 : 1),
            resolutionBasis: b.resolutionBasis,
            revisionId,
          };
        }
      }
      await tx.$executeRaw`INSERT INTO intel_legiwatch_legal_import_decision(id,tenant_id,actor_id,request_key,input_hash,staged_id,source_version,outcome) VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${key},${inputHash},${staged.id},${staged.version},${JSON.stringify(outcome)}::jsonb)`;
      return outcome;
    });
  }
  async preview(ctx: WorkspaceTenantContext, input: unknown) {
    return this.research.run(ctx, input, async (tx, b, scope) => {
      if (!isFolderAdmin(ctx)) throw new ForbiddenException('IMPORT_REVIEW_REQUIRES_ADMIN');
      const staged = await tx.legiWatchStagedConfiguration.findFirst({
        where: { tenantId: ctx.tenantId, id: String(b.stagedId), kind: 'alert' },
      });
      if (!staged || object(staged.payload).family !== 'Statute Alert')
        throw new NotFoundException('STATUTE_RULE_NOT_FOUND');
      const raw = object(staged.payload),
        selected = (Array.isArray(raw.selected_targets) ? raw.selected_targets : [])
          .map(object)
          .filter((g) => g.type === 'folder')
          .flatMap((g) =>
            (Array.isArray(g.selected) ? g.selected : []).map((x) => String(object(x).id)),
          );
      const targets: Array<{
          folderId: string;
          sourceFolderId: string;
          reference: LegalReference;
          version: number;
          sourceMemberships: unknown[];
        }> = [],
        gaps: Array<{ sourceFolderId?: string; reason: string }> = [];
      for (const sourceFolderId of selected) {
        const mapping = await tx.legiWatchSourceMapping.findUnique({
          where: {
            tenantId_sourceAccount_kind_sourceId: {
              tenantId: ctx.tenantId,
              sourceAccount: staged.sourceAccount,
              kind: 'folder',
              sourceId: sourceFolderId,
            },
          },
        });
        if (!mapping) {
          gaps.push({ sourceFolderId, reason: 'FOLDER_MAPPING_REQUIRED' });
          continue;
        }
        try {
          await this.research.keywords.folder(tx, ctx, mapping.targetId);
        } catch {
          gaps.push({ sourceFolderId, reason: 'CURRENT_FOLDER_ACCESS_REQUIRED' });
          continue;
        }
        const rows = await tx.$queryRaw<
          Array<{ identity: LegalReference; version: number; source_memberships: unknown[] }>
        >`SELECT r.identity,m.version,m.source_memberships FROM intel_legiwatch_legal_membership m JOIN legal_reference r ON r.id=m.reference_id WHERE m.tenant_id=${ctx.tenantId} AND m.folder_id=${mapping.targetId} AND NOT m.removed`;
        if (!rows.length) gaps.push({ sourceFolderId, reason: 'NO_RESOLVED_TRACKED_STATUTES' });
        targets.push(
          ...rows.map((r) => ({
            folderId: mapping.targetId,
            sourceFolderId,
            reference: r.identity,
            version: r.version,
            sourceMemberships: r.source_memberships,
          })),
        );
      }
      if (!selected.length) gaps.push({ reason: 'SELECT_FOLDER_TARGETS' });
      if (!scope.sessionKey) gaps.push({ reason: 'SELECT_EXACT_SESSION' });
      if (targets.some((t) => t.reference.kind === 'chapter') && b.descendants !== true)
        gaps.push({ reason: 'REVIEW_CHAPTER_DESCENDANT_POLICY' });
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          identity: LegalReference;
          bill_id: string;
          document_id: string;
          document_revision: string;
          quote: string;
          relation: string;
        }>
      >`SELECT o.*,r.identity FROM legislative_legal_occurrence o JOIN legal_reference r ON r.id=o.reference_id WHERE o.jurisdiction=${scope.jurisdiction} AND o.session_key=${scope.sessionKey} ORDER BY o.id LIMIT 1001`;
      const matches = rows.slice(0, 1000).flatMap((o) => {
        const matching = targets.filter((t) =>
          legalTargetMatches(t.reference, o.identity, b.descendants === true),
        );
        return matching.length ? [{ ...o, matchedMemberships: matching }] : [];
      });
      return {
        stagedId: staged.id,
        sourceHash: hash(staged.payload),
        sourceVersion: staged.version,
        name: raw.audit_key === 'alert-23' ? null : raw.name,
        original: staged.payload,
        scope,
        targets,
        gaps,
        matches,
        previewHash: hash([scope, targets, matches.map((m) => m.id), gaps, b.descendants === true]),
        cadence: null,
        recipientsState: 'CURRENT_STAFF_MAPPING_REQUIRES_REVIEW',
        matchActive: false,
        deliveryActive: false,
        coverage: {
          complete: false,
          reason:
            rows.length > 1000
              ? 'PREVIEW_LIMIT_REACHED'
              : 'SOURCE_DOCUMENT_INVENTORY_NOT_QUALIFIED',
        },
        baselinePolicy: 'historical_matches_are_review_only',
      };
    });
  }
}
