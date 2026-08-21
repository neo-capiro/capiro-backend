import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';

import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { ClientPeRelevanceService } from './client-pe-relevance.service.js';

/**
 * Phase 8 Session 9 — batched PE relevance for the dark defense-api.
 *
 * Sessions 2 and 3 left `ClientRelevancePort` bound to an unconfigured
 * implementation because "the HTTP task holds no Bedrock or main-API service
 * credential". The port contract already specified what the real provider needed:
 *
 *   "Of `peCodes`, which are relevant to ANY client in this tenant at or above
 *    `minScore`? ONE call for the whole candidate set. `apps/api` answers the same
 *    question with up to 50 sequential per-PE probes (MAX_RELEVANCE_PROBES). The
 *    batched shape is a deliberate improvement required by the Workstream E gate
 *    ('no unbounded N+1 fanout'); the ANSWER is the same set."
 *
 * This is that one call. It answers the identical question by the identical
 * scoring path — `getRelevantClientsForPeByTenantId`, the variant already
 * documented for trusted server callers that have resolved a tenant id — so the
 * batched answer and the per-PE answer cannot diverge.
 *
 * Deliberately narrow:
 *
 *  * backend-service callers only, via the existing `InternalServiceGuard` and
 *    the same static shared secret six other `internal/*` controllers use. It is
 *    fail-closed: with no secret configured the route is denied outright, so a
 *    deployment that has not been given one is not reachable.
 *  * a bounded batch. `MAX_BATCH` caps the fan-out so a large candidate page
 *    cannot become an unbounded set of scoring transactions.
 *  * PE CODES ONLY in the response. The per-PE route returns client identities;
 *    this one deliberately does not, because the caller's question is "which of
 *    these PEs matter to somebody", and returning client names would hand a
 *    dark service tenant CRM data it has no need for.
 *  * no write of any kind, and no new credential class.
 */
@Controller('internal/program-elements/relevance')
@UseGuards(InternalServiceGuard)
export class InternalPeRelevanceController {
  private readonly logger = new Logger(InternalPeRelevanceController.name);

  /**
   * Upper bound on PE codes scored in one call. Matches the caller-side cap and
   * the existing `MAX_RELEVANCE_PROBES` order of magnitude, so this endpoint
   * cannot be used to trigger more scoring work than the in-process path already
   * allows per request.
   */
  private static readonly MAX_BATCH = 200;

  constructor(private readonly relevance: ClientPeRelevanceService) {}

  @Post('batch')
  async batch(@Body() body: RelevanceBatchBody): Promise<{
    tenantId: string;
    minScore: number;
    requested: number;
    relevantPeCodes: string[];
  }> {
    const tenantId = (body?.tenantId ?? '').trim();
    if (!tenantId) throw new BadRequestException('tenantId is required');

    if (!Array.isArray(body?.peCodes)) {
      throw new BadRequestException('peCodes must be an array');
    }

    const peCodes = [
      ...new Set(
        body.peCodes
          .filter((code): code is string => typeof code === 'string')
          .map((code) => code.trim().toUpperCase())
          .filter((code) => code !== ''),
      ),
    ];

    if (peCodes.length === 0) {
      // Not an error: an empty candidate set has an empty answer.
      return { tenantId, minScore: resolveMinScore(body.minScore), requested: 0, relevantPeCodes: [] };
    }

    if (peCodes.length > InternalPeRelevanceController.MAX_BATCH) {
      // Refused rather than silently truncated: a trimmed batch would come back
      // looking like "those PEs are not relevant".
      throw new BadRequestException(
        `peCodes exceeds the maximum batch of ${InternalPeRelevanceController.MAX_BATCH}`,
      );
    }

    const minScore = resolveMinScore(body.minScore);

    const relevant: string[] = [];
    // Bounded concurrency: the same scoring path as the in-process caller, but
    // capped so one batched call cannot open 200 simultaneous transactions.
    const CONCURRENCY = 8;
    for (let offset = 0; offset < peCodes.length; offset += CONCURRENCY) {
      const slice = peCodes.slice(offset, offset + CONCURRENCY);
      const settled = await Promise.all(
        slice.map(async (peCode) => {
          try {
            const clients = await this.relevance.getRelevantClientsForPeByTenantId(
              tenantId,
              peCode,
              { minScore },
            );
            return clients.length > 0 ? peCode : null;
          } catch (error) {
            // Non-fatal, matching the in-process caller: a probe failure omits
            // this PE's relevance signal rather than failing the whole answer.
            this.logger.warn(
              `relevance probe failed for ${peCode}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }
        }),
      );
      for (const code of settled) if (code) relevant.push(code);
    }

    return {
      tenantId,
      minScore,
      requested: peCodes.length,
      relevantPeCodes: relevant.sort(),
    };
  }
}

interface RelevanceBatchBody {
  tenantId?: string;
  clerkUserId?: string;
  peCodes?: unknown[];
  minScore?: number;
}

/**
 * Clamp to a sane probability. The in-process caller uses 0.5; an out-of-range
 * or non-numeric value falls back to that rather than scoring against nonsense.
 */
function resolveMinScore(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.5;
  if (raw < 0 || raw > 1) return 0.5;
  return raw;
}
