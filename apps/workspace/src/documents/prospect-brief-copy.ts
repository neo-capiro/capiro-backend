import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  prospectBriefVersionIdentity,
  prospectBriefSourceWithinTx,
  requireProspectBriefFeatureInTx,
  ProspectBriefSourceUnavailable,
  MAX_PROSPECT_BRIEF_COPIES,
  type ProspectBriefVersionIdentity,
} from '@capiro/shared';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { canEdit, canRead } from '../collaborators/role-policy.js';
import { requireProspectDraftScopeInTx } from '../prospect-resources/prospect-draft-access.js';
import { assertContextPersistenceReleased } from '../generation/context-persistence-hold.js';
import type {
  CopyProspectBriefDto,
  SaveProspectBriefCopyDto,
} from './dto/prospect-brief-copy.dto.js';
import {
  UUID,
  importedBriefBody,
  stateHash,
  validateBriefCommand,
  validateBriefCopyEdit,
} from './prospect-brief-copy-contract.js';

type Tx = Prisma.TransactionClient;
export interface CopyDocument {
  id: string;
  name: string;
  ordinal: number;
  body: unknown;
  sourceBriefVersion: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}

async function currentState(tx: Tx, tenantId: string, draftId: string) {
  const draft = await tx.wsDraft.findFirst({
    where: { tenantId, id: draftId },
  });
  if (!draft?.prospectId) throw new NotFoundException('Prospect draft not found');
  const documents = await tx.$queryRaw<Array<CopyDocument>>`
    SELECT id::text,name,ordinal,body,source_brief_version AS "sourceBriefVersion",
      created_at AS "createdAt",updated_at AS "updatedAt" FROM ws_document
    WHERE tenant_id=${tenantId}::uuid AND draft_id=${draftId}::uuid ORDER BY ordinal,id`;
  const snapshot = {
    draftId,
    prospectId: draft.prospectId,
    docTitle: draft.docTitle,
    config: draft.config,
    ask: draft.ask,
    industry: draft.industry,
    product: draft.product,
    client: draft.client,
    status: draft.status,
    isPacket: draft.isPacket,
    docCount: draft.docCount,
    documents: documents.map(({ createdAt, updatedAt, ...document }) => document),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 8_000_000)
    throw new BadRequestException('Draft state exceeds the bounded copy contract');
  return { draft, documents, snapshot, stateHash: stateHash(snapshot) };
}

async function authorizedDraft(
  tx: Tx,
  tenantId: string,
  draftId: string,
  actorId: string,
  write: boolean,
) {
  const draft = await tx.wsDraft.findFirst({
    where: { tenantId, id: draftId },
  });
  if (!draft?.prospectId) throw new NotFoundException('Prospect draft not found');
  const scope = await requireProspectDraftScopeInTx(
    tx,
    draft,
    actorId,
    write ? canEdit : canRead,
    write ? 'write' : 'read',
  );
  if (!scope) throw new NotFoundException('Prospect draft not found');
  await requireProspectBriefFeatureInTx(tx, scope);
  return scope;
}

async function command<T>(prisma: PrismaService, operation: (tx: Tx) => Promise<T>) {
  try {
    return await prisma.$transaction(operation);
  } catch (error) {
    if (error instanceof ProspectBriefSourceUnavailable)
      throw new NotFoundException('Saved brief copy unavailable');
    const e = error as { code?: string; meta?: { code?: string } };
    if (e?.code === 'P2002' || (e?.code === 'P2010' && e.meta?.code === '23505'))
      throw new ConflictException({ code: 'WORKSPACE_BRIEF_REQUEST_CONFLICT' });
    // Interruptions, permission failures and deadlocks propagate. No automatic retry.
    throw error;
  }
}

export async function prospectBriefCopyState(
  prisma: PrismaService,
  tenantId: string,
  draftId: string,
  actorId: string,
  documentId?: string,
) {
  if (![tenantId, draftId, ...(documentId ? [documentId] : [])].every((id) => UUID.test(id)))
    throw new BadRequestException('Invalid prospect copy identity');
  return command(prisma, async (tx) => {
    const scope = await authorizedDraft(tx, tenantId, draftId, actorId, false);
    const state = await currentState(tx, tenantId, draftId);
    if (documentId) {
      const document = state.documents.find((d) => d.id === documentId);
      if (!document?.sourceBriefVersion)
        throw new NotFoundException('Saved brief copy unavailable');
      const source = await prospectBriefSourceWithinTx(
        tx,
        scope,
        prospectBriefVersionIdentity(document.sourceBriefVersion),
      );
      importedBriefBody(source); // Verify canonical hashes/shape before exposing source evidence.
      return {
        schemaVersion: 1 as const,
        tenantId,
        draftId,
        prospectId: scope.prospectId,
        clientId: scope.linkedClientId,
        stateHash: state.stateHash,
        hashFormat: 'workspace-prospect-draft-state-v1' as const,
        document,
        sourceEvidence: {
          sections: source.sections,
          citations: source.citations,
          sourceSnapshot: source.sourceSnapshot,
        },
      };
    }
    return {
      schemaVersion: 1 as const,
      tenantId,
      draftId,
      prospectId: scope.prospectId,
      clientId: scope.linkedClientId,
      stateHash: state.stateHash,
      hashFormat: 'workspace-prospect-draft-state-v1' as const,
      documents: state.documents.map(({ id, name, sourceBriefVersion }) => ({
        id,
        name,
        sourceBriefVersion,
      })),
    };
  });
}

