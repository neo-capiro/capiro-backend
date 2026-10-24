import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerActor, requireOwnerClient } from './client-ordered-owner.access.js';
import {
  fileBatchDigest,
  parseFileBatchMove,
  type FileBatchMoveCommand,
  type FileBatchMoveReceipt,
} from './client-file-batch.types.js';

import { isDeepStrictEqual } from 'node:util';
import { readHearingRecordDocumentAccess } from '../engagement/hearing-record-document-access.js';
import {
  lockHearingRecordSources,
  lockHearingRecordAccess,
  validHearingRecordAccessLocks,
} from '../engagement/hearing-record-document-locks.js';

type Tx = Prisma.TransactionClient;
interface FileRow {
  id: string;
  folder: string | null;
  revision: number;
  viewerMode: string;
  viewerUserIds: string[];
  uploadedByUserId: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
}
interface ReceiptRow {
  clientId: string;
  command: unknown;
  payloadDigest: string;
  receipt: FileBatchMoveReceipt;
}

/** One transaction owns every selected file and the replay receipt. No storage object changes. */
@Injectable()
export class ClientFileBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async move(ctx: TenantContext, clientId: string, input: unknown): Promise<FileBatchMoveReceipt> {
    const command = parseFileBatchMove(clientId, input),
      digest = fileBatchDigest(command);
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await requireOwnerActor(tx, ctx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`client-file-move:${ctx.tenantId}:${ctx.userId}:${command.requestId}`},0))`;
        const files = await this.authorizedFiles(tx, ctx, command);
        const existing = await this.findReceipt(tx, ctx, command.requestId);
        if (existing && (existing.clientId !== clientId || existing.payloadDigest !== digest))
          throw new ConflictException('This request ID belongs to another batch move');
        if (existing) return this.checkedReceipt(existing, command);
        if (
          files.some(
            (file) =>
              command.files.find((expected) => expected.id === file.id)?.expectedRevision !==
              file.revision,
          )
        )
          throw new ConflictException(
            'A selected file changed. Reload and review the entire batch.',
          );
        const moved: FileBatchMoveReceipt['files'] = [];
        for (const file of files) {
          const [updated] = await tx.$queryRaw<Array<{ revision: number }>>`
          UPDATE engagement_attachments SET folder=${command.folder}
          WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid
            AND prospect_id IS NULL AND id=${file.id}::uuid AND metadata_revision=${file.revision}
          RETURNING metadata_revision AS revision`;
          if (!updated)
            throw new ConflictException('A selected file changed. No files were moved.');
          moved.push({
            id: file.id,
            previousRevision: file.revision,
            revision: updated.revision,
            folder: command.folder,
          });
        }
        const [time] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
        const receipt: FileBatchMoveReceipt = {
          schemaVersion: 1,
          requestId: command.requestId,
          clientId,
          payloadDigest: digest,
          outcome: 'moved',
          committedAt: time!.at.toISOString(),
          files: moved,
        };
        await tx.$executeRaw`INSERT INTO client_file_batch_move_receipts
        (tenant_id,client_id,actor_user_id,request_id,payload_digest,command,receipt)
        VALUES (${ctx.tenantId}::uuid,${clientId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,
          ${digest},${JSON.stringify(command)}::jsonb,${JSON.stringify(receipt)}::jsonb)`;
        return receipt;
      },
      { timeoutMs: 60000 },
    );
  }

  async receipt(ctx: TenantContext, clientId: string, requestId: string) {
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await requireOwnerActor(tx, ctx);
        const stored = await this.findReceipt(tx, ctx, requestId);
        if (!stored || stored.clientId !== clientId)
          throw new NotFoundException('Batch receipt not found');
        const command = parseFileBatchMove(clientId, stored.command);
        await this.authorizedFiles(tx, ctx, command); // Historical receipts do not bypass current per-file access.
        return this.checkedReceipt(stored, command);
      },
      { timeoutMs: 60000 },
    );
  }

  private async findReceipt(tx: Tx, ctx: TenantContext, requestId: string) {
    const rows = await tx.$queryRaw<
      ReceiptRow[]
    >`SELECT client_id::text AS "clientId",command,payload_digest AS "payloadDigest",receipt
      FROM client_file_batch_move_receipts WHERE tenant_id=${ctx.tenantId}::uuid
        AND actor_user_id=${ctx.userId}::uuid AND request_id=${requestId}::uuid`;
    return rows[0];
  }

  private checkedReceipt(stored: ReceiptRow, command: FileBatchMoveCommand) {
    const receipt = stored.receipt,
      digest = fileBatchDigest(command);
    if (
      stored.payloadDigest !== digest ||
      receipt.schemaVersion !== 1 ||
      receipt.requestId !== command.requestId ||
      receipt.clientId !== command.clientId ||
      receipt.payloadDigest !== digest ||
      receipt.outcome !== 'moved' ||
      !Number.isFinite(Date.parse(receipt.committedAt)) ||
      !Array.isArray(receipt.files) ||
      receipt.files.length !== command.files.length ||
      receipt.files.some(
        (file, i) =>
          file.id !== command.files[i]!.id ||
          file.previousRevision !== command.files[i]!.expectedRevision ||
          !Number.isSafeInteger(file.revision) ||
          file.revision < file.previousRevision ||
          file.revision > file.previousRevision + 1 ||
          file.folder !== command.folder,
      )
    )
      throw new ServiceUnavailableException('The committed batch receipt could not be verified');
    return receipt;
  }

  private async authorizedFiles(tx: Tx, ctx: TenantContext, command: FileBatchMoveCommand) {
    // Discover source locks before taking file locks: the existing brief writer
    // takes source/event locks before touching saved attachments too.
    const before = await this.readFiles(tx, ctx, command, false);
    const hearing = before.filter((file) => file.sourceEntityType === 'hearing_record_brief');
    const signal = hearing.length ? AbortSignal.timeout(15000) : undefined;
    const access = [];
    for (const file of hearing) {
      const current = await readHearingRecordDocumentAccess(
        tx,
        ctx,
        { ...file, clientId: command.clientId },
        'read',
        signal,
      );
      if (!validHearingRecordAccessLocks(current.accessLocks, command.clientId))
        throw new NotFoundException('A selected file is unavailable for this client');
      access.push({ file, current, locks: current.accessLocks });
    }
    if (access.length)
      await lockHearingRecordSources(
        tx,
        ctx,
        access.map((a) => a.current.eventId),
      );
    await requireOwnerClient(tx, ctx, command.clientId, false, false, 'share');
    for (const entry of access)
      await lockHearingRecordAccess(tx, ctx, command.clientId, entry.locks);
    const files = await this.readFiles(tx, ctx, command, true);
    if (
      files.some(
        (file, i) =>
          file.id !== before[i]!.id ||
          file.sourceEntityType !== before[i]!.sourceEntityType ||
          file.sourceEntityId !== before[i]!.sourceEntityId,
      )
    )
      throw new ConflictException('A selected file changed. Reload and review the entire batch.');
    for (const entry of access) {
      const current = await readHearingRecordDocumentAccess(
        tx,
        ctx,
        { ...entry.file, clientId: command.clientId },
        'read',
        signal,
      );
      if (!isDeepStrictEqual(current, entry.current))
        throw new ConflictException('A selected file changed. Reload and review the entire batch.');
    }
    return files;
  }

  private async readFiles(
    tx: Tx,
    ctx: TenantContext,
    command: FileBatchMoveCommand,
    lock: boolean,
  ) {
    const ids = command.files.map((file) => file.id).join(',');
    const files = await tx.$queryRaw<
      FileRow[]
    >`SELECT id::text,folder,metadata_revision AS revision,
      viewer_mode AS "viewerMode",viewer_user_ids AS "viewerUserIds",uploaded_by_user_id::text AS "uploadedByUserId",source_entity_type AS "sourceEntityType",source_entity_id AS "sourceEntityId"
      FROM engagement_attachments WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${command.clientId}::uuid
        AND prospect_id IS NULL AND id=ANY(string_to_array(${ids},',')::uuid[]) ORDER BY id ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
    if (
      files.length !== command.files.length ||
      files.some(
        (file) =>
          !(
            file.viewerMode === 'all' ||
            file.uploadedByUserId === ctx.userId ||
            (file.viewerMode === 'restricted' && file.viewerUserIds.includes(ctx.userId))
          ),
      )
    )
      throw new NotFoundException('A selected file is unavailable for this client');
    return files;
  }
}
