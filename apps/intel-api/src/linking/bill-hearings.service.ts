import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Bill→Hearing interlink read (Phase 9). For a tracked bill, surfaces the
 * hearings that discussed it — derived from the `combined` intel_alert rows the
 * BillHearingLinkerService writes (one per bill×session), reading
 * `evidence.hearing` (sessionId/title/committeeId/occurredAt + per-mention
 * timestamp/speaker/quote/tags). No hot-path join to hearing tables: evidence is
 * denormalized at link time (§9.3).
 *
 * intel_alert has NO RLS → every query filters by BOTH tenantId AND clientId,
 * plus sourceType='combined' + sourceRef=billId (index [tenant, sourceType,
 * sourceRef]). Dismissed/snoozed alerts are excluded so an untracked/irrelevant
 * link stops showing.
 */

export interface BillHearingMention {
  segmentId: string | null;
  timestampMs: number | null;
  speakerName: string | null;
  quote: string | null;
  quoteSource?: string;
  issueTags: string[];
}
export interface BillHearing {
  sessionId: string;
  title: string | null;
  occurredAt: string | null;
  committeeId: string | null;
  mentions: BillHearingMention[];
}
export interface BillHearingsResult {
  count: number;
  hearings: BillHearing[];
}

type AlertRow = { sourceRef: string; evidence: unknown; createdAt: Date };

/**
 * Pure mapping: `combined` intel_alert rows → the bill's hearing list. One
 * hearing per distinct sessionId (dedup — the linker is per bill×session so this
 * is normally 1:1, but a resurrected/re-linked alert could repeat). Rows are
 * assumed newest-first; the first occurrence of a session wins. Exported for the
 * unit spec.
 */
export function mapCombinedAlertsToHearings(rows: AlertRow[]): BillHearingsResult {
  const bySession = new Map<string, BillHearing>();
  for (const row of rows) {
    const ev = (row.evidence ?? {}) as {
      hearing?: {
        sessionId?: string | null;
        title?: string | null;
        occurredAt?: string | null;
        committeeId?: string | null;
        mentions?: Array<{
          segmentId?: string | null;
          timestampMs?: number | null;
          speakerName?: string | null;
          quote?: string | null;
          quoteSource?: string;
          issueTags?: string[] | null;
        }>;
      };
    };
    const h = ev.hearing;
    const sessionId = h?.sessionId;
    if (!sessionId || bySession.has(sessionId)) continue;
    bySession.set(sessionId, {
      sessionId,
      title: h?.title ?? null,
      occurredAt: h?.occurredAt ?? null,
      committeeId: h?.committeeId ?? null,
      mentions: (h?.mentions ?? []).map((m) => ({
        segmentId: m?.segmentId ?? null,
        timestampMs: m?.timestampMs ?? null,
        speakerName: m?.speakerName ?? null,
        quote: m?.quote ?? null,
        quoteSource: m?.quoteSource,
        issueTags: m?.issueTags ?? [],
      })),
    });
  }
  const hearings = Array.from(bySession.values());
  return { count: hearings.length, hearings };
}

@Injectable()
export class BillHearingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Hearings that discussed a bill, for a (tenant, client). Tenant-scoped. */
  async getBillHearings(tenantId: string, clientId: string, billId: string): Promise<BillHearingsResult> {
    const rows = await this.prisma.intelAlert.findMany({
      where: {
        tenantId,
        clientId,
        sourceType: 'combined',
        sourceRef: billId,
        status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { sourceRef: true, evidence: true, createdAt: true },
    });
    return mapCombinedAlertsToHearings(rows);
  }
}
