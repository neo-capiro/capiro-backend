import type { PortfolioEngagementTrendResponse } from './intelligence.service.js';

export interface OutreachSendRow {
  sentAt: Date | null;
}

export interface ClientEmailRow {
  lastMessageAt: Date | null;
}

export function startOfQuarter(now: Date): Date {
  const month = now.getMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  return new Date(now.getFullYear(), quarterStartMonth, 1);
}

export function buildQuarterWindows(
  now: Date,
  count: number,
): Array<{ label: string; start: Date; end: Date }> {
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3) + 1; // 1-4
  const windows: Array<{ label: string; start: Date; end: Date }> = [];
  for (let i = count - 1; i >= 0; i--) {
    let qy = y;
    let qq = q - i;
    while (qq < 1) {
      qq += 4;
      qy -= 1;
    }
    const nextQq = qq === 4 ? 1 : qq + 1;
    const nextQy = qq === 4 ? qy + 1 : qy;
    windows.push({
      label: `Q${qq}'${String(qy).slice(2)}`,
      start: new Date(qy, (qq - 1) * 3, 1),
      end: new Date(nextQy, (nextQq - 1) * 3, 1),
    });
  }
  return windows;
}

export function foldEngagementTrend(
  quarters: Array<{ label: string; start: Date; end: Date }>,
  outreach: OutreachSendRow[],
  mail: ClientEmailRow[],
): PortfolioEngagementTrendResponse {
  const buckets = quarters.map((q) => ({
    label: q.label,
    start: q.start,
    end: q.end,
    outreachSends: 0,
    clientEmails: 0,
  }));

  const bucketFor = (t: Date) => buckets.find((b) => t >= b.start && t < b.end);

  for (const row of outreach) {
    if (!row.sentAt) continue;
    const bucket = bucketFor(row.sentAt);
    if (bucket) bucket.outreachSends += 1;
  }
  for (const row of mail) {
    if (!row.lastMessageAt) continue;
    const bucket = bucketFor(row.lastMessageAt);
    if (bucket) bucket.clientEmails += 1;
  }

  const quartersOut = buckets.map((b) => ({
    label: b.label,
    start: b.start.toISOString(),
    end: b.end.toISOString(),
    outreachSends: b.outreachSends,
    clientEmails: b.clientEmails,
    total: b.outreachSends + b.clientEmails,
  }));

  const currentQuarterTotal = quartersOut.length ? quartersOut[quartersOut.length - 1]!.total : 0;
  const priorQuarterTotal =
    quartersOut.length > 1 ? quartersOut[quartersOut.length - 2]!.total : null;
  const qoqDeltaPct =
    priorQuarterTotal != null && priorQuarterTotal > 0
      ? ((currentQuarterTotal - priorQuarterTotal) / priorQuarterTotal) * 100
      : null;

  return { quarters: quartersOut, currentQuarterTotal, qoqDeltaPct };
}
