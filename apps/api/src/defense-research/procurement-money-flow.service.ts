import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ProcurementObservedMoneyFlow, ProcurementObservedScopeRequest, ProcurementAccountReports, ProcurementAccountScopeRequest, ProcurementHubSummary, ProcurementMoneyFlow, ProcurementScopeRequest } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** Account scope guard: only awardIdentityKeys and knownAt allowed.
 *  Rejects sourceThrough and includeActionDetails — these flags do not apply here.
 */
export function procurementAccountScope(input: unknown): ProcurementAccountScopeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Procurement account scope is required');
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['awardIdentityKeys', 'knownAt'].includes(key))) {
    throw new BadRequestException('Account scope accepts only awardIdentityKeys and knownAt');
  }
  const keys = value.awardIdentityKeys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 25 || new Set(keys).size !== keys.length
    || keys.some((key) => typeof key !== 'string' || key.length > 512 || !key.startsWith('usaspending|award|CONT_AWD_'))) {
    throw new BadRequestException('Supply 1–25 distinct canonical full award keys');
  }
  if (value['knownAt'] !== undefined && (typeof value['knownAt'] !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value['knownAt'] as string))) {
    throw new BadRequestException('knownAt must be an exact UTC microsecond string');
  }
  return {
    awardIdentityKeys: [...keys] as string[],
    knownAt: value['knownAt'] as string | undefined,
  };
}


export function procurementScope(input: unknown): ProcurementScopeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Procurement scope is required');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['awardIdentityKeys', 'knownAt', 'sourceThrough', 'includeActionDetails'].includes(key))) {
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
  if (value.includeActionDetails !== undefined && value.includeActionDetails !== true && value.includeActionDetails !== false) {
    throw new BadRequestException('includeActionDetails must be true or false');
  }
  return {
    awardIdentityKeys: [...keys],
    knownAt: value.knownAt as string | undefined,
    sourceThrough: value.sourceThrough as string | undefined,
    includeActionDetails: value.includeActionDetails as boolean | undefined,
  };
}

/** New explicit contract: publisher cutoffs are unsupported, not ignored. */
export function procurementObservedScope(input: unknown): ProcurementObservedScopeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Observed procurement scope is required');
  const value = input as Record<string, unknown>;
  if (value.revisionBasis !== 'latest_observed' || Object.keys(value).some(key =>
    !['awardIdentityKeys', 'knownAt', 'revisionBasis', 'includeActionDetails'].includes(key))) {
    throw new BadRequestException('Latest-observed scope does not support publisher-time cutoffs');
  }
  const { revisionBasis: _basis, ...common } = value;
  const validated = procurementScope(common);
  return { awardIdentityKeys: validated.awardIdentityKeys, knownAt: validated.knownAt,
    includeActionDetails: validated.includeActionDetails, revisionBasis: 'latest_observed' };
}

@Injectable()
export class ProcurementMoneyFlowService {
  constructor(private readonly prisma: PrismaService) {}

