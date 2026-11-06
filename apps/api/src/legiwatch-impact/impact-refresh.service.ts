import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImpactService } from './impact.service.js';
import { ImpactRepository } from './impact.repository.js';
import { ImpactEvidenceService } from './impact-evidence.service.js';
import {
  ImpactRefreshRepository, IMPACT_REFRESH_CHECK_MS, IMPACT_REFRESH_MAX_ATTEMPTS,
  type ImpactRefreshClaim, type ImpactRefreshError,
} from './impact-refresh.repository.js';

export interface ImpactRefreshOptions {
  limit: number; discoveryLimit: number; timeoutMs: number; analysisTimeoutMs: number;
}
export const IMPACT_REFRESH_TRANSACTION_ALLOWANCE_MS = 90_000;
export function impactRefreshRetryMs(attempts: number) {
  return Math.min(IMPACT_REFRESH_CHECK_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** One scheduler invocation. Reads never enqueue and no process-local timer owns durable work. */
@Injectable()
export class ImpactRefreshService {
  constructor(private readonly prisma: PrismaService, private readonly queue: ImpactRefreshRepository,
    private readonly impact: ImpactService, private readonly repository: ImpactRepository,
    private readonly evidence: ImpactEvidenceService) {}

  async request(ctx: TenantContext, clientId: string, billId: string) {
    // Keep authorization and enqueue atomic, including current membership/client/wall locks.
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
      await this.repository.row(tx, ctx, clientId, billId);
      await this.queue.enqueue(tx, ctx, clientId, billId);
    }, { timeoutMs: 20_000 });
    return this.impact.detail(ctx, clientId, billId);
  }

  async run(options: ImpactRefreshOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
      !Number.isInteger(options.discoveryLimit) || options.discoveryLimit < 1 || options.discoveryLimit > 1000 ||
      !Number.isInteger(options.analysisTimeoutMs) || options.analysisTimeoutMs < 1_000 || options.analysisTimeoutMs > 120_000 ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 60_000 || options.timeoutMs > 900_000)
      throw new Error('INVALID_IMPACT_REFRESH_OPTIONS');
    const deadline = Date.now() + options.timeoutMs;
    const leaseMs = options.analysisTimeoutMs + IMPACT_REFRESH_TRANSACTION_ALLOWANCE_MS;
    const discovered = await this.queue.discover(options.discoveryLimit);
    const counts = { discovered, checked: 0, analyzed: 0, unchanged: 0, failed: 0 };
    while (counts.checked < options.limit && Date.now() + leaseMs <= deadline) {
      const claim = await this.queue.claim(leaseMs);
      if (!claim) break;
      const outcome = await this.process(claim, Math.min(deadline, Date.now() + leaseMs));
      counts.checked++;
      counts[outcome]++;
    }
    return counts;
  }

  private async process(claim: ImpactRefreshClaim, deadline: number): Promise<'analyzed' | 'unchanged' | 'failed'> {
    let fingerprint = claim.observedFingerprint;
    let attempts = claim.attempts;
    let attemptRecorded = false;
    try {
      const ctx = await this.queue.actor(claim);
      if (!ctx) return this.fail(claim, fingerprint, IMPACT_REFRESH_MAX_ATTEMPTS, 'actor_unavailable');
      const current = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
        const row = await this.repository.row(tx, ctx, claim.clientId, claim.billId);
        const snapshot = await this.evidence.load(tx, ctx, claim.clientId, claim.billId);
        return { analysis: row.analysis, fingerprint: snapshot.fingerprint };
      }, { timeoutMs: 20_000 });
      fingerprint = current.fingerprint;
      if (fingerprint !== claim.observedFingerprint) attempts = 0;
      const settled = current.analysis?.inputFingerprint === fingerprint &&
        (current.analysis.status === 'ready' || (current.analysis.status === 'needs_evidence' && !claim.forceRefresh));
      if (settled) {
        await this.queue.finish(claim, { fingerprint, error: null, attempts: 0, delayMs: IMPACT_REFRESH_CHECK_MS });
        return 'unchanged';
      }
      if (attempts >= IMPACT_REFRESH_MAX_ATTEMPTS)
        return this.fail(claim, fingerprint, attempts, 'attempts_exhausted');
      attempts = await this.queue.beginAttempt(claim, fingerprint);
      attemptRecorded = true;
      const detail = await this.impact.analyze(ctx, claim.clientId, claim.billId, async tx => {
        if (Date.now() >= deadline) throw new ConflictException('Impact refresh deadline expired');
        await this.queue.assertClaim(tx, claim);
      });
      if (detail.row.impact.status === 'unavailable')
        return this.fail(claim, fingerprint, attempts, 'analysis_unavailable');
      if (detail.row.impact.stale || detail.row.impact.inputFingerprint !== fingerprint)
        return this.fail(claim, fingerprint, attempts, 'evidence_changed');
      await this.queue.finish(claim, { fingerprint, error: null, attempts: 0, delayMs: IMPACT_REFRESH_CHECK_MS });
      return 'analyzed';
    } catch (error) {
      const code: ImpactRefreshError = error instanceof ForbiddenException || error instanceof NotFoundException
        ? 'access_denied' : error instanceof ConflictException ? 'evidence_changed' : 'refresh_failed';
      return this.fail(claim, fingerprint, code === 'access_denied' ? IMPACT_REFRESH_MAX_ATTEMPTS : attempts + (attemptRecorded ? 0 : 1), code);
    }
  }

  private async fail(claim: ImpactRefreshClaim, fingerprint: string | null, attempts: number, error: ImpactRefreshError): Promise<'failed'> {
    const bounded = Math.min(IMPACT_REFRESH_MAX_ATTEMPTS, attempts);
    await this.queue.finish(claim, { fingerprint, error, attempts: bounded,
      delayMs: bounded >= IMPACT_REFRESH_MAX_ATTEMPTS ? IMPACT_REFRESH_CHECK_MS : impactRefreshRetryMs(bounded) });
    return 'failed';
  }
}
