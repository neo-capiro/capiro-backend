import type { PrismaService } from '../prisma/prisma.service.js';
import type { Logger } from '@nestjs/common';
import { toCanonicalAlert } from './canonical-alert.adapter.js';

export type PortfolioAlertsResult = {
  alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
  total: number;
  clientCount: number;
  generatedAt: string;
  /** Set when the request budget stopped the roll-up before every client ran. */
  partial?: true;
};

/** One roll-up: the promise it settles with, plus the switch that stops it. */
export interface PortfolioAlertsRun {
  result: Promise<PortfolioAlertsResult>;
  /**
   * Stop starting clients and profile sources and return what has been
   * aggregated so far, marked partial. In-flight source reads drain on their
   * own; `result` settles (also partial) once they do.
   */
  abort(): PortfolioAlertsResult;
}

export interface PortfolioAlertsPorts {
  cache(): Map<string, { expiresAt: number; value: unknown }>;
  inflight(): Map<string, Promise<unknown>>;
  gate(): Promise<unknown>;
  setGate(value: Promise<unknown>): void;
  ttlMs(): number;
  requestBudgetMs(): number;
  logger(): Pick<Logger, 'warn'>;
  emptyPortfolioAlerts(): PortfolioAlertsResult;
  withPortfolioAlertsRequestBudget(
    cacheKey: string,
    run: PortfolioAlertsRun,
  ): Promise<PortfolioAlertsResult>;
  computePortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    limit: number,
    maxClients: number,
  ): PortfolioAlertsRun;
  getClientProfileV1(
    clientId: string,
    tenantId: string,
    userId?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

type PortfolioClient = { id: string; name: string };

/** A roll-up stopped at the budget is retried sooner than a complete one. */
export const PORTFOLIO_ALERTS_PARTIAL_TTL_MS = 20_000;

export class IntelligencePortfolioAlerts {
  /** Per-tenant run counter; rotates where each roll-up starts in the roster. */
  private readonly rosterTurns = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: PortfolioAlertsPorts,
  ) {}

  emptyPortfolioAlerts(): PortfolioAlertsResult {
    return {
      alerts: [],
      total: 0,
      clientCount: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Race the roll-up against the hard request budget. At the budget the run
   * is aborted and the request answers with the partial roll-up, so the
   * dashboard paints on time and no further client or source work starts.
   */
  async withPortfolioAlertsRequestBudget(
    cacheKey: string,
    run: PortfolioAlertsRun,
  ): Promise<PortfolioAlertsResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<PortfolioAlertsResult>((resolve) => {
      timer = setTimeout(() => {
        this.ports
          .logger()
          .warn(
            `portfolio-alerts: exceeded ${this.ports.requestBudgetMs()}ms request budget for ${cacheKey}; stopping the roll-up and returning the partial result`,
          );
        resolve(run.abort());
      }, this.ports.requestBudgetMs());
      timer.unref?.();
    });
    try {
      return await Promise.race([run.result, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getPortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    opts?: { limit?: number; maxClients?: number },
  ): Promise<PortfolioAlertsResult> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 12, 50));
    // Cap the number of clients we will aggregate per roll-up. Each client runs
    // the full profile-v1 fan-out, so this is the dominant cost. Kept modest by
    // default; raise only with the cron-precompute path (see note below).
    const maxClients = Math.max(1, Math.min(opts?.maxClients ?? 40, 200));
    const cacheKey = `${tenantId}:${userId ?? 'anon'}:${limit}:${maxClients}`;

    const cached = this.ports.cache().get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as PortfolioAlertsResult;
    }

    // Coalesce concurrent callers for the same key onto one in-flight request —
    // a dashboard reload (or several open tabs) must not each launch their own
    // N-client roll-up. Whoever arrives first starts the run under the request
    // budget; everyone else awaits that same budgeted answer.
    const existing = this.ports.inflight().get(cacheKey);
    if (existing) return existing as Promise<PortfolioAlertsResult>;

    const run = this.ports.computePortfolioAlerts(tenantId, userId, limit, maxClients);
    const settled = run.result
      .then((result) => {
        // A roll-up stopped at the budget is cached too, so the next polls do
        // not restart the fan-out, but for a shorter time: a partial (or the
        // empty one from a run aborted while gate-queued) must not stand for
        // the whole poll interval.
        const ttl = result.partial
          ? Math.min(this.ports.ttlMs(), PORTFOLIO_ALERTS_PARTIAL_TTL_MS)
          : this.ports.ttlMs();
        this.ports.cache().set(cacheKey, { expiresAt: Date.now() + ttl, value: result });
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

    // The in-flight entry is the budgeted answer, and it stays until the run
    // has fully settled and cached: callers arriving after the budget fired
    // get the partial result immediately instead of a new fan-out.
    const response = this.ports.withPortfolioAlertsRequestBudget(cacheKey, {
      result: settled,
      abort: () => run.abort(),
    });
    this.ports.inflight().set(cacheKey, response);
    return response;
  }

  computePortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    limit: number,
    maxClients: number,
  ): PortfolioAlertsRun {
    const controller = new AbortController();
    const { signal } = controller;
    let clients: PortfolioClient[] = [];
    const tagged: PortfolioAlertsResult['alerts'] = [];
    // The roster is alphabetical and the budget stops the serial walk early,
    // so each run starts one client further along; successive runs cover
    // different parts of the roster instead of starving its tail.
    const turn = this.rosterTurns.get(tenantId) ?? 0;
    this.rosterTurns.set(tenantId, turn + 1);

    const run = async () => {
      // Aborted while queued behind another roll-up: never start the fan-out.
      if (signal.aborted) return this.projectPortfolioAlerts(tagged, clients, limit, true);

      // Active (non-archived) clients for the tenant.
      const roster = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({
          where: { status: { not: 'archived' } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
          take: maxClients,
        }),
      );
      const start = roster.length > 0 ? turn % roster.length : 0;
      clients = [...roster.slice(start), ...roster.slice(0, start)];

      // SERIAL: one client aggregate at a time. Never parallelize here — the
      // per-client profile-v1 already fans out widely; running several at once
      // is what starved the pool.
      for (const client of clients) {
        if (signal.aborted) break;
        try {
          await this.tagClientAlerts(client, tenantId, userId, signal, tagged);
        } catch (err) {
          // The budget stopped this client's profile; its alerts are simply
          // not part of this roll-up.
          if (signal.aborted) break;
          this.ports
            .logger()
            .warn(
              `portfolio-alerts: profile-v1 failed for client ${client.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
        }
      }

      return this.projectPortfolioAlerts(tagged, clients, limit, signal.aborted);
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
    return {
      result: gated,
      abort: () => {
        controller.abort();
        // Snapshot a copy: the loop may still append the client in flight.
        return this.projectPortfolioAlerts([...tagged], clients, limit, true);
      },
    };
  }

  /** Append one client's profile-v1 top alerts, tagged for the cross-client list. */
  private async tagClientAlerts(
    client: PortfolioClient,
    tenantId: string,
    userId: string | undefined,
    signal: AbortSignal,
    tagged: PortfolioAlertsResult['alerts'],
  ): Promise<void> {
    const profile = (await this.ports.getClientProfileV1(client.id, tenantId, userId, signal)) as {
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
  }

  private projectPortfolioAlerts(
    tagged: PortfolioAlertsResult['alerts'],
    clients: PortfolioClient[],
    limit: number,
    partial: boolean,
  ): PortfolioAlertsResult {
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
      ...(partial ? { partial: true as const } : {}),
    };
  }
}
