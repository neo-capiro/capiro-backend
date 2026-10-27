import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import type { AppConfig } from '../config/config.schema.js';
import { prepareSavedRecordRead, type SavedRecordReadKind } from './saved-record-read-plan.js';
import {
  WORKSPACE_SAVED_KINDS,
  readSavedRecordJson,
  receiveCoreSavedRecord,
  receiveWorkspaceSavedRecord,
} from './saved-record-read.receiver.js';
import {
  assertMeriToolRequestActive,
  meriToolRequestControl,
} from './meri-tool-request-control.js';

const requestSchema = z
  .object({
    source: z.enum(['core', 'workspace']),
    kind: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const uuid = z.string().uuid();
const libraryQuery = z
  .object({
    clientId: uuid.optional(),
    status: z.string().max(40).optional(),
    kind: z.enum(['all', 'draft', 'hillday']).optional(),
    scope: z.enum(['all', 'mine', 'shared']).optional(),
    q: z.string().max(200).optional(),
    cursor: z.string().max(2048).optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
      .optional(),
  })
  .strict();
const workspaceInputs = {
  library: z.object({ query: libraryQuery.optional() }).strict(),
  documents: z.object({ draftId: uuid }).strict(),
  versions: z.object({ draftId: uuid }).strict(),
  comments: z.object({ documentId: uuid }).strict(),
  hill_day: z.object({ documentId: uuid }).strict(),
  newsletter: z.object({ documentId: uuid }).strict(),
  newsletters: z.object({}).strict(),
  newsletter_stage: z
    .object({ documentId: uuid, revision: z.number().int().min(1).max(2_147_483_647) })
    .strict(),
  saved_version: z.object({ draftId: uuid, versionId: uuid }).strict(),
  outreach_revision: z.object({ draftId: uuid, versionId: uuid }).strict(),
} as const;

/** Fixed-route bridge to the existing HTTP authorities. It forwards only the
 * original user session: each destination resolves current identity and runs
 * its normal guards. No direct service call, actor header or delegated token. */
@Injectable()
export class SavedRecordReadService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async read(ctx: TenantContext, raw: unknown, request: Pick<Request, 'headers'>) {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Choose a supported saved-record read.');
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      authorization.length > 16_384 ||
      !/^Bearer \S+$/i.test(authorization)
    )
      throw new ForbiddenException('A current user session is required for saved records.');
    const { source, kind, input } = parsed.data;
    let url: URL;
    let body: string | undefined;
    let workspaceKind: (typeof WORKSPACE_SAVED_KINDS)[number] | undefined;
    if (source === 'core') {
      const plan = prepareSavedRecordRead(
        kind as SavedRecordReadKind,
        input as Record<string, string | number>,
      );
      const port = this.config.get('API_PORT', { infer: true });
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new ServiceUnavailableException('Saved-record owner unavailable.');
      url = new URL(plan.path, `http://127.0.0.1:${port}`);
    } else {
      if (!(WORKSPACE_SAVED_KINDS as readonly string[]).includes(kind))
        throw new BadRequestException('Choose a supported Workspace saved read.');
      workspaceKind = kind as (typeof WORKSPACE_SAVED_KINDS)[number];
      const selection = workspaceInputs[workspaceKind].safeParse(input);
      if (!selection.success) throw new BadRequestException('Choose valid saved-record selectors.');
      const base = this.config.get('WORKSPACE_API_BASE_URL', { infer: true });
      try {
        if (!base) throw new Error();
        url = new URL(base);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/workspace-api/saved-records/read`;
      } catch {
        throw new ServiceUnavailableException('Workspace saved-record owner unavailable.');
      }
      body = JSON.stringify({ kind: workspaceKind, ...selection.data });
    }
    assertMeriToolRequestActive();
    const control = meriToolRequestControl();
    const timeout = AbortSignal.timeout(15_000);
    const signal = control?.signal ? AbortSignal.any([control.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method: source === 'core' ? 'GET' : 'POST',
        headers: {
          authorization,
          accept: 'application/json',
          ...(source === 'core' ? { 'x-capiro-tenant': ctx.tenantId } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body } : {}),
        signal,
        redirect: 'error',
      });
    } catch {
      throw new ServiceUnavailableException('Saved-record owner unavailable.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new ForbiddenException(
          'Saved-record access refused. Refresh your session or permissions.',
        );
      if (response.status === 404) throw new NotFoundException('Saved record not found.');
      if (response.status === 400)
        throw new BadRequestException('Saved-record selectors were refused by the owner.');
      if (response.status === 413)
        throw new PayloadTooLargeException(
          'Saved record exceeds the read limit. Open it in its module.',
        );
      throw new ServiceUnavailableException('Saved-record owner unavailable.');
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new ServiceUnavailableException('Saved-record owner response invalid.');
    }
    const json = await readSavedRecordJson(response);
    assertMeriToolRequestActive();
    return workspaceKind
      ? receiveWorkspaceSavedRecord(workspaceKind, input, json)
      : receiveCoreSavedRecord(kind as SavedRecordReadKind, json, ctx.tenantId);
  }
}
