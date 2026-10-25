import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  prospectResourceScope,
  prospectBriefVersionIdentity,
  prospectBriefSourceWithinTx,
  requireProspectBriefFeatureInTx,
  ProspectBriefSourceUnavailable,
  type ProspectBriefVersionIdentity,
} from '@capiro/shared';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DraftsService } from '../drafts/drafts.service.js';
import { requireDraftClient } from '../drafts/draft-client-access.js';
import { assertContextPersistenceReleased } from '../generation/context-persistence-hold.js';
import {
  UUID,
  importedBriefBody,
  stateHash,
  briefSectionLabels,
} from './prospect-brief-copy-contract.js';

type Tx = Prisma.TransactionClient;
export interface ClientBriefCopyCommand {
  schemaVersion: 1;
  requestId: string;
  prospectId: string;
  clientId: string;
  expectedProspectUpdatedAt: string;
  docTitle: string;
  source: ProspectBriefVersionIdentity;
}
type Receipt = { inputHash: string; draftId: string; contextItemId: string; createdAt: Date };
const unavailable = () => new NotFoundException('Saved brief client copy is unavailable');
function ids(tenantId: string, actorId: string, ...values: string[]) {
  if (
    ![tenantId, ...values].every((v) => typeof v === 'string' && UUID.test(v)) ||
    typeof actorId !== 'string' ||
    !actorId ||
    actorId.length > 200
  )
    throw new BadRequestException('Invalid saved brief copy identity');
}
export function parseClientBriefCopy(
  prospectId: string,
  clientId: string,
  raw: unknown,
): ClientBriefCopyCommand {
  const b = raw as Record<string, unknown> | null;
  if (
    !b ||
    Array.isArray(b) ||
    Object.keys(b).sort().join() !==
      'clientId,docTitle,expectedProspectUpdatedAt,prospectId,requestId,schemaVersion,source' ||
    b.schemaVersion !== 1 ||
    b.prospectId !== prospectId ||
    b.clientId !== clientId ||
    ![b.requestId, b.prospectId, b.clientId].every((v) => typeof v === 'string' && UUID.test(v)) ||
    typeof b.expectedProspectUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(b.expectedProspectUpdatedAt)) ||
    new Date(b.expectedProspectUpdatedAt).toISOString() !== b.expectedProspectUpdatedAt ||
    typeof b.docTitle !== 'string' ||
    !b.docTitle.trim() ||
    b.docTitle.trim().length > 500
  )
    throw new BadRequestException('Review the exact saved brief and client copy');
  let source: ProspectBriefVersionIdentity;
  try {
    source = prospectBriefVersionIdentity(b.source);
  } catch {
    throw new BadRequestException('Invalid saved Core brief identity');
  }
  if (source.prospectId !== prospectId)
    throw new BadRequestException('The saved brief belongs to another prospect');
  return {
    schemaVersion: 1,
    requestId: b.requestId as string,
    prospectId,
    clientId,
    expectedProspectUpdatedAt: b.expectedProspectUpdatedAt,
    docTitle: b.docTitle.trim(),
    source,
  };
}
export function clientBriefCopyDigest(
  tenantId: string,
  actorId: string,
  command: ClientBriefCopyCommand,
) {
  return stateHash({ operation: 'copy_core_brief_to_client', tenantId, actorId, command });
}
const sourceKey = (prospectId: string, clientId: string, requestId: string) =>
  `${prospectId}:${clientId}:${requestId}`;
