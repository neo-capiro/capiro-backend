import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';

export const RAW_MERI_TOOLS_SERVICE = Symbol('RAW_MERI_TOOLS_SERVICE');

interface GovernedMemorySignal {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  title?: unknown;
  candidateId?: unknown;
  memoryItemId?: unknown;
  activeItemUnchanged?: unknown;
}

const DOCUMENT_CHART_TOOLS = new Set(['create_word', 'create_powerpoint']);
const MAX_CHART_REFS_PER_DOCUMENT = 240;

function collectChartArtifactIds(tool: string, input: unknown): string[] {
  if (
    !DOCUMENT_CHART_TOOLS.has(tool) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    return [];
  }
  const root = input as Record<string, unknown>;
  const blocks = tool === 'create_word' ? root.sections : root.slides;
  if (!Array.isArray(blocks)) return [];
  const ids: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const value = (block as Record<string, unknown>).imageArtifactIds;
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      ids.push(candidate.trim());
      if (ids.length > MAX_CHART_REFS_PER_DOCUMENT) {
        throw new BadRequestException(
          `At most ${MAX_CHART_REFS_PER_DOCUMENT} analysis chart references are allowed per document`,
        );
      }
    }
  }
  return [...new Set(ids)];
}

async function assertOwnedChartArtifacts(
  prisma: PrismaService | undefined,
  ctx: TenantContext,
  tool: string,
  input: unknown,
): Promise<void> {
  const ids = collectChartArtifactIds(tool, input);
  if (!ids.length) return;
  if (!prisma) {
    // Fail closed if this proxy is ever constructed outside the Nest module
    // without its ownership dependency. A tenant-only fallback query would
    // re-open same-tenant cross-user chart access during document generation.
    throw new NotFoundException('One or more analysis charts were not found');
  }
  const rows = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.clioArtifact.findMany({
      where: {
        id: { in: ids },
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        kind: 'analysis_chart',
      },
      select: { id: true },
    }),
  );
  if (rows.length !== ids.length) {
    // Missing and unauthorized ids intentionally share the same response.
    throw new NotFoundException('One or more analysis charts were not found');
  }
}

/**
 * Preserve MeriToolsService's complete dependency graph while translating the two
 * governed-memory control-flow signals emitted below the legacy correct_memory
 * presenter. Without this adapter, an expected shared-memory review proposal is
 * surfaced as a failed tool call because MeriToolsService.execute() has no catch.
 *
 * This proxy is also the authorization chokepoint for analysis-chart references
 * embedded into Word/PowerPoint. MeriToolsService's historical image resolver is
 * tenant-scoped; validating every id here against tenant + current user prevents
 * another user in the same tenant from embedding a chart they do not own.
 */
export function createGovernedMeriToolsService(
  raw: MeriToolsService,
  prisma?: PrismaService,
): MeriToolsService {
  const present = async <T>(run: () => Promise<T>): Promise<T | Record<string, unknown>> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const rawResponse = error.getResponse();
      if (!rawResponse || typeof rawResponse !== 'object') throw error;
      const response = rawResponse as GovernedMemorySignal;

      if (response.code === 'memory_pending_review') {
        return {
          corrected: false,
          pendingReview: true,
          status: 'pending_review',
          title: typeof response.title === 'string' ? response.title : undefined,
          candidateId: typeof response.candidateId === 'string' ? response.candidateId : undefined,
          activeItemUnchanged: response.activeItemUnchanged === true,
          message:
            typeof response.message === 'string'
              ? response.message
              : 'The correction was submitted for independent review. Active memory is unchanged.',
        };
      }

      if (response.code === 'memory_duplicate') {
        return {
          corrected: false,
          duplicate: true,
          status: 'duplicate',
          title: typeof response.title === 'string' ? response.title : undefined,
          memoryItemId:
            typeof response.memoryItemId === 'string' ? response.memoryItemId : undefined,
          message:
            typeof response.message === 'string'
              ? response.message
              : 'No correction was needed because that content already controls this scope.',
        };
      }

      throw error;
    }
  };

  return new Proxy(raw, {
    get(target, property) {
      if (property === 'execute') {
        return (...args: Parameters<MeriToolsService['execute']>) =>
          present(async () => {
            const [ctx, name, input] = args;
            await assertOwnedChartArtifacts(prisma, ctx, String(name), input);
            return target.execute(...args);
          });
      }
      if (property === 'executeFromAuthenticatedUser') {
        return (...args: Parameters<MeriToolsService['executeFromAuthenticatedUser']>) =>
          present(async () => {
            const [ctx, name, input] = args;
            await assertOwnedChartArtifacts(prisma, ctx, String(name), input);
            return Promise.resolve(target.executeFromAuthenticatedUser(...args));
          });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
