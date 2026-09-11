import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { FolderTrackerService, hash, isFolderAdmin } from './folder-tracker.service.js';
import { type ApplyFolderImportDto, type PreviewFolderImportDto } from './folder-import.dto.js';

type Json = Prisma.InputJsonObject;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Json;
function bounded(value: unknown, max: number) {
  if (JSON.stringify(value).length > max) throw new BadRequestException('IMPORT_PAYLOAD_TOO_LARGE');
}

/** Administrative import only. No provider writes, invitations or delivery services. */
@Injectable()
export class FolderImportService {
  constructor(private readonly folders: FolderTrackerService) {}
  assertAdmin(ctx: WorkspaceTenantContext) {
    if (!isFolderAdmin(ctx)) throw new ForbiddenException('IMPORT_REQUIRES_TENANT_ADMIN');
  }
  async preview(ctx: WorkspaceTenantContext, input: PreviewFolderImportDto) {
    this.assertAdmin(ctx);
    if (input.targetTenantId !== ctx.tenantId)
      throw new ForbiddenException('IMPORT_TARGET_MISMATCH');
    bounded(input.mappingManifest, 64000);
    bounded(input.items, 1000000);
    const manifest = input.mappingManifest;
    if (
      manifest.tenantId !== ctx.tenantId ||
      manifest.sourceAccount !== input.sourceAccount ||
      !('sourceTimezone' in manifest)
    )
      throw new BadRequestException('EXPLICIT_MAPPING_MANIFEST_REQUIRED');
    const mappingHash = hash(manifest);
    const run = await this.folders.withActor(ctx, (tx) =>
      tx.legiWatchImportRun.upsert({
        where: {
          tenantId_sourceAccount_sourceHash_mappingHash: {
            tenantId: ctx.tenantId,
            sourceAccount: input.sourceAccount,
            sourceHash: input.sourceHash,
            mappingHash,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          sourceAccount: input.sourceAccount,
          sourceHash: input.sourceHash,
          mappingHash,
          captureId: input.captureId,
          createdBy: ctx.clerkUserId,
        },
        update: {},
      }),
    );
    if (run.status === 'paused') throw new ConflictException('IMPORT_RUN_PAUSED');
    for (const item of input.items) {
      const raw = item.payload;
      let status = item.excludedReason ? 'excluded' : 'ready';
      let reason: string | null = item.excludedReason ?? null;
      let resolved: Record<string, unknown> = {};
      if (!item.excludedReason && item.kind === 'folder') {
        const owner = str(object(manifest.owners)[str(raw.form_owner_id)]);
        const client = str(object(manifest.clients)[item.sourceId]);
        if (!owner || !(await this.folders.source.activeMember(ctx.tenantId, owner))) {
          status = 'blocked';
          reason = 'OWNER_NOT_PROVISIONED_OR_UNMAPPED';
        }
        if (client)
          await this.folders.validateReferences(ctx, { name: str(raw.name), clientId: client });
        resolved = { ownerClerkId: owner || null, clientId: client || null };
        if (
          !str(raw.name).trim() ||
          !['read_only', 'read_and_change'].includes(str(raw.other_user_access))
        ) {
          status = 'blocked';
          reason = 'INVALID_FOLDER_CONFIGURATION';
        }
      }
      if (!item.excludedReason && item.kind === 'assignment') {
        const session = object(object(manifest.sessions)[str(raw.session)]);
        const jurisdiction = str(session.jurisdiction),
          sessionKey = str(session.sessionKey);
        if (!jurisdiction || !sessionKey) {
          status = 'blocked';
          reason = 'SESSION_MAPPING_REQUIRED';
        } else {
          const match = await this.folders.resolve({
            jurisdiction,
            sessionKey,
            billNumbers: str(raw.bill_number),
          });
          const b = match.length === 1 && match[0]?.status === 'resolved' ? match[0].bill : null;
          if (!b) {
            status = 'blocked';
            reason = 'CANONICAL_BILL_UNRESOLVED';
          }
          resolved = { billId: b?.id ?? null, jurisdiction, sessionKey };
        }
        if (
          !['OFF', 'LOW', 'MEDIUM', 'HIGH'].includes(str(raw.importance)) ||
          !['OFF', 'SUPPORT', 'OPPOSE', 'MONITOR', 'NEUTRAL'].includes(str(raw.position)) ||
          typeof raw.top_priority !== 'boolean'
        ) {
          status = 'blocked';
          reason = 'CONTEXT_VALUE_NOT_RECOGNIZED';
        }
        if (raw.folder_owner_source_id !== undefined) {
          const owner = str(object(manifest.owners)[str(raw.folder_owner_source_id)]);
          if (!owner || !(await this.folders.source.activeMember(ctx.tenantId, owner))) {
            status = 'blocked';
            reason = 'FOLDER_OWNER_NOT_PROVISIONED_OR_UNMAPPED';
          }
        }
      }
      const sourceId =
        item.kind === 'alert' || item.kind === 'alert_target' || item.kind === 'alert_channel'
          ? `${input.captureId}:${item.sourceId}`
          : item.sourceId;
      await this.folders.withActor(ctx, async (tx) => {
        const key = { tenantId: ctx.tenantId, runId: run.id, kind: item.kind, sourceId };
        const existing = await tx.legiWatchImportItem.findUnique({
          where: { tenantId_runId_kind_sourceId: key },
        });
        const payload = json({
          raw,
          resolved,
          rawHash: hash(raw),
          sourceTimezone: manifest.sourceTimezone,
        });
        if (
          existing &&
          ['applied', 'unchanged', 'conflict', 'compensated', 'compensation_conflict'].includes(
            existing.status,
          )
        )
          return;
        await tx.legiWatchImportItem.upsert({
          where: { tenantId_runId_kind_sourceId: key },
          create: { ...key, status, reason, payload },
          update: { status, reason, payload },
        });
      });
    }
    return this.reconcile(ctx, run.id);
  }
  async runs(ctx: WorkspaceTenantContext) {
    this.assertAdmin(ctx);
    return this.folders.withActor(ctx, (tx) =>
      tx.legiWatchImportRun.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }
  async details(ctx: WorkspaceTenantContext, runId: string, itemId: string) {
    this.assertAdmin(ctx);
    const item = await this.folders.withActor(ctx, (tx) =>
      tx.legiWatchImportItem.findFirst({ where: { tenantId: ctx.tenantId, runId, id: itemId } }),
    );
    if (!item) throw new NotFoundException('IMPORT_ITEM_NOT_FOUND');
    return item;
  }
  async pause(ctx: WorkspaceTenantContext, runId: string, paused: boolean) {
    this.assertAdmin(ctx);
    return this.folders.withActor(ctx, async (tx) => {
      const result = await tx.legiWatchImportRun.updateMany({
        where: { tenantId: ctx.tenantId, id: runId },
        data: { status: paused ? 'paused' : 'preview' },
      });
      if (!result.count) throw new NotFoundException('IMPORT_RUN_NOT_FOUND');
      return { paused };
    });
  }
  /** Conservative compensation: only untouched objects first created by this
   * run can be removed. Updates and later references are review conflicts. */
  async compensate(ctx: WorkspaceTenantContext, runId: string, input: ApplyFolderImportDto) {
    this.assertAdmin(ctx);
    if (input.targetTenantId !== ctx.tenantId)
      throw new ForbiddenException('IMPORT_TARGET_MISMATCH');
    for (const itemId of [...new Set(input.itemIds)])
      await this.folders.withActor(ctx, async (tx) => {
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_import_run WHERE tenant_id=${ctx.tenantId} AND id=${runId} FOR UPDATE`;
        const run = await tx.legiWatchImportRun.findFirst({
          where: { tenantId: ctx.tenantId, id: runId, mappingHash: input.mappingHash },
        });
        if (!run) throw new NotFoundException('IMPORT_RUN_OR_MAPPING_NOT_FOUND');
        if (run.status !== 'paused') throw new ConflictException('PAUSE_RUN_BEFORE_COMPENSATION');
        const item = await tx.legiWatchImportItem.findFirst({
          where: { tenantId: ctx.tenantId, runId, id: itemId, status: 'applied' },
        });
        if (!item || !item.targetId) return;
        const mappingKey = {
          tenantId: ctx.tenantId,
          sourceAccount: run.sourceAccount,
          kind: item.kind,
          sourceId: item.sourceId,
        };
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(mappingKey)},0))`;
        const mapping = await tx.legiWatchSourceMapping.findUnique({
          where: { tenantId_sourceAccount_kind_sourceId: mappingKey },
        });
        const finish = (status: string, reason: string | null) =>
          tx.legiWatchImportItem.updateMany({
            where: { tenantId: ctx.tenantId, id: item.id },
            data: { status, reason },
          });
        const other = await tx.legiWatchImportItem.count({
          where: {
            tenantId: ctx.tenantId,
            runId: { not: runId },
            targetId: item.targetId,
            status: { in: ['applied', 'unchanged'] },
          },
        });
        if (!mapping || mapping.runId !== runId || mapping.targetVersion !== 0 || other) {
          await finish('compensation_conflict', 'UPDATED_OR_REFERENCED_BY_ANOTHER_RUN');
          return;
        }
        let changed = 0;
        if (item.kind === 'folder') {
          try {
            await this.folders.folder(tx, ctx, item.targetId, true);
          } catch {
            await finish('compensation_conflict', 'FOLDER_NOT_WRITABLE');
            return;
          }
          if (
            await tx.legiWatchFolderBill.count({
              where: { tenantId: ctx.tenantId, folderId: item.targetId },
            })
          ) {
            await finish('compensation_conflict', 'FOLDER_STILL_HAS_ASSIGNMENTS');
            return;
          }
          // Archive is the reversible folder removal contract; no cascading delete.
          changed = (
            await tx.legiWatchFolder.updateMany({
              where: { tenantId: ctx.tenantId, id: item.targetId, version: 0 },
              data: { archived: true, version: 1 },
            })
          ).count;
        } else if (item.kind === 'assignment') {
          const a = await tx.legiWatchFolderBill.findFirst({
            where: { tenantId: ctx.tenantId, id: item.targetId },
          });
          if (a) {
            try {
              await this.folders.folder(tx, ctx, a.folderId, true);
            } catch {
              await finish('compensation_conflict', 'FOLDER_NOT_WRITABLE');
              return;
            }
            changed = (
              await tx.legiWatchFolderBill.deleteMany({
                where: { tenantId: ctx.tenantId, id: item.targetId, version: 0 },
              })
            ).count;
          }
        } else
          changed = (
            await tx.legiWatchStagedConfiguration.deleteMany({
              where: { tenantId: ctx.tenantId, id: item.targetId, version: 0 },
            })
          ).count;
        if (!changed) {
          await finish('compensation_conflict', 'POST_IMPORT_EDIT_OR_REMOVAL_PRESERVED');
          return;
        }
        // Keep folder identity mapped after archive so a later capture cannot
        // duplicate it. Its version mismatch forces an explicit review.
        if (item.kind !== 'folder')
          await tx.legiWatchSourceMapping.deleteMany({ where: { ...mappingKey, runId } });
        await finish('compensated', null);
      });
    return this.reconcile(ctx, runId);
  }
  async reconcile(ctx: WorkspaceTenantContext, runId: string, offset = 0) {
    this.assertAdmin(ctx);
    return this.folders.withActor(ctx, async (tx) => {
      const run = await tx.legiWatchImportRun.findFirst({
        where: { tenantId: ctx.tenantId, id: runId },
      });
      if (!run) throw new NotFoundException('IMPORT_RUN_NOT_FOUND');
      const counts = await tx.legiWatchImportItem.groupBy({
        by: ['kind', 'status'],
        where: { tenantId: ctx.tenantId, runId },
        _count: { _all: true },
      });
      const items = await tx.legiWatchImportItem.findMany({
        where: { tenantId: ctx.tenantId, runId },
        orderBy: [{ kind: 'asc' }, { sourceId: 'asc' }],
        skip: offset,
        take: 100,
        select: {
          id: true,
          kind: true,
          sourceId: true,
          status: true,
          reason: true,
          targetId: true,
        },
      });
      return {
        run,
        counts,
        items,
        nextOffset: items.length === 100 ? offset + 100 : null,
        alertsActivated: false,
        usersProvisioned: false,
      };
    });
  }
  async apply(ctx: WorkspaceTenantContext, runId: string, input: ApplyFolderImportDto) {
    this.assertAdmin(ctx);
    if (input.targetTenantId !== ctx.tenantId)
      throw new ForbiddenException('IMPORT_TARGET_MISMATCH');
    for (const itemId of [...new Set(input.itemIds)]) {
      await this.folders.withActor(ctx, async (tx) => {
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_import_run WHERE tenant_id=${ctx.tenantId} AND id=${runId} FOR UPDATE`;
        const run = await tx.legiWatchImportRun.findFirst({
          where: { tenantId: ctx.tenantId, id: runId, mappingHash: input.mappingHash },
        });
        if (!run) throw new NotFoundException('IMPORT_RUN_OR_MAPPING_NOT_FOUND');
        if (run.status === 'paused') throw new ConflictException('IMPORT_RUN_PAUSED');
        await tx.$queryRaw`SELECT id FROM intel_legiwatch_import_item WHERE tenant_id=${ctx.tenantId} AND id=${itemId} AND run_id=${runId} FOR UPDATE`;
        const item = await tx.legiWatchImportItem.findFirst({
          where: { tenantId: ctx.tenantId, id: itemId, runId },
        });
        if (!item) throw new NotFoundException('IMPORT_ITEM_NOT_FOUND');
        if (!['ready', 'retry'].includes(item.status)) return;
        const payload = object(item.payload),
          raw = object(payload.raw),
          resolved = object(payload.resolved);
        const mappingKey = {
          tenantId: ctx.tenantId,
          sourceAccount: run.sourceAccount,
          kind: item.kind,
          sourceId: item.sourceId,
        };
        // Serialize durable identity across distinct capture/run applications.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(mappingKey)},0))`;
        const mapping = await tx.legiWatchSourceMapping.findUnique({
          where: { tenantId_sourceAccount_kind_sourceId: mappingKey },
        });
        const finish = (status: string, reason: string | null, targetId?: string) =>
          tx.legiWatchImportItem.updateMany({
            where: { tenantId: ctx.tenantId, id: item.id },
            data: { status, reason, targetId },
          });
        const rawHash = str(payload.rawHash);
        const appliedHash = hash({ raw, resolved, sourceTimezone: payload.sourceTimezone });
        let targetId = mapping?.targetId,
          version = 0;
        if (mapping) {
          const current =
            item.kind === 'folder'
              ? await tx.legiWatchFolder.findFirst({
                  where: { tenantId: ctx.tenantId, id: mapping.targetId },
                })
              : item.kind === 'assignment'
                ? await tx.legiWatchFolderBill.findFirst({
                    where: { tenantId: ctx.tenantId, id: mapping.targetId },
                  })
                : await tx.legiWatchStagedConfiguration.findFirst({
                    where: { tenantId: ctx.tenantId, id: mapping.targetId },
                  });
          if (!current || current.version !== mapping.targetVersion) {
            await finish('conflict', 'LOCAL_EDIT_OR_REMOVAL_PRESERVED', mapping.targetId);
            return;
          }
          if (mapping.sourceHash === appliedHash) {
            await finish('unchanged', null, mapping.targetId);
            return;
          }
          version = current.version + 1;
        }
        const provenance = json({
          sourceAccount: run.sourceAccount,
          captureId: run.captureId,
          sourceId: item.sourceId,
          sourceHash: rawHash,
          runId,
          raw,
          sourceTimezone: payload.sourceTimezone,
        });
        if (item.kind === 'folder') {
          if (targetId) {
            try {
              await this.folders.folder(tx, ctx, targetId, true, true);
            } catch {
              await finish('blocked', 'FOLDER_NOT_WRITABLE', targetId);
              return;
            }
          }
          const owner = str(resolved.ownerClerkId);
          if (!owner || !(await this.folders.source.activeMember(ctx.tenantId, owner, tx))) {
            await finish('blocked', 'OWNER_NOT_PROVISIONED_OR_UNMAPPED');
            return;
          }
          const data = {
            name: str(raw.name),
            code: str(raw.code) || null,
            archived: raw.form_archived === true,
            ownerClerkId: owner,
            otherUserAccess: raw.other_user_access === 'read_only' ? 'read_only' : 'read_change',
            clientId: str(resolved.clientId) || null,
            defaultSession: /current/i.test(str(raw.form_default_session))
              ? 'current'
              : str(raw.form_default_session),
            jurisdiction: 'FL',
            provenance,
            version,
          };
          if (targetId) {
            const updated = await tx.legiWatchFolder.updateMany({
              where: { tenantId: ctx.tenantId, id: targetId, version: mapping!.targetVersion },
              data,
            });
            if (!updated.count) {
              await finish('conflict', 'CONCURRENT_LOCAL_EDIT_PRESERVED', targetId);
              return;
            }
          } else
            targetId = (
              await tx.legiWatchFolder.create({
                data: { ...data, tenantId: ctx.tenantId, createdBy: ctx.clerkUserId },
              })
            ).id;
        } else if (item.kind === 'assignment') {
          const folderMapping = await tx.legiWatchSourceMapping.findUnique({
            where: {
              tenantId_sourceAccount_kind_sourceId: {
                tenantId: ctx.tenantId,
                sourceAccount: run.sourceAccount,
                kind: 'folder',
                sourceId: str(raw.folder_id),
              },
            },
          });
          if (!folderMapping) {
            await finish('retry', 'FOLDER_NOT_APPLIED');
            return;
          }
          await tx.$queryRaw`SELECT id FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${folderMapping.targetId} FOR UPDATE`;
          const f = await this.folders.folder(tx, ctx, folderMapping.targetId);
          if (!f.ownerClerkId) {
            await finish('blocked', 'OWNER_UNRESOLVED');
            return;
          }
          const billId = str(resolved.billId),
            bill = (await this.folders.source.bills([billId]))[0];
          if (targetId) {
            const previous = await tx.legiWatchFolderBill.findFirst({
              where: { tenantId: ctx.tenantId, id: targetId },
            });
            if (
              !previous ||
              previous.folderId !== f.id ||
              previous.billId !== billId ||
              previous.jurisdiction !== resolved.jurisdiction ||
              previous.sessionKey !== resolved.sessionKey
            ) {
              await finish('conflict', 'ASSIGNMENT_IDENTITY_REMAP_REQUIRES_REVIEW', targetId);
              return;
            }
          }
          if (
            !bill ||
            bill.jurisdiction !== resolved.jurisdiction ||
            bill.sessionKey !== resolved.sessionKey
          ) {
            await finish('blocked', 'BILL_IDENTITY_CHANGED');
            return;
          }
          // Imports into read-only folders do not impersonate the owner. Staging
          // is allowed; applying requires the actor's actual folder permission.
          if (
            f.archived ||
            !(f.ownerClerkId === ctx.clerkUserId || f.otherUserAccess === 'read_change')
          ) {
            await finish('blocked', 'FOLDER_NOT_WRITABLE');
            return;
          }
          const data = {
            topPriority: raw.top_priority === true,
            importance: raw.importance === 'OFF' ? 'normal' : str(raw.importance).toLowerCase(),
            position: raw.position === 'OFF' ? 'none' : str(raw.position).toLowerCase(),
            internalComments: str(raw.internal_comments),
            externalComments: str(raw.external_comments),
            addedDateRaw: str(raw.date_foldered) || null,
            addedDatePrecision: raw.date_foldered ? 'local_minute_unknown_zone' : 'unknown',
            provenance,
            version,
            updatedBy: ctx.clerkUserId,
          };
          if (targetId) {
            const updated = await tx.legiWatchFolderBill.updateMany({
              where: { tenantId: ctx.tenantId, id: targetId, version: mapping!.targetVersion },
              data,
            });
            if (!updated.count) {
              await finish('conflict', 'CONCURRENT_LOCAL_EDIT_PRESERVED', targetId);
              return;
            }
          } else {
            const prior = await tx.legiWatchFolderBill.findFirst({
              where: { tenantId: ctx.tenantId, folderId: f.id, billId },
            });
            if (prior) {
              await finish('conflict', 'EXISTING_LOCAL_ASSIGNMENT_PRESERVED', prior.id);
              return;
            }
            targetId = (
              await tx.legiWatchFolderBill.create({
                data: {
                  ...data,
                  tenantId: ctx.tenantId,
                  folderId: f.id,
                  billId,
                  jurisdiction: bill.jurisdiction,
                  sessionKey: bill.sessionKey,
                },
              })
            ).id;
          }
        } else {
          const data = {
            payload: json(raw),
            provenance,
            version,
            state: raw.needs_review === true ? 'needs_review' : 'staged',
          };
          if (targetId) {
            const updated = await tx.legiWatchStagedConfiguration.updateMany({
              where: { tenantId: ctx.tenantId, id: targetId, version: mapping!.targetVersion },
              data,
            });
            if (!updated.count) {
              await finish('conflict', 'CONCURRENT_LOCAL_EDIT_PRESERVED', targetId);
              return;
            }
          } else
            targetId = (
              await tx.legiWatchStagedConfiguration.create({ data: { ...mappingKey, ...data } })
            ).id;
        }
        if (!targetId) throw new ConflictException('IMPORT_TARGET_MISSING');
        await tx.legiWatchSourceMapping.upsert({
          where: { tenantId_sourceAccount_kind_sourceId: mappingKey },
          create: {
            ...mappingKey,
            targetId,
            sourceHash: appliedHash,
            targetVersion: version,
            runId,
            provenance,
          },
          update: { targetId, sourceHash: appliedHash, targetVersion: version, runId, provenance },
        });
        await finish('applied', null, targetId);
      });
    }
    return this.reconcile(ctx, runId);
  }
}
