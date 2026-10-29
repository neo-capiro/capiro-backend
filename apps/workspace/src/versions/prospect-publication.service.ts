import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canEdit, canRead } from '../collaborators/role-policy.js';
import {
  withProspectDraft,
  assertNoBoundBriefCopy,
} from '../prospect-resources/prospect-draft-access.js';
import { readDraftSnapshotInTx, type AtomicSave } from '../drafts/atomic-draft-save.js';
import type { PublishProspectDraftDto } from './dto/prospect-publication.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const operation = 'publish_prospect_draft';
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');
const conflict = (reason: string): never => {
  throw new ConflictException({ code: `WORKSPACE_PUBLICATION_${reason}` });
};
type Tx = Prisma.TransactionClient;
type Publication = {
  operation: typeof operation;
  tenantId: string;
  draftId: string;
  prospectId: string;
  requestId: string;
  requestHash: string;
  actorId: string;
  sourceVersionId: string;
  sourceSnapshotHash: string;
  sourceStateHash: string;
  previousPublicationId: string | null;
};
type Version = { id: string; snapshot: unknown; authorId: string; createdAt: Date };

function identity(tenantId: string, draftId: string, prospectId: string, actorId: string) {
  if (
    ![tenantId, draftId, prospectId].every((id) => typeof id === 'string' && UUID.test(id)) ||
    typeof actorId !== 'string' ||
    !actorId ||
    actorId.length > 200
  )
    throw new BadRequestException('Invalid prospect publication identity');
}
function publication(version: Version): Publication {
  const receipt = (version.snapshot as { prospectPublication?: Publication })?.prospectPublication;
  if (
    !receipt ||
    receipt.operation !== operation ||
    receipt.requestId !== version.id ||
    receipt.actorId !== version.authorId
  )
    return conflict('RECEIPT_CONFLICT');
  return receipt;
}
function receipt(version: Version) {
  return {
    ...publication(version),
    versionId: version.id,
    publishedAt: version.createdAt.toISOString(),
    snapshotHash: hash(version.snapshot),
    hashFormat: 'workspace-snapshot-canonical-json-v1' as const,
  };
}
async function latest(tx: Tx, tenantId: string, draftId: string) {
  return tx.wsDocVersion.findFirst({
    where: {
      tenantId,
      draftId,
      snapshot: { path: ['prospectPublication', 'operation'], equals: operation },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** The existing immutable version store owns both published bytes and retries.
 * Publishing never mutates the working draft, sends a message or grants access. */
@Injectable()
export class ProspectPublicationService {
  constructor(private readonly prisma: PrismaService) {}

  read(tenantId: string, draftId: string, prospectId: string, actorId: string) {
    identity(tenantId, draftId, prospectId, actorId);
    return withProspectDraft(
      this.prisma,
      { tenantId, id: draftId, prospectId },
      actorId,
      canRead,
      'read',
      async (tx) => {
        const state = await readDraftSnapshotInTx(tx, tenantId, draftId, prospectId);
        const current = await latest(tx, tenantId, draftId);
        return {
          schemaVersion: 1 as const,
          tenantId,
          draftId,
          prospectId,
          stateHash: state.stateHash,
          current: current ? receipt(current) : null,
        };
      },
    );
  }

  async publish(
    tenantId: string,
    draftId: string,
    actorId: string,
    input: PublishProspectDraftDto,
  ) {
    identity(tenantId, draftId, input?.expectedProspectId, actorId);
    if (
      !UUID.test(input.requestId) ||
      !UUID.test(input.sourceVersionId) ||
      !DIGEST.test(input.expectedStateHash) ||
      !DIGEST.test(input.sourceSnapshotHash) ||
      !(input.expectedPublicationId === null || UUID.test(input.expectedPublicationId))
    )
      throw new BadRequestException('Invalid prospect publication request');
    const prospectId = input.expectedProspectId;
    const requestHash = hash({ operation, tenantId, draftId, actorId, input });
    try {
      return await withProspectDraft(
        this.prisma,
        { tenantId, id: draftId, prospectId },
        actorId,
        canEdit,
        'write',
        async (tx) => {
          // This lock serializes save, publication and current authority changes.
          await assertNoBoundBriefCopy(tx, tenantId, draftId);
          const state = await readDraftSnapshotInTx(tx, tenantId, draftId, prospectId);
          if (state.draft.clientId !== null) return conflict('ORIGIN_CONFLICT');
          const prior = await tx.wsDocVersion.findFirst({
            where: { tenantId, draftId, id: input.requestId },
          });
          if (prior) {
            const stored = publication(prior);
            if (
              stored.requestHash !== requestHash ||
              stored.actorId !== actorId ||
              stored.prospectId !== prospectId
            )
              return conflict('REQUEST_CONFLICT');
            return { schemaVersion: 1 as const, replayed: true, receipt: receipt(prior) };
          }
          const current = await latest(tx, tenantId, draftId);
          if ((current?.id ?? null) !== input.expectedPublicationId)
            return conflict('CURRENT_CONFLICT');
          if (state.stateHash !== input.expectedStateHash) return conflict('STATE_CONFLICT');
          const source = await tx.wsDocVersion.findFirst({
            where: { tenantId, draftId, id: input.sourceVersionId },
          });
          if (!source || hash(source.snapshot) !== input.sourceSnapshotHash)
            return conflict('SOURCE_CONFLICT');
          const saved = source.snapshot as Record<string, unknown> & { atomicSave?: AtomicSave };
          // A generic version or a previous publication is not an atomic draft save.
          const { atomicSave: atomic, ...content } = saved;
          if (
            saved.prospectPublication ||
            atomic?.operation !== 'save_prospect_draft' ||
            atomic.prospectId !== prospectId ||
            atomic.tenantId !== tenantId ||
            atomic.draftId !== draftId ||
            atomic.requestId !== source.id ||
            atomic.clientId !== null ||
            atomic.stateHash !== state.stateHash ||
            hash(content) !== state.stateHash
          )
            return conflict('SOURCE_CONFLICT');
          const prospectPublication: Publication = {
            operation,
            tenantId,
            draftId,
            prospectId,
            requestId: input.requestId,
            requestHash,
            actorId,
            sourceVersionId: source.id,
            sourceSnapshotHash: input.sourceSnapshotHash,
            sourceStateHash: state.stateHash,
            previousPublicationId: current?.id ?? null,
          };
          const version = await tx.wsDocVersion.create({
            data: {
              id: input.requestId,
              tenantId,
              draftId,
              authorId: actorId,
              authorKind: 'person',
              label: 'Published',
              // Strictly monotonic under the parent lock, including a regressing host
              // clock or transactions which began before another publisher committed.
              createdAt: new Date(Math.max(Date.now(), (current?.createdAt.getTime() ?? 0) + 1)),
              snapshot: { ...saved, prospectPublication } as never,
            },
          });
          return { schemaVersion: 1 as const, replayed: false, receipt: receipt(version) };
        },
      );
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return conflict('REQUEST_CONFLICT');
      throw error;
    }
  }
}
