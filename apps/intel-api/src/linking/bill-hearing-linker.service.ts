import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SEVERITY_RANK, type AlertSeverity } from '../intel-alert/intel-alert.types.js';
import { billStage, currentCongress } from '../tracker/bill-stage.util.js';
import { humanizeBillId } from '../tracker/relevance.util.js';

/**
 * Bill↔Hearing linker (Phase 6 §9.2/§9.4). For a hearing session, links each
 * tracked bill discussed in it to a `combined` intel_alert (idempotent on
 * dedupe_key), carrying both sides in evidence so the feed needs no hot-path join.
 *
 * SHADOW-safe: writes intel_alert status='new', delivers nothing. Reads GLOBAL
 * congress_bill read-only (raw SQL, no writes — D2). Authoritative bill source is
 * the session's curated `billIds[]` (canonical congress_bill.id); bill entity
 * mentions (entityType='bill') are a best-effort secondary signal, canonicalized
 * and existence-checked before use. Does NOT decrypt transcripts (§9.3).
 */

const BILL_TYPE_TOKENS = new Set(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres']);

/**
 * Best-effort canonicalize a hearing bill reference → congress_bill.id form
 * ("119-hr-1234"). The extractor emits display strings ("H.R. 1234") with NO
 * congress, so we resolve the congress by matching the session's canonical
 * billIds first, else fall back to the current congress. Returns null if the ref
 * isn't a recognizable bill token (caller drops it; existence is verified after).
 */
export function canonicalizeBillRef(ref: string, sessionBillIds: string[], congress: number): string | null {
  const raw = (ref ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+-[a-z]+-\d+$/.test(raw)) return raw; // already canonical
  const cleaned = raw.replace(/[.\s]+/g, ''); // "h.r. 1234" → "hr1234"
  const m = /^([a-z]+?)(\d+)$/.exec(cleaned);
  if (!m) return null;
  const type = m[1] ?? '';
  const num = m[2] ?? '';
  if (!BILL_TYPE_TOKENS.has(type)) return null;
  const hit = sessionBillIds.find((b) => {
    const p = b.split('-');
    return p[1] === type && p[2] === num;
  });
  if (hit) return hit;
  return `${congress}-${type}-${num}`;
}

const maxSeverity = (...sevs: Array<string | undefined | null>): AlertSeverity => {
  let best: AlertSeverity = 'notable'; // a tracked bill discussed at a hearing is notable by default
  let bestRank = SEVERITY_RANK.notable;
  for (const s of sevs) {
    const rank = SEVERITY_RANK[(s ?? '') as AlertSeverity];
    if (rank && rank > bestRank) {
      bestRank = rank;
      best = s as AlertSeverity;
    }
  }
  return best;
};

export interface LinkSessionResult {
  combined: number;
  skipped: boolean;
}
export interface LinkSweepResult {
  sessions: number;
  combined: number;
  skipped: number;
}

interface BillRow {
  id: string;
  title: string | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  url: string | null;
}

@Injectable()
export class BillHearingLinkerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sweep hearing sessions ended since an ISO time (default: all with billIds). */
  async linkAll(sinceIso?: string): Promise<LinkSweepResult> {
    const since = sinceIso ? new Date(sinceIso) : undefined;
    const sessions = await this.prisma.liveHearingSession.findMany({
      where: since ? { endedAt: { gte: since } } : {},
      select: { id: true, tenantId: true },
      orderBy: { endedAt: 'desc' },
    });
    let combined = 0;
    let skipped = 0;
    for (const s of sessions) {
      const r = await this.linkSession(s.tenantId, s.id);
      combined += r.combined;
      if (r.skipped) skipped += 1;
    }
    return { sessions: sessions.length, combined, skipped };
  }

  /**
   * Link one session's tracked bills → combined alerts. Whole op in ONE tx under
   * a per-session advisory xact-lock (efficiency backstop); dedupe_key upsert is
   * the correctness backstop.
   */
  async linkSession(tenantId: string, sessionId: string): Promise<LinkSessionResult> {
    return this.prisma.$transaction(async (tx) => {
      const lock = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        `link:${sessionId}`,
      );
      if (!lock[0]?.locked) return { combined: 0, skipped: true };

      const session = await tx.liveHearingSession.findUnique({
        where: { id: sessionId },
        select: { clientId: true, billIds: true, title: true, committeeId: true, startedAt: true, endedAt: true },
      });
      if (!session) return { combined: 0, skipped: false };

      // Candidate bill refs: curated billIds (canonical) ∪ canonicalized bill mentions.
      const mentions = await tx.entityMention.findMany({
        where: { sessionId, entityType: 'bill', entityRef: { not: null } },
        select: { entityRef: true, segmentId: true },
      });
      const congress = currentCongress();
      const mentionsByBill = new Map<string, Array<{ segmentId: string | null }>>();
      for (const m of mentions) {
        const canon = canonicalizeBillRef(m.entityRef ?? '', session.billIds, congress);
        if (!canon) continue;
        const arr = mentionsByBill.get(canon) ?? [];
        arr.push({ segmentId: m.segmentId });
        mentionsByBill.set(canon, arr);
      }
      const candidateIds = Array.from(new Set([...session.billIds, ...mentionsByBill.keys()]));
      if (!candidateIds.length) return { combined: 0, skipped: false };

      // Existence + evidence fields from GLOBAL congress_bill (raw SQL, read-only).
      const bills = await tx.$queryRawUnsafe<BillRow[]>(
        `SELECT id, title, latest_action_text AS "latestActionText",
                latest_action_date AS "latestActionDate", url
           FROM congress_bill WHERE id = ANY($1::text[])`,
        candidateIds,
      );
      if (!bills.length) return { combined: 0, skipped: false };

      // Resolve mention segments once (speaker/quote/tags per §9.3 — no decryption).
      const segIds = Array.from(
        new Set(
          [...mentionsByBill.values()].flat().map((x) => x.segmentId).filter((x): x is string => Boolean(x)),
        ),
      );
      const segs = segIds.length
        ? await tx.transcriptSegment.findMany({
            where: { id: { in: segIds } },
            select: { id: true, startMs: true, resolvedSpeakerName: true, textPlain: true, issueTags: true },
          })
        : [];
      const segById = new Map(segs.map((s) => [s.id, s]));

      const occurredAt = session.endedAt ?? session.startedAt ?? null;
      let combined = 0;

      for (const bill of bills) {
        // Tracked bills covering this bill for the session's client scope.
        const tracked = await tx.trackedBill.findMany({
          where: {
            tenantId,
            billId: bill.id,
            ...(session.clientId ? { clientId: session.clientId } : {}),
          },
          select: { id: true, clientId: true },
        });
        if (!tracked.length) continue; // non-tracked bill mentioned at a hearing → skip

        const displayNum = humanizeBillId(bill.id);
        const stage = billStage(bill.latestActionText);
        const billMentions = mentionsByBill.get(bill.id) ?? [];

        for (const t of tracked) {
          const clientId = t.clientId;
          const dedupeKey = `combined:${clientId}:${bill.id}:${sessionId}`;

          // Reference the two single-source alerts (severity/score inheritance).
          const billAlert = await tx.intelAlert.findFirst({
            where: { tenantId, clientId, sourceType: 'bill', sourceRef: bill.id, status: 'new' },
            orderBy: { createdAt: 'desc' },
            select: { id: true, severity: true, score: true, clientImpact: true, urgency: true },
          });
          const hearingAlert = await tx.intelAlert.findUnique({
            where: { dedupeKey: `hearing:${clientId}:${sessionId}` },
            select: { id: true, severity: true, score: true },
          });

          const severity = maxSeverity(billAlert?.severity, hearingAlert?.severity);
          const score = Math.min(
            1,
            Math.max(billAlert?.score ?? 0.5, hearingAlert?.score ?? 0.3) + 0.05, // co-occurrence boost
          );
          const evidence = {
            bill: {
              billId: bill.id,
              displayNum,
              title: bill.title,
              url: bill.url,
              stage,
              actionText: bill.latestActionText,
              actionDate: bill.latestActionDate ? bill.latestActionDate.toISOString().slice(0, 10) : null,
            },
            hearing: {
              sessionId,
              title: session.title,
              committeeId: session.committeeId,
              occurredAt: occurredAt ? occurredAt.toISOString() : null,
              mentions: billMentions.slice(0, 5).map((m) => {
                const seg = m.segmentId ? segById.get(m.segmentId) : undefined;
                const hasPlain = Boolean(seg?.textPlain);
                return {
                  segmentId: m.segmentId,
                  timestampMs: seg?.startMs ?? null,
                  speakerName: seg?.resolvedSpeakerName ?? null,
                  quote: hasPlain ? seg?.textPlain ?? null : null,
                  quoteSource: hasPlain ? 'textPlain' : 'encrypted',
                  issueTags: seg?.issueTags ?? [],
                };
              }),
            },
            link: {
              via: billMentions.length ? 'entity_mention' : 'session.billIds',
              confidence: billMentions.length ? 0.9 : 0.75,
              billAlertId: billAlert?.id ?? null,
              hearingAlertId: hearingAlert?.id ?? null,
            },
          };
          const committee = session.committeeId ?? 'committee';
          const data = {
            sourceType: 'combined',
            sourceRef: bill.id,
            kind: 'combined',
            severity,
            materiality: severity === 'critical' ? 'high' : 'medium',
            score,
            clientImpact: billAlert?.clientImpact ?? 'monitor',
            urgency: billAlert?.urgency ?? 'med',
            title: `${displayNum} referenced in hearing — ${session.title ?? 'hearing'}`,
            whyItMatters: `${displayNum} (${stage}) — a bill you track — was referenced in "${session.title ?? 'a hearing'}".`,
            recommendedAction: `${displayNum} was ${stage} and referenced in the ${committee} hearing on ${
              evidence.hearing.occurredAt?.slice(0, 10) ?? 'the hearing date'
            } — review the ${billMentions.length} mention(s) and brief the client.`,
            evidence,
          };

          const existing = await tx.intelAlert.findUnique({
            where: { dedupeKey },
            select: { id: true, status: true },
          });
          if (existing) {
            if (existing.status === 'new') {
              await tx.intelAlert.update({ where: { id: existing.id }, data });
              combined += 1;
            }
          } else {
            await tx.intelAlert.create({ data: { tenantId, clientId, dedupeKey, ...data } });
            combined += 1;
          }

          // Board "discussed at hearing" badge (§9.2 step E) — separate from the
          // congress watermark; never touch lastSeenAction*.
          await tx.trackedBill.update({
            where: { id: t.id },
            data: { lastHearingSessionId: sessionId, lastHearingAt: occurredAt ?? new Date() },
          });
        }
      }
      return { combined, skipped: false };
    });
  }
}
