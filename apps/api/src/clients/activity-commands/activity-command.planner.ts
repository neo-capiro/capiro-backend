import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';

export type PlannerResult =
  | { kind: 'found'; taskId: string }
  | { kind: 'missing' }
  | {
      kind: 'blocked';
      code:
        | 'planner_unavailable'
        | 'planner_access_denied'
        | 'planner_rejected'
        | 'planner_receipt_invalid';
    };
const receipt = z
  .object({
    requestId: z.string().uuid(),
    status: z.literal('completed'),
    taskId: z.string().uuid(),
  })
  .strict();

export function requireCommandBearer(authorization?: string) {
  if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) throw new UnauthorizedException();
  return authorization;
}

@Injectable()
export class ActivityCommandPlanner {
  constructor(private readonly config: ConfigService) {}
  origin() {
    try {
      const url = new URL(this.config.get<string>('QUICK_LOG_PLANNER_ORIGIN') ?? '');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw Error();
      return url.origin;
    } catch {
      throw new ServiceUnavailableException('Planner command bridge is not configured');
    }
  }
  async lookup(
    ctx: TenantContext,
    authorization: string,
    requestId: string,
  ): Promise<PlannerResult> {
    return this.call(ctx, authorization, requestId);
  }
  async create(
    ctx: TenantContext,
    authorization: string,
    requestId: string,
    data: unknown,
  ): Promise<PlannerResult> {
    return this.call(ctx, authorization, requestId, data);
  }
  private async call(
    ctx: TenantContext,
    authorization: string,
    requestId: string,
    data?: unknown,
  ): Promise<PlannerResult> {
    const origin = this.origin();
    requireCommandBearer(authorization);
    try {
      const response = await fetch(
        `${origin}/strategy-api/planner/task-create-commands${data ? '' : `/${requestId}`}`,
        {
          method: data ? 'POST' : 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: {
            authorization,
            'content-type': 'application/json',
            'x-capiro-expected-tenant-id': ctx.tenantId,
            'x-capiro-expected-actor-id': ctx.clerkUserId,
          },
          ...(data ? { body: JSON.stringify({ requestId, data }) } : {}),
        },
      );
      if (!data && response.status === 404) {
        await response.body?.cancel();
        return { kind: 'missing' };
      }
      if (response.status !== 200 && response.status !== 201) {
        await response.body?.cancel();
        return {
          kind: 'blocked',
          code:
            response.status === 401 || response.status === 403
              ? 'planner_access_denied'
              : response.status >= 400 && response.status < 500
                ? 'planner_rejected'
                : 'planner_unavailable',
        };
      }
      const reader = response.body?.getReader();
      if (!reader) return { kind: 'blocked', code: 'planner_receipt_invalid' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return { kind: 'blocked', code: 'planner_receipt_invalid' };
        }
        chunks.push(chunk.value);
      }
      const result = receipt.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!result.success || result.data.requestId !== requestId)
        return { kind: 'blocked', code: 'planner_receipt_invalid' };
      return { kind: 'found', taskId: result.data.taskId.toLowerCase() };
    } catch {
      return { kind: 'blocked', code: 'planner_unavailable' };
    }
  }
}
