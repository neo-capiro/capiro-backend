import { NotFoundException } from '@nestjs/common';
import { AGENCY_SECTOR_MAP, normalizeSector, type SectorTag } from '@capiro/shared';
import type { FederalRegisterDocument } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import { dateBoundsInZone } from './time-bounds.js';
import type { TrackedBillsResult } from './intelligence-bill-discovery.shared.js';
import { addCapabilityKeywords } from './client-alerts-v1.shared.js';
import type { AlertRow, ClientAlertsPorts } from './client-alerts-v1.shared.js';

/** Per-client hearing/overdue/competitor alert reads and per-user worklist state. */
export class ClientAlertsV1 {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientAlertsPorts,
  ) {}

  alertCountdownLabel(days: number | null): string | null {
    if (days == null) return null;
    if (days < 0) return `Overdue ${Math.abs(days)}d`;
    if (days === 0) return 'Due today';
    if (days === 1) return '1d left';
    return `${days}d left`;
  }

  async getClientIssueCodes(clientId: string, tenantId: string): Promise<string[]> {
    // Phase 4c: union issue codes across the FULL confirmed LDA id set.
    const ldaClientIds = await this.ports.confirmedLdaIds(clientId, tenantId);
    return this.ports.issueCodesForLdaIds(ldaClientIds);
  }

  async getHearingAlerts(
    clientId: string,
    tenantId: string,
    now: Date,
    until: Date,
    precomputedTracked?: Promise<Awaited<TrackedBillsResult>> | Awaited<TrackedBillsResult>,
  ): Promise<AlertRow[]> {
    try {
      // Tracked bills give us the bill identifiers + the committees of jurisdiction
      // to match hearings against (same signal the removed Hearings panel used).
      const tracked = await (precomputedTracked ?? this.ports.getTrackedBills(clientId, tenantId));
      const billVariants = (tracked.bills ?? []).map((b) => ({
        identifier: b.identifier,
        // "hr-1234" / "hr 1234" / "h.r. 1234" style variants for title matching.
        variants: [
          b.identifier.toLowerCase(),
          b.identifier.toLowerCase().replace(/-/g, ' '),
          b.identifier.toLowerCase().replace(/-/g, '.'),
        ],
      }));
      if (billVariants.length === 0) return [];

      const hearings = await this.prisma.committeeHearing.findMany({
        // Start-of-Eastern-day, not `now`: see the note at the portfolio feed above.
        // `date` is a UTC-midnight @db.Date, so `gte: now` dropped today's rows.
        where: federalHearingWhere({
          date: { gte: dateBoundsInZone(now, 'America/New_York').start, lte: until },
        }),
        orderBy: [{ date: 'asc' }, { time: 'asc' }],
        take: 40,
      });

      const out: AlertRow[] = [];
      for (const h of hearings) {
        const titleLower = h.title.toLowerCase();
        const linked = billVariants
          .filter((b) => b.variants.some((v) => titleLower.includes(v)))
          .map((b) => b.identifier);
        if (linked.length === 0) continue; // keep only client-relevant hearings
        const d = new Date(h.date);
        const days = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const severity = days < 3 ? 'critical' : days <= 7 ? 'notable' : 'info';
        out.push({
          id: `hearing:${h.id}`,
          type: 'hearing',
          severity,
          title: `${h.committeeName}: ${h.title}`.slice(0, 140),
          subtitle: `${h.chamber} ${h.type ?? 'hearing'} · ${linked.slice(0, 3).join(', ')}`,
          when: d.toISOString(),
          countdownDays: days,
          countdownLabel: this.ports.alertCountdownLabel(days),
          href: `/intelligence/bills/${encodeURIComponent(linked[0] ?? '')}?clientId=${encodeURIComponent(clientId)}`,
          _urgencyScore: 100 - Math.max(-30, Math.min(days, 100)),
          _typeRank: 2,
        });
      }
      return out;
    } catch (err) {
      this.ports
        .logger()
        .warn(
          `getHearingAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      return [];
    }
  }

  async getOverdueCommentAlerts(
    clientId: string,
    tenantId: string,
    now: Date,
    lookbackStart: Date,
  ): Promise<AlertRow[]> {
    try {
      const client = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: {
            id: true,
            name: true,
            sectorTag: true,
            capabilities: { select: { sector: true, tags: true, name: true } },
          },
        }),
      );
      if (!client) return [];
      const docs = await this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gte: lookbackStart, lt: now },
        },
        orderBy: { commentEndDate: 'desc' },
        take: 40,
      });
      if (!docs.length) return [];
      const capKeywords = new Set<string>();
      if (client.sectorTag) capKeywords.add(String(client.sectorTag).toLowerCase());
      addCapabilityKeywords(capKeywords, client.capabilities);
      const normalizedClientSector = normalizeSector(client.sectorTag);
      return this.projectOverdueComments(clientId, now, docs, capKeywords, normalizedClientSector);
    } catch (err) {
      this.ports
        .logger()
        .warn(
          `getOverdueCommentAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      return [];
    }
  }

  private projectOverdueComments(
    clientId: string,
    now: Date,
    docs: FederalRegisterDocument[],
    capKeywords: Set<string>,
    normalizedClientSector: SectorTag | null,
  ) {
    const out: AlertRow[] = [];
    for (const doc of docs) {
      const agencies = (doc.agencyNames as string[]) ?? [];
      const docSectors = new Set<SectorTag>();
      for (const agency of agencies) {
        for (const sector of AGENCY_SECTOR_MAP[agency] ?? []) docSectors.add(sector);
      }
      let relevant = false;
      if (normalizedClientSector && docSectors.has(normalizedClientSector)) relevant = true;
      if (!relevant) {
        const topics = Array.isArray(doc.topics) ? (doc.topics as string[]) : [];
        for (const topic of topics) {
          const tl = topic.toLowerCase();
          for (const kw of capKeywords) {
            if (tl.includes(kw) || kw.includes(tl)) {
              relevant = true;
              break;
            }
          }
          if (relevant) break;
        }
      }
      if (!relevant) continue;

      const days = Math.ceil(
        (doc.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      ); // negative
      out.push({
        id: `comment_overdue:${doc.id}`,
        type: 'comment_overdue',
        severity: 'notable',
        title: `Deadline closed: ${doc.title}`.slice(0, 140),
        subtitle: agencies.slice(0, 2).join(' / ') || 'Federal Register',
        when: doc.commentEndDate!.toISOString(),
        countdownDays: days,
        countdownLabel: this.ports.alertCountdownLabel(days),
        href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&source=comment_overdue`,
        _urgencyScore: 30, // recently lapsed: notable but below live deadlines
        _typeRank: 2,
      });
    }
    return out.slice(0, 5);
  }

  async getCompetitorLdaAlerts(
    clientId: string,
    tenantId: string,
    since: Date,
  ): Promise<AlertRow[]> {
    try {
      const issueCodes = await this.ports.getClientIssueCodes(clientId, tenantId);
      if (issueCodes.length === 0) return [];

      // The client's own LDA client name(s) so we exclude their own filings.
      const client = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({ where: { id: clientId }, select: { name: true } }),
      );
      const ownName = (client?.name ?? '').trim().toLowerCase();

      const filings = await this.prisma.ldaFiling.findMany({
        where: {
          dtPosted: { gte: since },
          issueCodes: { hasSome: issueCodes },
        },
        orderBy: { dtPosted: 'desc' },
        take: 25,
      });

      const seenRegistrants = new Set<string>();
      const out: AlertRow[] = [];
      for (const f of filings) {
        const registrant = (f.registrantName ?? '').trim();
        const filingClient = (f.clientName ?? '').trim();
        // Skip the client's own filings (match on client name) and dedupe per registrant.
        if (ownName && filingClient.toLowerCase() === ownName) continue;
        const dedupeKey = `${registrant.toLowerCase()}|${filingClient.toLowerCase()}`;
        if (seenRegistrants.has(dedupeKey)) continue;
        seenRegistrants.add(dedupeKey);
        if (!f.dtPosted) continue;
        const overlap = (f.issueCodes ?? []).filter((c) => issueCodes.includes(c));
        out.push({
          id: `competitor:${f.id}`,
          type: 'competitor_filing',
          severity: 'info',
          title: `New lobbying filing: ${registrant || 'Unknown firm'}`,
          subtitle: `${filingClient || 'Undisclosed client'} · issues ${overlap.slice(0, 3).join(', ')}`,
          when: f.dtPosted.toISOString(),
          countdownDays: null,
          countdownLabel: null,
          href: `/intelligence/issues/${encodeURIComponent(overlap[0] ?? issueCodes[0] ?? '')}?clientId=${encodeURIComponent(clientId)}`,
          _urgencyScore: 10,
          _typeRank: 1,
        });
        if (out.length >= 5) break;
      }
      return out;
    } catch (err) {
      this.ports
        .logger()
        .warn(
          `getCompetitorLdaAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      return [];
    }
  }

  async setAlertState(
    tenantId: string,
    userId: string,
    clientId: string,
    alertId: string,
    state: 'acknowledged' | 'dismissed' | 'snoozed',
    snoozedUntil?: Date | null,
  ) {
    // Verify the client belongs to the tenant (RLS also enforces, but fail fast).
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const resolvedSnooze = state === 'snoozed' ? (snoozedUntil ?? null) : null;
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.alertState.upsert({
        where: { userId_clientId_alertId: { userId, clientId, alertId } },
        create: { tenantId, userId, clientId, alertId, state, snoozedUntil: resolvedSnooze },
        update: { state, snoozedUntil: resolvedSnooze },
        select: { id: true, alertId: true, state: true, snoozedUntil: true },
      }),
    );
  }

  async clearAlertState(tenantId: string, userId: string, clientId: string, alertId: string) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertState.deleteMany({ where: { userId, clientId, alertId } }),
    );
    return { ok: true };
  }
}
