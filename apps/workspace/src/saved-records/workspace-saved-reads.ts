import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { DocumentsService } from '../documents/documents.service.js';
import type { VersionsService } from '../versions/versions.service.js';
import type { CommentsService } from '../comments/comments.service.js';
import type { HillDayDocumentService } from '../hillday/hillday-document.service.js';
import type { NewsletterService } from '../newsletters/newsletter.service.js';
import type { LibraryQuery } from '../hillday/hillday.types.js';

/** Inert until mounted behind Workspace TenantGuard. These are the actual
 * source owners, not a second ACL or a Core SQL view over ws_* tables. */
export interface WorkspaceSavedReadOwners {
  documents: Pick<DocumentsService, 'list'>;
  versions: Pick<VersionsService, 'list' | 'getSaved' | 'outreachRevision'>;
  comments: Pick<CommentsService, 'list'>;
  hillDay: Pick<HillDayDocumentService, 'listDocuments' | 'get'>;
  newsletter: Pick<NewsletterService, 'listSaved' | 'getSaved' | 'stagedRevision'>;
}

type Identity = { tenantId: string; clerkUserId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKSPACE_SAVED_READ_MAX_BYTES = 262_144;

export type WorkspaceSavedRead =
  | { kind: 'library'; query?: LibraryQuery }
  | { kind: 'documents' | 'versions'; draftId: string }
  | { kind: 'comments'; documentId: string }
  | { kind: 'hill_day'; documentId: string }
  | { kind: 'newsletter_stage'; documentId: string; revision: number }
  | { kind: 'newsletters' }
  | { kind: 'newsletter'; documentId: string }
  | { kind: 'saved_version' | 'outreach_revision'; draftId: string; versionId: string };

/** Data stays whole: a refused large snapshot is never presented as complete
 * text, and an absent saved version never falls back to the current document. */
function result<T>(kind: WorkspaceSavedRead['kind'], data: T, limitations: readonly string[]) {
  const envelope = {
    version: '0.1.0' as const,
    kind,
    coverage: { basis: 'current_owner_read' as const, limitations },
    maxOutputBytes: WORKSPACE_SAVED_READ_MAX_BYTES,
    data,
  };
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > WORKSPACE_SAVED_READ_MAX_BYTES)
    throw new PayloadTooLargeException({
      code: 'SAVED_RECORD_RESULT_TOO_LARGE',
      message: 'This saved record exceeds the read limit. Open the exact record in Workspace.',
    });
  return envelope;
}

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new BadRequestException('Choose a canonical saved record ID.');
}

function validate(input: WorkspaceSavedRead) {
  const fields: Record<WorkspaceSavedRead['kind'], readonly string[]> = {
    library: ['kind', 'query'],
    documents: ['kind', 'draftId'],
    versions: ['kind', 'draftId'],
    comments: ['kind', 'documentId'],
    hill_day: ['kind', 'documentId'],
    newsletter_stage: ['kind', 'documentId', 'revision'],
    newsletters: ['kind'],
    newsletter: ['kind', 'documentId'],
    saved_version: ['kind', 'draftId', 'versionId'],
    outreach_revision: ['kind', 'draftId', 'versionId'],
  };
  if (
    !input ||
    typeof input !== 'object' ||
    !Object.hasOwn(fields, input.kind) ||
    Object.keys(input).some((key) => !fields[input.kind].includes(key))
  )
    throw new BadRequestException('Choose a supported saved-record read.');
  for (const key of fields[input.kind]) {
    if (key !== 'kind' && key !== 'query' && !Object.hasOwn(input, key))
      throw new BadRequestException('Choose a canonical saved record ID.');
  }
  if ('draftId' in input) uuid(input.draftId);
  if ('documentId' in input) uuid(input.documentId);
  if ('versionId' in input) uuid(input.versionId);
  if (
    'revision' in input &&
    (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 2_147_483_647)
  )
    throw new BadRequestException('Choose a valid saved newsletter revision.');
  if (input.kind === 'library' && input.query !== undefined) {
    const q = input.query;
    if (
      !q ||
      typeof q !== 'object' ||
      Array.isArray(q) ||
      Object.keys(q).some(
        (key) => !['clientId', 'status', 'kind', 'scope', 'q', 'cursor', 'limit'].includes(key),
      ) ||
      Object.values(q).some((value) => typeof value !== 'string') ||
      (q.kind !== undefined && !['all', 'draft', 'hillday'].includes(q.kind)) ||
      (q.scope !== undefined && !['all', 'mine', 'shared'].includes(q.scope)) ||
      (q.limit !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(q.limit)) ||
      (q.q !== undefined && q.q.length > 200) ||
      (q.status !== undefined && q.status.length > 40) ||
      (q.cursor !== undefined && q.cursor.length > 2048)
    )
      throw new BadRequestException('Choose valid library filters and a limit from 1 to 50.');
    if (q.clientId !== undefined) uuid(q.clientId);
  }
}

