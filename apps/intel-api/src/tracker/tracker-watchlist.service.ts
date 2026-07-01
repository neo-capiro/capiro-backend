import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { MIN_TERM_LEN } from '../watchlist/watchlist-mapping.js';
import { compileWatchlist, type CompiledWatchlist } from '../watchlist/watchlist-compiler.js';

/**
 * Read/write API for the UNIFIED tracker watchlist (Phase 2, plan §5.2).
 *
 * Operates on the deterministic-id watchlist `wl:<clientId>` + its topics/terms
 * and the per-user `intel_alert_preference`. intel-api has no RLS, so every
 * query filters by the TenantGuard-resolved `tenantId` (app-code isolation).
 * All routes are gated by `tracker_owner_intel` (TrackerOwnerGuard, 404 when
 * off), so during shadow only the internal tenant can write here — apps/api
 * stays source of truth (D6).
 */
export interface TrackerTermInput {
  termType: string;
  value: string;
}
export interface TrackerTopicInput {
  label: string;
  issueArea?: string | null;
  position?: string;
  priority?: string;
  terms?: TrackerTermInput[];
}
export interface PutWatchlistInput {
  issueAreas?: string[];
  topics?: TrackerTopicInput[];
}
export interface WatchlistView {
  clientId: string;
  issueAreas: string[];
  topics: Array<{
    label: string;
    issueArea: string | null;
    position: string;
    priority: string;
    terms: Array<{ termType: string; value: string }>;
  }>;
}
export interface PutAlertPrefsInput {
  triggers?: string[];
  materiality?: string;
  emailEnabled?: boolean;
  emailAddress?: string | null;
  emailCadence?: string;
  smsEnabled?: boolean;
  smsPhone?: string | null;
  smsCadence?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

@Injectable()
export class TrackerWatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  async getWatchlist(tenantId: string, clientId: string): Promise<WatchlistView> {
    const wlId = `wl:${clientId}`;
    const wl = await this.prisma.watchlist.findFirst({
      where: { id: wlId, tenantId },
      select: { issueAreas: true },
    });
    if (!wl) return { clientId, issueAreas: [], topics: [] };
    const topics = await this.prisma.watchlistTopic.findMany({
      where: { watchlistId: wlId, tenantId },
      select: { id: true, label: true, issueArea: true, position: true, priority: true },
    });
    const terms = topics.length
      ? await this.prisma.watchlistTerm.findMany({
          where: { topicId: { in: topics.map((t) => t.id) } },
          select: { topicId: true, termType: true, value: true },
        })
      : [];
    return {
      clientId,
      issueAreas: wl.issueAreas,
      topics: topics.map((t) => ({
        label: t.label,
        issueArea: t.issueArea,
        position: t.position,
        priority: t.priority,
        terms: terms.filter((x) => x.topicId === t.id).map((x) => ({ termType: x.termType, value: x.value })),
      })),
    };
  }

  /** Upsert the watchlist head + replace topics/terms atomically. */
  async putWatchlist(
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutWatchlistInput,
  ): Promise<WatchlistView> {
    const wlId = `wl:${clientId}`;
    const issueAreas = Array.isArray(input.issueAreas) ? input.issueAreas : [];
    const topics = Array.isArray(input.topics) ? input.topics : [];
    await this.prisma.$transaction(async (tx) => {
      await tx.watchlist.upsert({
        where: { id: wlId },
        create: { id: wlId, tenantId, clientId, name: 'Watchlist', createdBy: userId, issueAreas },
        update: { issueAreas },
      });
      await tx.watchlistTopic.deleteMany({ where: { watchlistId: wlId } });
      for (const tp of topics) {
        if (!tp?.label?.trim()) continue;
        const topic = await tx.watchlistTopic.create({
          data: {
            watchlistId: wlId,
            tenantId,
            label: tp.label.trim(),
            issueArea: tp.issueArea ?? null,
            position: tp.position ?? 'monitor',
            priority: tp.priority ?? 'med',
          },
        });
        const rows = (tp.terms ?? [])
          .filter((t) => t?.value && t.value.trim().length >= MIN_TERM_LEN && t.termType)
          .map((t) => ({ watchlistId: wlId, tenantId, topicId: topic.id, termType: t.termType, value: t.value.trim() }));
        if (rows.length) await tx.watchlistTerm.createMany({ data: rows });
      }
    });
    return this.getWatchlist(tenantId, clientId);
  }

  async getAlertPrefs(tenantId: string, clientId: string, userId: string) {
    const row = await this.prisma.intelAlertPreference.findUnique({
      where: { userId_clientId: { userId, clientId } },
    });
    if (row && row.tenantId === tenantId) return row;
    return {
      clientId,
      userId,
      triggers: [] as string[],
      materiality: 'medium',
      emailEnabled: false,
      emailAddress: null,
      emailCadence: 'realtime',
      smsEnabled: false,
      smsPhone: null,
      smsPhoneVerified: false,
      smsCadence: 'realtime',
      quietHoursStart: null,
      quietHoursEnd: null,
    };
  }

  async putAlertPrefs(tenantId: string, clientId: string, userId: string, input: PutAlertPrefsInput) {
    const data = {
      triggers: input.triggers ?? [],
      materiality: input.materiality ?? 'medium',
      emailEnabled: input.emailEnabled ?? false,
      emailAddress: input.emailAddress ?? null,
      emailCadence: input.emailCadence ?? 'realtime',
      smsEnabled: input.smsEnabled ?? false,
      smsPhone: input.smsPhone ?? null,
      smsCadence: input.smsCadence ?? 'realtime',
      quietHoursStart: input.quietHoursStart ?? null,
      quietHoursEnd: input.quietHoursEnd ?? null,
    };
    return this.prisma.intelAlertPreference.upsert({
      where: { userId_clientId: { userId, clientId } },
      create: { tenantId, clientId, userId, ...data },
      update: data,
    });
  }

  async getCompiled(tenantId: string, clientId: string): Promise<CompiledWatchlist> {
    const wl = await this.getWatchlist(tenantId, clientId);
    return compileWatchlist({
      issueAreas: wl.issueAreas,
      topics: wl.topics.map((t) => ({ label: t.label, issueArea: t.issueArea, position: t.position, priority: t.priority })),
      terms: wl.topics.flatMap((t) =>
        t.terms.map((x) => ({ termType: x.termType, value: x.value, weight: 1, topicLabel: t.label })),
      ),
    });
  }
}