interface AtomicReceipt {
  tenantId: string;
  operation: 'copy_core_brief' | 'save_brief_copy';
  requestId: string;
  requestHash: string;
  actorId: string;
  documentId: string;
  clientId: string | null;
  source: ProspectBriefVersionIdentity;
  stateHash: string;
}

function response(version: { id: string; snapshot: unknown }, draftId: string, replayed: boolean) {
  const snapshot = version.snapshot as {
    atomicBriefSave: AtomicReceipt;
    prospectId: string;
  };
  return {
    schemaVersion: 1 as const,
    replayed,
    receipt: {
      ...snapshot.atomicBriefSave,
      draftId,
      prospectId: snapshot.prospectId,
      versionId: version.id,
      snapshotHash: stateHash(version.snapshot),
      hashFormat: 'workspace-snapshot-canonical-json-v1' as const,
    },
  };
}

async function savedReceipt(
  tx: Tx,
  tenantId: string,
  draftId: string,
  actorId: string,
  requestId: string,
  requestHash: string,
) {
  const version = await tx.wsDocVersion.findFirst({
    where: { tenantId, draftId, id: requestId },
  });
  if (!version) return null;
  const receipt = (version.snapshot as { atomicBriefSave?: AtomicReceipt })?.atomicBriefSave;
  if (
    !receipt ||
    version.authorId !== actorId ||
    receipt.actorId !== actorId ||
    receipt.requestId !== requestId ||
    receipt.requestHash !== requestHash
  )
    throw new ConflictException({ code: 'WORKSPACE_BRIEF_REQUEST_CONFLICT' });
  return version;
}

export async function copyProspectBrief(
  prisma: PrismaService,
  tenantId: string,
  draftId: string,
  actorId: string,
  input: CopyProspectBriefDto,
) {
  validateBriefCommand(tenantId, draftId, actorId, input);
  let identity: ProspectBriefVersionIdentity;
  try {
    identity = prospectBriefVersionIdentity(input.source);
  } catch {
    throw new BadRequestException('Invalid exact Core brief source');
  }
  return command(prisma, async (tx) => {
    const scope = await authorizedDraft(tx, tenantId, draftId, actorId, true);
    if (scope.linkedClientId !== input.expectedClientId || scope.prospectId !== identity.prospectId)
      throw new NotFoundException('Saved brief copy unavailable');
    const source = await prospectBriefSourceWithinTx(tx, scope, identity);
    const body = importedBriefBody(source);
    const requestHash = stateHash({
      operation: 'copy_core_brief',
      tenantId,
      draftId,
      actorId,
      input,
      sourceContentHash: stateHash({
        sections: source.sections,
        citations: source.citations,
        sourceSnapshot: source.sourceSnapshot,
      }),
    });
    const replay = await savedReceipt(tx, tenantId, draftId, actorId, input.requestId, requestHash);
    const before = await currentState(tx, tenantId, draftId);
    if (replay) {
      const receipt = (replay.snapshot as unknown as { atomicBriefSave: AtomicReceipt })
        .atomicBriefSave;
      const document = before.documents.find((d) => d.id === receipt.documentId);
      if (!document || stateHash(document.sourceBriefVersion) !== stateHash(identity))
        throw new ConflictException({ code: 'WORKSPACE_BRIEF_COPY_CONSUMED' });
      return response(replay, draftId, true);
    }
    if (before.stateHash !== input.expectedStateHash)
      throw new ConflictException({ code: 'WORKSPACE_BRIEF_STATE_CONFLICT' });
    if (before.documents.filter((d) => d.sourceBriefVersion).length >= MAX_PROSPECT_BRIEF_COPIES)
      throw new ConflictException({ code: 'WORKSPACE_BRIEF_COPY_LIMIT' });
    assertContextPersistenceReleased(tenantId, draftId);
    const documentId = randomUUID();
    const name = `Core brief copy — version ${source.source.versionNumber}`;
    const ordinal = before.documents.reduce((maximum, d) => Math.max(maximum, d.ordinal), -1) + 1;
    await tx.$executeRaw`INSERT INTO ws_document
      (id,tenant_id,draft_id,name,ordinal,body,source_brief_version,created_at,updated_at)
      VALUES (${documentId}::uuid,${tenantId}::uuid,${draftId}::uuid,${name},${ordinal},
        ${JSON.stringify(body)}::jsonb,${JSON.stringify(identity)}::jsonb,now(),now())`;
    await tx.wsDraft.update({
      where: { id: draftId, tenantId },
      data: {
        docCount: before.documents.length + 1,
        isPacket:
          before.documents.length + 1 > 1 ||
          Boolean((before.draft.config as Record<string, unknown>)?.coverLetter),
        lastEditedById: actorId,
      },
    });
    return persistReceipt(
      tx,
      tenantId,
      draftId,
      actorId,
      input.requestId,
      requestHash,
      'copy_core_brief',
      documentId,
      scope.linkedClientId,
      source,
    );
  });
}

