import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ProcurementHubSummary, ProcurementMoneyFlow, ProcurementScopeRequest } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** Format guard; the canonical DB projection validates the full award tuple and exact instants. */
export function procurementScope(input: unknown): ProcurementScopeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Procurement scope is required');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['awardIdentityKeys', 'knownAt', 'sourceThrough'].includes(key))) {
    throw new BadRequestException('Unknown procurement scope field');
  }
  const keys = value.awardIdentityKeys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 25 || new Set(keys).size !== keys.length
    || keys.some((key) => typeof key !== 'string' || key.length > 512 || !key.startsWith('usaspending|award|CONT_AWD_'))) {
    throw new BadRequestException('Supply 1–25 distinct canonical full award keys');
  }
  for (const key of ['knownAt', 'sourceThrough']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value[key] as string))) {
      throw new BadRequestException('Clocks must be exact UTC microsecond strings');
    }
  }
  return { awardIdentityKeys: [...keys], knownAt: value.knownAt as string | undefined, sourceThrough: value.sourceThrough as string | undefined };
}

@Injectable()
export class ProcurementMoneyFlowService {
  constructor(private readonly prisma: PrismaService) {}

  async moneyFlow(tenantId: string, input: unknown): Promise<ProcurementMoneyFlow> {
    const scope = procurementScope(input);
    const deadline = { at: Date.now() + 15_000 };
    try {
      const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ result: ProcurementMoneyFlow }>>`
        SELECT public.defproc_money_flow_scope_v2(
          ${scope.awardIdentityKeys}::text[], ${scope.knownAt ?? null}::text,
          ${scope.sourceThrough ?? null}::text) AS result
      `, { readOnly: true, timeoutMs: 15_000, deadline });
      const result = rows[0]?.result;
      if (rows.length !== 1 || !result || result.contract !== 'defproc-scoped-money-flow/v1'
        || !Array.isArray(result.groups) || result.groups.length > 500
        || !Array.isArray(result.provenance) || result.provenance.length > 500
        || Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_048_576) {
        throw new ServiceUnavailableException('Qualified procurement projection is unavailable');
      }
      return result;
    } catch (error) {
      // Missing migration, denied grants and DB failures never fall back to legacy money or master access.
      const failure = error as { code?: string; meta?: { code?: string } };
      if (failure?.code === '22023' || failure?.meta?.code === '22023') {
        throw new BadRequestException('Invalid canonical procurement scope or clock');
      }
      throw new ServiceUnavailableException('Qualified procurement projection is unavailable');
    }
  }

  async hubSummary(tenantId: string, input: unknown): Promise<ProcurementHubSummary> {
    const { groups, ...summary } = await this.moneyFlow(tenantId, input);
    return { ...summary, groupCount: groups.length };
  }
}