export async function readWorkspaceSavedRecord(
  owners: WorkspaceSavedReadOwners,
  identity: Identity,
  input: WorkspaceSavedRead,
) {
  // Identity must come from TenantGuard, never from a model-provided request.
  uuid(identity.tenantId);
  if (!identity.clerkUserId || identity.clerkUserId.length > 200)
    throw new NotFoundException('Saved record not found');
  validate(input);
  const { tenantId, clerkUserId: actor } = identity;
  switch (input.kind) {
    case 'library':
      return result(
        input.kind,
        await owners.hillDay.listDocuments(tenantId, actor, input.query ?? {}),
        [
          'Current owner library excludes prospect drafts; kind=draft includes ordinary Workspace drafts, kind=hillday owner-private packets.',
          'The source cursor is actor/filter bound. Empty pages can have a continuation after revoked rows; this is not a total inventory count.',
        ],
      );
    case 'documents': {
      const rows = await owners.documents.list(tenantId, input.draftId, actor);
      return result(
        input.kind,
        {
          draftId: input.draftId,
          items: rows.map((row) => ({
            id: row.id,
            name: row.name,
            ordinal: row.ordinal,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          })),
        },
        [
          'Current document-tab metadata only, not bodies or saved-version content. The existing source list is unpaged.',
        ],
      );
    }
    case 'versions': {
      const rows = await owners.versions.list(tenantId, input.draftId, actor);
      return result(
        input.kind,
        {
          draftId: input.draftId,
          items: rows.map((row) => ({
            id: row.id,
            label: row.label,
            authorId: row.authorId,
            authorKind: row.authorKind,
            createdAt: row.createdAt.toISOString(),
          })),
        },
        [
          'Saved-version metadata only. Request saved_version with this exact draftId/versionId for its snapshot.',
          'The existing source list is unpaged and loads snapshots internally; this adapter does not claim bounded database work.',
        ],
      );
    }
    case 'saved_version': {
      // The existing owner rechecks current ACL/source authority for this draft.
      // This preserves its ordinary version-history policy, not export authority.
      const row = await owners.versions.getSaved(tenantId, input.draftId, input.versionId, actor);
      return result(
        input.kind,
        {
          draftId: input.draftId,
          versionId: row.id,
          label: row.label,
          authorId: row.authorId,
          authorKind: row.authorKind,
          savedAt: row.createdAt.toISOString(),
          snapshot: row.snapshot,
        },
        [
          'Exact saved snapshot, not the working copy; rich JSON is retained without extraction, rendering or export.',
          'Current draft read authority is checked on every call. This observation grants no later transfer or edit permission.',
          'One exact saved-version lookup; the current authority owner may inspect draft configuration and copied-source receipts for admission.',
        ],
      );
    }
    case 'outreach_revision':
      return result(
        input.kind,
        await owners.versions.outreachRevision(tenantId, input.draftId, input.versionId, actor),
        [
          'Existing staging projection only: ordinary drafts, current membership/collaboration/client binding, and supported saved content within the 8,000-character plaintext limit.',
          'Prospect and Intel-origin drafts remain transfer-ineligible. This is not a complete rich-document reader or a send command.',
        ],
      );
    case 'comments':
      return result(
        input.kind,
        {
          documentId: input.documentId,
          threads: await owners.comments.list(tenantId, input.documentId, actor),
        },
        [
          'Current authorized document comment threads and replies, including full bodies, quotes and anchors; not comments as of a selected saved version.',
          'The existing source list is unpaged. Large threads are refused whole, not silently truncated.',
        ],
      );
    case 'hill_day':
      return result(input.kind, await owners.hillDay.get(tenantId, input.documentId, actor), [
        'Existing owner-private Hill Day saved document view, including saved meeting sections, edits, provenance and source status.',
        'No generation, meeting refresh, resolution, export or provider fetch is requested. Saved source snapshots are not current provider facts.',
      ]);
    case 'newsletter_stage':
      return result(
        input.kind,
        await owners.newsletter.stagedRevision(identity, input.documentId, input.revision),
        [
          'Exact committed staging receipt only, with current membership/editor access and saved source-client checks. Null means no admitted receipt for this actor and revision.',
          'No invitation activation or new stage is requested. This is not the design, config, survey, comments, asset or delivery-state inventory.',
        ],
      );
    case 'newsletters':
      return result(input.kind, await owners.newsletter.listSaved(identity), [
        'Current member owner/editor newsletter designs and configuration, under every retained source-client wall.',
        'The existing source scans at most 100 newest candidates before source filtering. No complete inventory or continuation is implied.',
        'No invitation activation, stage, render, delivery or asset fetch is requested.',
      ]);
    case 'newsletter':
      return result(input.kind, await owners.newsletter.getSaved(identity, input.documentId), [
        'Full currently saved newsletter design and configuration with current membership/editor/source-client authority. Not an immutable prior stage.',
        'Survey, comment, asset, reusable-library and delivery records remain separate owners. No invitation activation or provider call is requested.',
      ]);
  }
}
