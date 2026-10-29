import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead } from '../collaborators/role-policy.js';
import { requireDraftClient, withDraftClientAssociation } from './draft-client-access.js';
import { withDraftWrite } from './draft-write.js';
import type { SaveDraftDto } from './dto/save-draft.dto.js';
import {
  requireProspectDraftInTx,
  assertNoBoundBriefCopy,
  withProspectDraft,
} from '../prospect-resources/prospect-draft-access.js';

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');

async function current(tx: Tx, tenantId: string, draftId: string, prospectId?: string) {
  const draft = await tx.wsDraft.findFirst({
    where: { tenantId, id: draftId },
    include: { documents: { orderBy: [{ ordinal: 'asc' }, { id: 'asc' }] } },
  });
  if (!draft || (draft.prospectId ?? null) !== (prospectId ?? null))
    throw new NotFoundException('Draft not found');
  const snapshot = {
    docTitle: draft.docTitle,
    config: draft.config,
    ask: draft.ask,
    ...(prospectId ? { prospectId } : {}),
    industry: draft.industry,
    product: draft.product,
    client: draft.client,
    clientId: draft.clientId,
    status: draft.status,
    isPacket: draft.isPacket,
    docCount: draft.docCount,
    documents: draft.documents.map(({ id, name, ordinal, body }) => ({ id, name, ordinal, body })),
  };
  if (
    draft.documents.length > 100 ||
    Buffer.byteLength(canonicalWorkspaceSnapshot(snapshot)) > 1_000_000
  )
    throw new BadRequestException('Draft exceeds the bounded save contract');
  return { draft, snapshot, stateHash: hash(snapshot) };
}

async function authorize(
  prisma: PrismaService,
  tx: Tx,
  collaborators: CollaboratorsService,
  tenantId: string,
  draftId: string,
  actorId: string,
  write: boolean,
  prospectId?: string,
) {
  const state = await current(tx, tenantId, draftId, prospectId);
  if (prospectId) {
    await requireProspectDraftInTx(
      tx,
      state.draft,
      actorId,
      write ? canEdit : canRead,
      write ? 'write' : 'read',
    );
    if (write) await assertNoBoundBriefCopy(tx, tenantId, draftId);
    return state;
  }
  // Keep Core/source authorization with its existing owners. Recheck the role
  // under the parent lock so a revoked editor cannot save or replay a receipt.
  await requireDraftClient(prisma, tx, tenantId, actorId, state.draft.clientId ?? null);
  if (!(await collaborators.sourceAccess(tenantId, draftId, actorId)))
    throw new NotFoundException('Draft not found');
  const role =
    state.draft.ownerId === actorId
      ? 'owner'
      : ((
          await tx.wsCollaborator.findFirst({
            where: { tenantId, draftId, subjectId: actorId, status: 'active' },
            select: { role: true },
          })
        )?.role ?? null);
  if (!(write ? canEdit(role) : canRead(role))) throw new NotFoundException('Draft not found');
  return state;
}

function identity(tenantId: string, draftId: string, actorId: string) {
  if (![tenantId, draftId].every((id) => UUID.test(id)) || !actorId || actorId.length > 200)
    throw new BadRequestException('Invalid draft identity');
}

export async function readAtomicDraftState(
  prisma: PrismaService,
  collaborators: CollaboratorsService,
  tenantId: string,
  draftId: string,
  actorId: string,
  prospectId?: string,
) {
  identity(tenantId, draftId, actorId);
  if (prospectId !== undefined && !UUID.test(prospectId))
    throw new BadRequestException('Invalid prospect identity');
  const read = async (tx: Tx) => {
    const state = await authorize(
      prisma,
      tx,
      collaborators,
      tenantId,
      draftId,
      actorId,
      false,
      prospectId,
    );
    return {
      schemaVersion: 1 as const,
      tenantId,
      draftId,
      clientId: state.draft.clientId ?? null,
      ...(prospectId ? { prospectId } : {}),
      stateHash: state.stateHash,
      hashFormat: prospectId
        ? ('workspace-prospect-draft-state-v1' as const)
        : ('workspace-ordinary-draft-state-v1' as const),
      draft: withDraftClientAssociation(state.draft),
    };
  };
  const origin = { tenantId, id: draftId, prospectId };
  return prospectId
    ? withProspectDraft(prisma, origin, actorId, canRead, 'read', read)
    : withDraftWrite(prisma, origin, actorId, read);
}

