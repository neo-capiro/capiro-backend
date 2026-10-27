import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import {
  parseRetainedReadContext,
  readRetainedReadDeadline,
  readRetainedReadHeader,
  retainedReadObject,
  retainedReadSnapshot,
} from './retained-read-context.js';
import {
  assertMeriToolRequestActive,
  meriToolRequestControl,
} from './meri-tool-request-control.js';
import { hasVerifiedToolServiceIdentity } from './tool-service-secret.guard.js';
import { readSavedRecordJson, SAVED_RECORD_MAX_BYTES } from './saved-record-read.receiver.js';
import { parseLegiwatchReview, receiveLegiwatchReview } from './legiwatch-review.contract.js';

const denied = () => new ForbiddenException('LegiWatch current access unavailable');
const unavailable = () => new ServiceUnavailableException('LegiWatch owner unavailable');
/** Fixed read-only bridge. The current owner supplies the identity; the Intel
 * owner rechecks actor, feature, folder and client walls. No local SQL or effect. */
@Injectable()
export class LegiwatchReviewService {
  constructor(
    private readonly config: ConfigService,
    private readonly current: ApplicationCurrentService,
  ) {}

  async read(ctx: TenantContext, req: Request, raw: unknown) {
    return this.readOwner(
      ctx,
      req,
      'get_legiwatch_review',
      raw,
      parseLegiwatchReview,
      (input, value, owner) =>
        receiveLegiwatchReview(input, value, owner.tenantId, owner.clerkUserId!),
    );
  }

  /** Internal composition seam for the finite existing Intel READ operations.
   * Parsers/receivers are server code; a model never chooses a destination. */
  async readOwner<T extends { clientId: string | null }, R>(
    ctx: TenantContext,
    req: Request,
    operation:
      | 'get_legiwatch_review'
      | 'preview_legiwatch_relevance'
      | 'compare_florida_budget_amounts'
      | 'compare_legislative_versions',
    raw: unknown,
    parse: (value: unknown) => T,
    receive: (input: T, value: unknown, owner: TenantContext) => R,
  ): Promise<R> {
    if (
      ![
        'get_legiwatch_review',
        'preview_legiwatch_relevance',
        'compare_florida_budget_amounts',
        'compare_legislative_versions',
      ].includes(operation)
    )
      throw denied();
    if (req.headers['x-capiro-impersonate-tenant'] !== undefined || !ctx.clerkUserId)
      throw denied();
    const input = parse(retainedReadSnapshot(raw, 8192));
    const context = parseRetainedReadContext(
      ctx,
      readRetainedReadHeader(req),
      hasVerifiedToolServiceIdentity(req),
    );
    const normalized = retainedReadObject(context.normalizationContext, ['legiwatchReviewScope']);
    const scope = retainedReadObject(normalized.legiwatchReviewScope, [
      'clientId',
      'identityRevision',
      'membershipRevision',
    ]);
    if (
      scope.clientId !== input.clientId ||
      ![scope.identityRevision, scope.membershipRevision].every(
        (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
      )
    )
      throw denied();
    const selected = context.subject.kind === 'client' ? context.subject.entityIds[0]! : null;
    if (selected !== null && selected !== input.clientId) throw denied();
    const deadline = readRetainedReadDeadline(req);
    const active = () => {
      assertMeriToolRequestActive();
      if (Date.now() >= deadline) throw denied();
    };
    active();
    const selection = { conversationId: context.binding.conversationId, clientId: selected };
    const first = await this.current.read(ctx, req, selection);
    if (
      first.identityRevision !== scope.identityRevision ||
      first.membershipRevision !== scope.membershipRevision ||
      (input.clientId !== null && !first.clientIds.includes(input.clientId))
    )
      throw denied();
    const expect = {
      identityRevision: first.identityRevision,
      membershipRevision: first.membershipRevision,
      contextRevision: first.contextRevision,
    };
    let url: URL;
    const secret = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    try {
      const base = this.config.get<string>('TRACKER_APP_BASE_URL');
      if (!base || !secret) throw Error();
      url = new URL(base);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw Error();
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/intel-api/internal/legiwatch/meri/read`;
    } catch {
      throw unavailable();
    }
    active();
    const timeout = AbortSignal.timeout(Math.min(15000, Math.max(1, deadline - Date.now())));
    const control = meriToolRequestControl();
    const signal = control?.signal ? AbortSignal.any([control.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-internal-service-secret': secret!,
        },
        body: JSON.stringify({
          tenantId: ctx.tenantId,
          actor: ctx.clerkUserId,
          tool: operation,
          input,
        }),
      });
    } catch {
      active();
      throw unavailable();
    }
    active();
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw denied();
      if (response.status === 404) throw new NotFoundException('LegiWatch selection unavailable');
      if (response.status === 400) throw new BadRequestException('LegiWatch selection refused');
      if (response.status === 409)
        throw new ConflictException(
          'LegiWatch selection changed; read the current source revision',
        );
      throw unavailable();
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw unavailable();
    }
    let rawResult: unknown;
    try {
      rawResult = await readSavedRecordJson(response);
    } catch (error) {
      active();
      if (error instanceof PayloadTooLargeException) throw error;
      throw unavailable();
    }
    const result = receive(input, rawResult, ctx);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SAVED_RECORD_MAX_BYTES)
      throw new PayloadTooLargeException('LegiWatch review exceeds read limit');
    active();
    await this.current.read(ctx, req, { ...selection, expect });
    active();
    return result;
  }
}