async function scope(
  prisma: PrismaService,
  tx: Tx,
  tenantId: string,
  actorId: string,
  prospectId: string,
  clientId: string,
) {
  const [prospect] = await tx.$queryRaw<
    Array<{ updatedAt: Date; linkedClientId: string | null; convertedAt: Date | null }>
  >`
    SELECT updated_at AS "updatedAt",linked_client_id::text AS "linkedClientId",converted_at AS "convertedAt"
    FROM business_development_prospects WHERE tenant_id=${tenantId}::uuid AND id=${prospectId}::uuid FOR SHARE`;
  if (!prospect || !prospect.convertedAt || prospect.linkedClientId !== clientId)
    throw unavailable();
  const access = await prospectResourceScope(
    tx,
    tenantId,
    { clerkUserId: actorId },
    prospectId,
    'read',
  );
  if (!access || access.linkedClientId !== clientId) throw unavailable();
  await requireProspectBriefFeatureInTx(tx, access);
  // Reuse ordinary client-draft admission. Core's prospect scope above keeps
  // current membership, linked client and wall grants locked through this write.
  await requireDraftClient(prisma, tx, tenantId, actorId, clientId);
  return { access, updatedAt: prospect.updatedAt };
}
async function saved(tx: Tx, tenantId: string, actorId: string, key: string) {
  const [row] = await tx.$queryRaw<Receipt[]>`
    SELECT input_hash AS "inputHash",draft_id::text AS "draftId",context_item_id::text AS "contextItemId",created_at AS "createdAt"
    FROM ws_source_action WHERE tenant_id=${tenantId}::uuid AND owner_id=${actorId}
      AND source_type='prospect_client_brief_copy' AND source_key=${key}`;
  return row;
}
async function response(
  tx: Tx,
  tenantId: string,
  actorId: string,
  prospectId: string,
  clientId: string,
  requestId: string,
  row: Receipt,
) {
  const draft = await tx.wsDraft.findFirst({
    where: { id: row.draftId, tenantId, ownerId: actorId, clientId, prospectId: null },
    select: { id: true },
  });
  return {
    schemaVersion: 1 as const,
    operation: 'copy_core_brief_to_client' as const,
    status: 'completed' as const,
    tenantId,
    actorId,
    prospectId,
    clientId,
    requestId,
    payloadDigest: row.inputHash,
    draftId: row.draftId,
    contextItemId: row.contextItemId,
    createdAt: row.createdAt.toISOString(),
    available: Boolean(draft),
  };
}
async function transaction<T>(prisma: PrismaService, operation: (tx: Tx) => Promise<T>) {
  try {
    return await prisma.$transaction(operation, { timeout: 30_000 });
  } catch (error) {
    if (error instanceof ProspectBriefSourceUnavailable) throw unavailable();
    // No provider work; all draft/doc/context/version/receipt writes roll back
    // together. Unknown failures are not converted to proof of non-execution.
    throw error;
  }
}
export async function copyBriefToClient(
  prisma: PrismaService,
  drafts: Pick<DraftsService, 'create'>,
  tenantId: string,
  actorId: string,
  prospectId: string,
  clientId: string,
  raw: unknown,
) {
  const command = parseClientBriefCopy(prospectId, clientId, raw);
  ids(tenantId, actorId, prospectId, clientId, command.requestId);
  const digest = clientBriefCopyDigest(tenantId, actorId, command),
    key = sourceKey(prospectId, clientId, command.requestId);
  return transaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['client-brief-copy', tenantId, actorId, key])},0))::text`;
    const current = await scope(prisma, tx, tenantId, actorId, prospectId, clientId);
    const prior = await saved(tx, tenantId, actorId, key);
    if (prior) {
      if (prior.inputHash !== digest)
        throw new ConflictException('This request belongs to another saved brief copy');
      return response(tx, tenantId, actorId, prospectId, clientId, command.requestId, prior);
    }
    if (current.updatedAt.toISOString() !== command.expectedProspectUpdatedAt)
      throw new ConflictException('The prospect changed. Review the client copy again.');
    const source = await prospectBriefSourceWithinTx(tx, current.access, command.source);
    const body = importedBriefBody(source);
    const draft = await drafts.create(
      tenantId,
      actorId,
      { clientId, docTitle: command.docTitle },
      tx,
    );
    if (
      draft.ownerId !== actorId ||
      draft.prospectId ||
      draft.clientId !== clientId ||
      draft.documents.length !== 1
    )
      throw new ConflictException('The new private draft could not be verified');
    assertContextPersistenceReleased(tenantId, draft.id);
    const document = draft.documents[0]!;
    const updated = await tx.wsDocument.update({
      where: { id: document.id, tenantId, draftId: draft.id },
      data: {
        name: `Copied Core brief — version ${source.source.versionNumber}`,
        body: body as never,
      },
    });
    // A plain-text independent context copy never resolves or fetches a source
    // link on behalf of a future reader. Source evidence is saved in the version.
    const sections = source.sections as Record<string, { text: string }>;
    const context = await tx.wsContextItem.create({
      data: {
        tenantId,
        draftId: draft.id,
        kind: 'free-text',
        payload: {
          text: Object.entries(briefSectionLabels)
            .map(([key, label]) => `${label}\n${sections[key]!.text}`)
            .join('\n\n'),
        },
      },
    });
    await tx.wsDocVersion.create({
      data: {
        tenantId,
        draftId: draft.id,
        authorId: actorId,
        authorKind: 'person',
        label: 'Copied saved Core brief to private client draft',
        snapshot: {
          draftId: draft.id,
          docTitle: draft.docTitle,
          clientId,
          client: draft.client,
          industry: draft.industry,
          product: draft.product,
          config: draft.config,
          ask: draft.ask,
          status: draft.status,
          isPacket: draft.isPacket,
          docCount: draft.docCount,
          documents: [
            { id: updated.id, name: updated.name, ordinal: updated.ordinal, body: updated.body },
          ],
          privateClientBriefCopy: {
            requestId: command.requestId,
            payloadDigest: digest,
            prospectId,
            clientId,
            source: source.source,
          },
          sourceEvidence: {
            sections: source.sections,
            citations: source.citations,
            sourceSnapshot: source.sourceSnapshot,
          },
        } as never,
      },
    });
    await tx.$executeRaw`INSERT INTO ws_source_action(tenant_id,owner_id,source_type,source_key,input_hash,draft_id,context_item_id)
      VALUES (${tenantId}::uuid,${actorId},'prospect_client_brief_copy',${key},${digest},${draft.id}::uuid,${context.id}::uuid)`;
    return response(
      tx,
      tenantId,
      actorId,
      prospectId,
      clientId,
      command.requestId,
      (await saved(tx, tenantId, actorId, key))!,
    );
  });
}
export async function readClientBriefCopy(
  prisma: PrismaService,
  tenantId: string,
  actorId: string,
  prospectId: string,
  clientId: string,
  requestId: string,
) {
  ids(tenantId, actorId, prospectId, clientId, requestId);
  return transaction(prisma, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
    await scope(prisma, tx, tenantId, actorId, prospectId, clientId);
    const row = await saved(tx, tenantId, actorId, sourceKey(prospectId, clientId, requestId));
    if (!row) throw unavailable();
    return response(tx, tenantId, actorId, prospectId, clientId, requestId, row);
  });
}