type AtomicSave = {
  operation: 'save_ordinary_draft' | 'save_prospect_draft';
  tenantId: string;
  draftId: string;
  actorId: string;
  prospectId?: string;
  requestId: string;
  requestHash: string;
  clientId: string | null;
  stateHash: string;
};
function response(version: { id: string; snapshot: unknown; createdAt: Date }, replayed: boolean) {
  const receipt = (version.snapshot as { atomicSave: AtomicSave }).atomicSave;
  return {
    schemaVersion: 1 as const,
    replayed,
    receipt: {
      ...receipt,
      versionId: version.id,
      savedAt: version.createdAt.toISOString(),
      snapshotHash: hash(version.snapshot),
      hashFormat: 'workspace-snapshot-canonical-json-v1' as const,
    },
  };
}

export async function saveAtomicDraft(
  prisma: PrismaService,
  collaborators: CollaboratorsService,
  tenantId: string,
  draftId: string,
  actorId: string,
  input: SaveDraftDto,
  updateDraft: (tx: Tx) => Promise<unknown>,
  prospectId?: string,
) {
  identity(tenantId, draftId, actorId);
  if (prospectId !== undefined && (!UUID.test(prospectId) || input.expectedClientId !== null))
    throw new BadRequestException(
      'Prospect drafts require their original prospect and no client association',
    );
  if (
    !UUID.test(input.requestId) ||
    !/^[a-f0-9]{64}$/.test(input.expectedStateHash) ||
    (input.expectedClientId !== null && !UUID.test(input.expectedClientId ?? '')) ||
    !Array.isArray(input.documents ?? []) ||
    (input.documents?.length ?? 0) > 100 ||
    Buffer.byteLength(JSON.stringify(input)) > 1_000_000
  )
    throw new BadRequestException('Invalid bounded save request');
  const documents = input.documents ?? [];
  if (
    new Set(documents.map((d) => d.id)).size !== documents.length ||
    documents.some((d) => !UUID.test(d.id))
  )
    throw new BadRequestException('Invalid document selection');
  if (input.draft?.clientId !== undefined && input.draft.clientId !== input.expectedClientId)
    throw new ConflictException('Associate the draft before saving this revision');
  const operation = prospectId
    ? ('save_prospect_draft' as const)
    : ('save_ordinary_draft' as const);
  const requestHash = hash({
    operation,
    tenantId,
    draftId,
    actorId,
    ...(prospectId ? { prospectId } : {}),
    input: JSON.parse(JSON.stringify(input)),
  });
  try {
    return await withDraftWrite(
      prisma,
      { tenantId, id: draftId, prospectId },
      actorId,
      async (tx) => {
        const before = await authorize(
          prisma,
          tx,
          collaborators,
          tenantId,
          draftId,
          actorId,
          true,
          prospectId,
        );
        if ((before.draft.clientId ?? null) !== input.expectedClientId)
          throw new ConflictException({ code: 'WORKSPACE_SAVE_CLIENT_CONFLICT' });
        const prior = await tx.wsDocVersion.findFirst({
          where: { tenantId, draftId, id: input.requestId },
        });
        if (prior) {
          const receipt = (prior.snapshot as { atomicSave?: AtomicSave }).atomicSave;
          if (
            !receipt ||
            receipt.operation !== operation ||
            receipt.prospectId !== prospectId ||
            receipt.actorId !== actorId ||
            prior.authorId !== actorId ||
            receipt.requestHash !== requestHash ||
            receipt.requestId !== input.requestId
          )
            throw new ConflictException({ code: 'WORKSPACE_SAVE_REQUEST_CONFLICT' });
          return response(prior, true);
        }
        if (before.stateHash !== input.expectedStateHash)
          throw new ConflictException({ code: 'WORKSPACE_SAVE_STATE_CONFLICT' });
        for (const document of documents) {
          if (!before.draft.documents.some((d) => d.id === document.id))
            throw new NotFoundException('Document not found');
        }
        await updateDraft(tx);
        for (const document of documents) {
          await tx.wsDocument.update({
            where: { id: document.id, tenantId, draftId },
            data: {
              ...(document.name !== undefined ? { name: document.name } : {}),
              ...(document.body !== undefined ? { body: document.body as never } : {}),
            },
          });
        }
        const after = await current(tx, tenantId, draftId, prospectId);
        const atomicSave: AtomicSave = {
          operation,
          tenantId,
          draftId,
          actorId,
          ...(prospectId ? { prospectId } : {}),
          requestId: input.requestId,
          requestHash,
          clientId: after.draft.clientId ?? null,
          stateHash: after.stateHash,
        };
        const version = await tx.wsDocVersion.create({
          data: {
            id: input.requestId,
            tenantId,
            draftId,
            authorId: actorId,
            authorKind: 'person',
            label: input.label ?? null,
            snapshot: { ...after.snapshot, atomicSave } as never,
          },
        });
        return response(version, false);
      },
    );
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002')
      throw new ConflictException({ code: 'WORKSPACE_SAVE_REQUEST_CONFLICT' });
    throw error;
  }
}
