import type { PrismaService } from '../prisma/prisma.service.js';
import type { Logger } from '@nestjs/common';
import { toCanonicalAlert } from './canonical-alert.adapter.js';

export type PortfolioAlertsResult = {
  alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
  total: number;
  clientCount: number;
  generatedAt: string;
};

export interface PortfolioAlertsPorts {
  cache(): Map<string, { expiresAt: number; value: unknown }>;
  inflight(): Map<string, Promise<unknown>>;
  gate(): Promise<unknown>;
  setGate(value: Promise<unknown>): void;
  ttlMs(): number;
  requestBudgetMs(): number;
  logger(): Pick<Logger, 'warn'>;
  emptyPortfolioAlerts(): PortfolioAlertsResult;
  withPortfolioAlertsRequestBudget<T extends PortfolioAlertsResult>(
    cacheKey: string,
    work: Promise<T>,
  ): Promise<T>;
  computePortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    limit: number,
    maxClients: number,
  ): Promise<PortfolioAlertsResult>;
  getClientProfileV1(clientId: string, tenantId: string, userId?: string): Promise<unknown>;
}

export class IntelligencePortfolioAlerts {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: PortfolioAlertsPorts,
  ) {}

  emptyPortfolioAlerts(): {
    alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
    total: number;
    clientCount: number;
    generatedAt: string;
  } {
    return {
      alerts: [],
      total: 0,
      clientCount: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  async withPortfolioAlertsRequestBudget<T extends PortfolioAlertsResult>(
    cacheKey: string,
    work: Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        this.ports
          .logger()
          .warn(
            `portfolio-alerts: exceeded ${this.ports.requestBudgetMs()}ms request budget for ${cacheKey}; failing open`,
          );
        resolve(this.ports.emptyPortfolioAlerts() as T);
      }, this.ports.requestBudgetMs());
      timer.unref?.();
    });
    try {
      return await Promise.race([work, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getPortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    opts?: { limit?: number; maxClients?: number },
  ): Promise<{
    alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
    total: number;
    clientCount: number;
    generatedAt: string;
  }> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 12, 50));
    // Cap the number of clients we will aggregate per roll-up. Each client runs
    // the full profile-v1 fan-out, so this is the dominant cost. Kept modest by
    // default; raise only with the cron-precompute path (see note below).
    const maxClients = Math.max(1, Math.min(opts?.maxClients ?? 40, 200));
    const cacheKey = `${tenantId}:${userId ?? 'anon'}:${limit}:${maxClients}`;

    const cached = this.ports.cache().get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as Awaited<ReturnType<typeof this.getPortfolioAlerts>>;
    }

    // Coalesce concurrent callers for the same key onto one in-flight promise —
    // a dashboard reload (or several open tabs) must not each launch their own
    // N-client roll-up. Whoever arrives first computes; everyone else awaits it
    // under the same request budget (so waiters also fail open).
    const existing = this.ports.inflight().get(cacheKey);
    if (existing) {
      return this.ports.withPortfolioAlertsRequestBudget(
        cacheKey,
        existing as Promise<Awaited<ReturnType<typeof this.getPortfolioAlerts>>>,
      );
    }

    const compute = this.ports
      .computePortfolioAlerts(tenantId, userId, limit, maxClients)
      .then((result) => {
        this.ports.cache().set(cacheKey, {
          expiresAt: Date.now() + this.ports.ttlMs(),
          value: result,
        });
        return result;
      })
      .catch((err) => {
        // Never leave the HTTP request hanging on an unexpected throw; fail open.
        this.ports
          .logger()
          .warn(
            `portfolio-alerts: compute failed for ${cacheKey}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        return this.ports.emptyPortfolioAlerts();
      })
      .finally(() => {
        this.ports.inflight().delete(cacheKey);
      });

    this.ports.inflight().set(cacheKey, compute);

    // Race the roll-up against a hard request budget. The in-flight map still
    // holds `compute` (not the raced promise) so a late success can populate
    // the TTL cache for the next caller even if this request already failed open.
    return this.ports.withPortfolioAlertsRequestBudget(cacheKey, compute);
  }

  computePortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    limit: number,
    maxClients: number,
  ): Promise<{
    alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
    total: number;
    clientCount: number;
    generatedAt: string;
  }> {
    const run = async () => {
      // Active (non-archived) clients for the tenant.
      const clients = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({
          where: { status: { not: 'archived' } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
          take: maxClients,
        }),
      );

      // SERIAL: one client aggregate at a time. Never parallelize here — the
      // per-client profile-v1 already fans out widely; running several at once
      // is what starved the pool.
      const tagged: Array<Record<string, unknown> & { clientId: string; clientName: string }> = [];
      for (const client of clients) {
        try {
          const profile = (await this.ports.getClientProfileV1(client.id, tenantId, userId)) as {
            sections?: { snapshot?: { topAlerts?: Array<Record<string, unknown>> } };
          };
          const topAlerts = profile?.sections?.snapshot?.topAlerts ?? [];
          for (const alert of topAlerts) {
            // Canonical 7-field Alert sidecar (SC1.1/SC1.2): completeness flags
            // ride along; rows are NEVER filtered or hidden on incompleteness.
            const canonical = toCanonicalAlert(alert, client.id);
            tagged.push({
              ...alert,
              // Namespace the id with the client so identical alert ids across
              // clients (e.g. the same FedReg doc) stay distinct in the list.
              id: `${client.id}:${String(alert.id ?? '')}`,
              clientId: client.id,
              clientName: client.name,
              canonicalComplete: canonical.complete,
              canonicalMissingFields: canonical.missingFields,
            });
          }
        } catch (err) {
          this.ports
            .logger()
            .warn(
              `portfolio-alerts: profile-v1 failed for client ${client.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
        }
      }

      // Global re-rank: severity, then soonest deadline (countdownDays asc when
      // present), then most-recent `when`. Mirrors the per-client ordering
      // intent while making cross-client urgency comparable.
      return this.projectPortfolioAlerts(tagged, clients, limit);
    };

    // Chain onto the process-wide gate so roll-ups never overlap. We attach the
    // next run regardless of whether the previous settled ok, and we keep the
    // gate from rejecting (a failed run must not poison the chain).
    const gated = this.ports.gate().then(run, run);
    this.ports.setGate(
      gated.then(
        () => undefined,
        () => undefined,
      ),
    );
    return gated;
  }

  private projectPortfolioAlerts(
    tagged: PortfolioAlertsResult['alerts'],
    clients: Array<{ id: string; name: string }>,
    limit: number,
  ) {
    // Global re-rank: severity, then soonest deadline (countdownDays asc when
    // present), then most-recent `when`. Mirrors the per-client ordering
    // intent while making cross-client urgency comparable.
    const sevRank = (s: unknown): number => {
      const v = String(s ?? '').toLowerCase();
      if (v === 'critical') return 0;
      if (v === 'notable') return 1;
      return 2;
    };

    tagged.sort((a, b) => {
      const sev = sevRank(a.severity) - sevRank(b.severity);
      if (sev !== 0) return sev;
      const ad = typeof a.countdownDays === 'number' ? a.countdownDays : Number.POSITIVE_INFINITY;
      const bd = typeof b.countdownDays === 'number' ? b.countdownDays : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return String(b.when ?? '').localeCompare(String(a.when ?? ''));
    });

    return {
      alerts: tagged.slice(0, limit),
      total: tagged.length,
      clientCount: clients.length,
      generatedAt: new Date().toISOString(),
    };
  }
}
