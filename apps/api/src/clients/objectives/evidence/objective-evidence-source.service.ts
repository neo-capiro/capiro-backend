import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../../../engagement/engagement.service.js';
import {
  readRetainedNewsObservation,
  listRetainedNewsObservations,
} from '../../../intelligence/news/news-evidence-read.js';
import { loadCurrentOperationalScopeWithinTx } from '../operational/objective-operational.store.js';
import {
  documentEvidenceSnapshot,
  evidenceReference,
  evidenceSnapshotDigest,
  newsEvidenceSnapshot,
  parseEvidenceReference,
} from './objective-evidence-source.rules.js';
import type {
  ObjectiveEvidenceInspection,
  ObjectiveEvidenceReference,
  ObjectiveEvidenceScope,
  ObjectiveEvidenceSelector,
  ObjectiveEvidenceSnapshot,
} from './objective-evidence-source.types.js';

type Tx = Prisma.TransactionClient;
const denied = (error: unknown) =>
  error instanceof NotFoundException || error instanceof ForbiddenException;
const stale = () => new ConflictException('Objective evidence changed; review the source again.');

/** Source selection, not a second authorization or evidence ledger. Each operation
 * uses current Core Objective authority and existing canonical source owners.
 * Retained snapshots never authorize a read, a decision or a downstream action. */
@Injectable()
export class ObjectiveEvidenceSourceService {
  constructor(private readonly documents: EngagementService) {}

  private async current(tx: Tx, ctx: TenantContext, scope: ObjectiveEvidenceScope) {
    const current = await loadCurrentOperationalScopeWithinTx(
      tx,
      ctx,
      scope.clientId,
      scope.objectiveId,
    );
    if (current.objectiveVersion !== scope.objectiveVersion) throw stale();
  }

  private async read(
    tx: Tx,
    ctx: TenantContext,
    scope: ObjectiveEvidenceScope,
    ref: ObjectiveEvidenceReference,
  ) {
    if (ref.kind === 'document') {
      const row = await this.documents.readCitationAttachment(
        tx,
        ctx,
        scope.clientId,
        ref.attachmentId,
      );
      return { snapshot: documentEvidenceSnapshot(row), isCurrent: row.isCurrent };
    }
    const row = await readRetainedNewsObservation(tx, ref.articleId, ref.observationId);
    return {
      snapshot: newsEvidenceSnapshot(row),
      isCurrent: row.observationId === row.currentObservationId,
    };
  }

  async previewWithinTx(
    tx: Tx,
    ctx: TenantContext,
    scope: ObjectiveEvidenceScope,
    reference: ObjectiveEvidenceReference,
  ) {
    parseEvidenceReference(reference);
    await this.current(tx, ctx, scope);
    const result = await this.read(tx, ctx, scope, reference);
    await this.current(tx, ctx, scope);
    if (!result.isCurrent) throw stale();
    return result.snapshot;
  }

  async resolveWithinTx(
    tx: Tx,
    ctx: TenantContext,
    scope: ObjectiveEvidenceScope,
    selector: ObjectiveEvidenceSelector,
  ) {
    parseEvidenceReference(selector, true);
    const snapshot = await this.previewWithinTx(tx, ctx, scope, evidenceReference(selector));
    if (snapshot.digest !== selector.expectedDigest) throw stale();
    return snapshot;
  }

  async inspectWithinTx(
    tx: Tx,
    ctx: TenantContext,
    scope: ObjectiveEvidenceScope,
    snapshot: ObjectiveEvidenceSnapshot,
  ): Promise<ObjectiveEvidenceInspection> {
    parseEvidenceReference(snapshot.selector, true);
    await this.current(tx, ctx, scope);
    let result: Awaited<ReturnType<ObjectiveEvidenceSourceService['read']>>;
    try {
      result = await this.read(tx, ctx, scope, evidenceReference(snapshot.selector));
    } catch (error) {
      if (!denied(error)) throw error;
      await this.current(tx, ctx, scope);
      return { status: 'unavailable' };
    }
    await this.current(tx, ctx, scope);
    // A changed exact immutable version, rights, or corrupt stored witness cannot
    // license disclosure of the formerly retained text even as historical evidence.
    if (
      snapshot.version !== result.snapshot.version ||
      snapshot.rights !== result.snapshot.rights ||
      snapshot.digest !== snapshot.selector.expectedDigest ||
      evidenceSnapshotDigest(snapshot) !== snapshot.digest
    )
      return { status: 'unavailable' };
    return {
      status: result.isCurrent && result.snapshot.digest === snapshot.digest ? 'current' : 'stale',
      snapshot,
    };
  }

  async listWithinTx(
    tx: Tx,
    ctx: TenantContext,
    scope: ObjectiveEvidenceScope,
    query: { kind: 'document' | 'news'; search?: string; cursor?: string },
  ) {
    if (
      !query ||
      !['document', 'news'].includes(query.kind) ||
      (query.search !== undefined &&
        (typeof query.search !== 'string' || query.search.length > 200)) ||
      (query.cursor !== undefined &&
        (typeof query.cursor !== 'string' || query.cursor.length > 200))
    )
      throw new BadRequestException('Invalid Objective evidence query.');
    await this.current(tx, ctx, scope);
    const page =
      query.kind === 'document'
        ? await this.documents.listCitationAttachmentIds(
            tx,
            ctx,
            scope.clientId,
            query.search ?? '',
            query.cursor,
          )
        : await listRetainedNewsObservations(tx, query.search ?? '', query.cursor);
    const refs: ObjectiveEvidenceReference[] =
      'ids' in page
        ? page.ids.map((attachmentId) => ({ kind: 'document', attachmentId }))
        : page.items.map((row) => ({ kind: 'news', ...row }));
    const items: ObjectiveEvidenceSnapshot[] = [];
    for (const ref of refs) {
      try {
        const result = await this.read(tx, ctx, scope, ref);
        if (result.isCurrent) items.push(result.snapshot);
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    await this.current(tx, ctx, scope);
    return { items, nextCursor: page.nextCursor };
  }

  async historyAnchorWithinTx(
    tx: Tx,
    ctx: TenantContext,
    scope: ObjectiveEvidenceScope,
    snapshot: ObjectiveEvidenceSnapshot,
  ) {
    const result = await this.inspectWithinTx(tx, ctx, scope, snapshot);
    if (result.status === 'unavailable' || snapshot.selector.kind !== 'document')
      throw new NotFoundException('Attachment citation unavailable.');
    const anchor = await this.documents.readCitationHistoryAnchor(
      tx,
      ctx,
      scope.clientId,
      snapshot.selector.attachmentId,
      snapshot.version,
    );
    await this.current(tx, ctx, scope);
    return anchor;
  }
}