  async moneyFlow(tenantId: string, input: unknown): Promise<ProcurementMoneyFlow> {
    const scope = procurementScope(input);
    const deadline = { at: Date.now() + 15_000 };
    try {
      // Opt in at the SQL boundary: detail caps must never break an existing summary request.
      const rows = await this.prisma.withTenant<Array<{ result: ProcurementMoneyFlow }>>(tenantId, (tx) =>
        scope.includeActionDetails === true
          ? tx.$queryRaw<Array<{ result: ProcurementMoneyFlow }>>`
              SELECT public.defproc_money_flow_details_v2(
                ${scope.awardIdentityKeys}::text[], ${scope.knownAt ?? null}::text,
                ${scope.sourceThrough ?? null}::text) AS result`
          : tx.$queryRaw<Array<{ result: ProcurementMoneyFlow }>>`
              SELECT public.defproc_money_flow_scope_v2(
                ${scope.awardIdentityKeys}::text[], ${scope.knownAt ?? null}::text,
                ${scope.sourceThrough ?? null}::text) AS result`,
        { readOnly: true, timeoutMs: 15_000, deadline });
      const result = rows[0]?.result;
      if (rows.length !== 1 || !result || result.contract !== 'defproc-scoped-money-flow/v1'
        || !Array.isArray(result.groups) || result.groups.length > 500
        || !Array.isArray(result.provenance) || result.provenance.length > 500
        || Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_048_576) {
        throw new ServiceUnavailableException('Qualified procurement projection is unavailable');
      }
      // Enforce actionDetails opt-in contract:
      // When includeActionDetails=true, validate the array is present and <=2500; else 503.
      // When absent/false, remove actionDetails from response to preserve exact original consumer contract.
      if (scope.includeActionDetails === true) {
        if (!Array.isArray(result.actionDetails) || result.actionDetails.length > 2500) {
          throw new ServiceUnavailableException('Qualified procurement projection is unavailable');
        }
      } else {
        // Default: omit actionDetails entirely so old consumers see byte-equivalent response.
        const { actionDetails: _omitted, ...rest } = result as ProcurementMoneyFlow & { actionDetails?: unknown };
        return rest as ProcurementMoneyFlow;
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

  async observedMoneyFlow(tenantId: string, input: unknown): Promise<ProcurementObservedMoneyFlow> {
    const scope = procurementObservedScope(input);
    const deadline = { at: Date.now() + 15_000 };
    try {
      const rows = await this.prisma.withTenant<Array<{ result: ProcurementObservedMoneyFlow }>>(tenantId, tx =>
        tx.$queryRaw<Array<{ result: ProcurementObservedMoneyFlow }>>`
          SELECT public.defproc_observed_money_flow_v1(${scope.awardIdentityKeys}::text[],
            ${scope.knownAt ?? null}::text, ${scope.includeActionDetails === true}::boolean) AS result`,
        { readOnly: true, timeoutMs: 15_000, deadline });
      const result = rows[0]?.result;
      if (rows.length !== 1 || !result || result.contract !== 'defproc-observed-money-flow/v1'
        || result.measure !== 'latest_observed_actions' || result.revisionBasis !== 'latest_observed' || result.sourceThrough !== null
        || !Array.isArray(result.groups) || result.groups.length > 500
        || !Array.isArray(result.provenance) || result.provenance.length > 500
        || Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_048_576
        || (scope.includeActionDetails === true && (!Array.isArray(result.actionDetails) || result.actionDetails.length > 2500))) {
        throw new ServiceUnavailableException('Observed procurement projection is unavailable');
      }
      if (scope.includeActionDetails !== true) {
        const { actionDetails: _omitted, ...summary } = result;
        return summary;
      }
      return result;
    } catch (error) {
      const failure = error as { code?: string; meta?: { code?: string } };
      if (failure.code === '22023' || failure.meta?.code === '22023') throw new BadRequestException('Invalid observed procurement scope or knowledge clock');
      throw new ServiceUnavailableException('Observed procurement projection is unavailable');
    }
  }

  async hubSummary(tenantId: string, input: unknown): Promise<ProcurementHubSummary> {
    // Hub always omits actionDetails regardless of request flag; call moneyFlow without flag set.
    const scopeNoDetails = { ...(procurementScope(input)), includeActionDetails: undefined };
    const { groups, actionDetails: _omitted, ...summary } = await this.moneyFlow(tenantId, scopeNoDetails) as ProcurementMoneyFlow & { actionDetails?: unknown };
    return { ...summary, groupCount: groups.length };
  }

  async accountReports(tenantId: string, input: unknown): Promise<ProcurementAccountReports> {
    // Strict scope: only awardIdentityKeys and knownAt. Reject sourceThrough/action flags.
    const scope = procurementAccountScope(input);
    const deadline = { at: Date.now() + 15_000 };
    try {
      // Independent route: account availability/caps cannot break existing Money Flow/Hub callers.
      const rows = await this.prisma.withTenant<Array<{ result: ProcurementAccountReports }>>(tenantId, (tx) =>
        tx.$queryRaw<Array<{ result: ProcurementAccountReports }>>`
          SELECT public.defproc_account_reports_scope_v1(
            ${scope.awardIdentityKeys}::text[], ${scope.knownAt ?? null}::text) AS result`,
        { readOnly: true, timeoutMs: 15_000, deadline });
      const result = rows[0]?.result;
      if (rows.length !== 1 || !result || result.contract !== 'defproc-account-reports/v1'
        || !Array.isArray(result.reports) || result.reports.length > 25
        || Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_048_576) {
        throw new ServiceUnavailableException('Account report projection is unavailable');
      }
      return result;
    } catch (error) {
      const failure = error as { code?: string; meta?: { code?: string } };
      if (failure?.code === '22023' || failure?.meta?.code === '22023') {
        throw new BadRequestException('Invalid canonical account scope or clock');
      }
      throw new ServiceUnavailableException('Account report projection is unavailable');
    }
  }
}
