import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { stateFipsForAbbr } from '../../common/us-states.js';
import { R5DistrictContextService } from './r5-district-context.service.js';
import { DISTRCT_NEXUS_R5_MERI_TOOLS, R5FlagGuard } from './r5-flag.guard.js';
import type { R5Fact, R5Gap } from './r5-types.js';

const MAX_FACTS = 40;
const MAX_GAPS = 30;

function scope(input: Record<string, unknown>) {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  const state = typeof input.state === 'string' ? input.state.trim().toUpperCase() : '';
  const district = typeof input.district === 'string' ? input.district.trim() : '';
  if (!clientId || !/^[A-Z]{2}$/.test(state) || !/^\d{2}$/.test(district)) {
    throw new BadRequestException('clientId, two-letter state, and two-digit district are required');
  }
  return { clientId, state, district };
}

function boundedFacts(facts: R5Fact[], gaps: R5Gap[]) {
  const omitted = facts.length - MAX_FACTS;
  return {
    facts: facts.slice(0, MAX_FACTS),
    gaps: [
      ...gaps.slice(0, MAX_GAPS - 1),
      ...(omitted > 0 ? [{ section: 'footprint' as const, reason: `${omitted} facts omitted by tool output limit; consult the district page for full context`, source: null }] : []),
    ],
    truncated: omitted > 0 || gaps.length > MAX_GAPS,
  };
}

@Injectable()
export class R5MeriDistrictTools {
  constructor(
    private readonly flags: R5FlagGuard,
    private readonly context: R5DistrictContextService,
    private readonly prisma: PrismaService,
  ) {}

  private async enabled(tenantId: string) {
    try {
      await this.flags.assertEnabledForTenant(tenantId, DISTRCT_NEXUS_R5_MERI_TOOLS);
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }

  async getContext(ctx: TenantContext, input: Record<string, unknown>) {
    if (!(await this.enabled(ctx.tenantId))) return { available: false, reason: 'feature_disabled' as const };
    const { clientId, state, district } = scope(input);
    // The context service verifies tenant ownership before reading any public rail.
    const result = await this.context.getContext(ctx.tenantId, clientId, state, district);
    return {
      available: true, clientId: result.clientId, clientName: result.clientName,
      state: result.state, district: result.district, generatedAt: result.generatedAt,
      ...boundedFacts(result.facts, result.gaps),
    };
  }

  async getChanges(ctx: TenantContext, input: Record<string, unknown>) {
    if (!(await this.enabled(ctx.tenantId))) return { available: false, reason: 'feature_disabled' as const };
    const { clientId, state, district } = scope(input);
    const since = input.since === undefined ? undefined :
      typeof input.since === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(input.since) && !Number.isNaN(Date.parse(input.since))
        ? new Date(input.since) : null;
    if (since === null) throw new BadRequestException('since must be an ISO timestamp');
    // Client verification and qualified rail gaps come from the same context as the page.
    const result = await this.context.getContext(ctx.tenantId, clientId, state, district);
    try {
      const changes = await this.prisma.districtNexusChange.findMany({
        where: {
          observationKind: 'change',
          ...(since ? { observedAt: { gte: since } } : {}),
          OR: [
            { source: 'gsa', stateCode: stateFipsForAbbr(state), districtCode: String(Number(district)) },
            { source: { not: 'gsa' }, stateCode: state, districtCode: district },
          ],
        },
        orderBy: { observedAt: 'desc' }, take: 20,
        select: { changeKind: true, source: true, sourceRecordId: true, observedAt: true,
          effectiveAt: true, severity: true },
      });
      return {
        available: true, clientId, state, district, generatedAt: result.generatedAt,
        changes: changes.map((change) => ({ ...change,
          observedAt: change.observedAt.toISOString(),
          effectiveAt: change.effectiveAt?.toISOString() ?? null,
        })),
        gaps: result.gaps.filter((gap) => gap.section === 'changes').slice(0, MAX_GAPS),
        truncated: changes.length === 20,
      };
    } catch {
      return {
        available: true, clientId, state, district, generatedAt: result.generatedAt,
        changes: [], gaps: [
          ...result.gaps.filter((gap) => gap.section === 'changes').slice(0, MAX_GAPS - 1),
          { section: 'changes' as const, reason: 'Change ledger unavailable', source: 'district_nexus_change' },
        ], truncated: false,
      };
    }
  }
}