export async function saveProspectBriefCopy(
  prisma: PrismaService,
  tenantId: string,
  draftId: string,
  documentId: string,
  actorId: string,
  input: SaveProspectBriefCopyDto,
) {
  validateBriefCommand(tenantId, draftId, actorId, input);
  if (!UUID.test(documentId)) throw new BadRequestException('Invalid copy document identity');
  validateBriefCopyEdit(input);
  return command(prisma, async (tx) => {
    const scope = await authorizedDraft(tx, tenantId, draftId, actorId, true);
    if (scope.linkedClientId !== input.expectedClientId)
      throw new NotFoundException('Saved brief copy unavailable');
    const before = await currentState(tx, tenantId, draftId);
    const document = before.documents.find((d) => d.id === documentId);
    if (!document?.sourceBriefVersion) throw new NotFoundException('Saved brief copy unavailable');
    const source = await prospectBriefSourceWithinTx(
      tx,
      scope,
      prospectBriefVersionIdentity(document.sourceBriefVersion),
    );
    importedBriefBody(source);
    const requestHash = stateHash({
      operation: 'save_brief_copy',
      tenantId,
      draftId,
      documentId,
      actorId,
      input,
      sourceContentHash: stateHash({
        sections: source.sections,
        citations: source.citations,
        sourceSnapshot: source.sourceSnapshot,
      }),
      source: source.source,
    });
    const replay = await savedReceipt(tx, tenantId, draftId, actorId, input.requestId, requestHash);
    if (replay) return response(replay, draftId, true);
    if (before.stateHash !== input.expectedStateHash)
      throw new ConflictException({ code: 'WORKSPACE_BRIEF_STATE_CONFLICT' });
    assertContextPersistenceReleased(tenantId, draftId);
    await tx.$executeRaw`UPDATE ws_document SET body=${JSON.stringify(input.body)}::jsonb,
      name=${input.name ?? document.name},ordinal=${input.ordinal ?? document.ordinal},updated_at=now()
      WHERE tenant_id=${tenantId}::uuid AND draft_id=${draftId}::uuid AND id=${documentId}::uuid`;
    await tx.wsDraft.update({
      where: { id: draftId, tenantId },
      data: {
        ...(input.docTitle !== undefined ? { docTitle: input.docTitle } : {}),
        lastEditedById: actorId,
      },
    });
    return persistReceipt(
      tx,
      tenantId,
      draftId,
      actorId,
      input.requestId,
      requestHash,
      'save_brief_copy',
      documentId,
      scope.linkedClientId,
      source,
      input.label,
    );
  });
}

async function persistReceipt(
  tx: Tx,
  tenantId: string,
  draftId: string,
  actorId: string,
  requestId: string,
  requestHash: string,
  operation: AtomicReceipt['operation'],
  documentId: string,
  clientId: string | null,
  source: Awaited<ReturnType<typeof prospectBriefSourceWithinTx>>,
  label?: string,
) {
  const after = await currentState(tx, tenantId, draftId);
  const receipt: AtomicReceipt = {
    tenantId,
    operation,
    requestId,
    requestHash,
    actorId,
    documentId,
    clientId,
    source: source.source,
    stateHash: after.stateHash,
  };
  const snapshot = {
    ...after.snapshot,
    atomicBriefSave: receipt,
    sourceEvidence: {
      sections: source.sections,
      citations: source.citations,
      sourceSnapshot: source.sourceSnapshot,
    },
  };
  const version = await tx.wsDocVersion.create({
    data: {
      id: requestId,
      tenantId,
      draftId,
      authorId: actorId,
      authorKind: 'person',
      label: label ?? (operation === 'copy_core_brief' ? 'Copied Core brief' : 'Saved brief copy'),
      snapshot: snapshot as never,
    },
  });
  return response(version, draftId, false);
}
