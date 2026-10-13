import type { SettledProfileV1Sources } from './client-profile-v1-sources.js';
import type { ProfileV1Context } from './client-profile-v1.shared.js';

export function buildProfileV1Snapshot(context: ProfileV1Context, values: SettledProfileV1Sources) {
  const byDay = buildActivity(context, values);
  const alerts = buildAlerts(context, values);
  const briefing = buildBriefing(context, values, alerts.commentAlertsForClient);
  return { byDay, ...alerts, ...briefing };
}

function buildActivity(context: ProfileV1Context, values: SettledProfileV1Sources) {
  const { now } = context;
  const { meetings, threads, doneTasks, debriefs, outreachRows } = values;
  const byDay = new Map<
    string,
    {
      date: string;
      meetings: number;
      emails: number;
      tasks: number;
      debriefs: number;
      outreach: number;
    }
  >();
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { date: key, meetings: 0, emails: 0, tasks: 0, debriefs: 0, outreach: 0 });
  }
  for (const row of meetings) {
    const key = row.startsAt.toISOString().slice(0, 10);
    const slot = byDay.get(key);
    if (slot) slot.meetings += 1;
  }
  for (const row of threads) {
    if (!row.lastMessageAt) continue;
    const key = row.lastMessageAt.toISOString().slice(0, 10);
    const slot = byDay.get(key);
    if (slot) slot.emails += 1;
  }
  for (const row of doneTasks) {
    const key = row.updatedAt.toISOString().slice(0, 10);
    const slot = byDay.get(key);
    if (slot) slot.tasks += 1;
  }
  for (const row of debriefs) {
    const key = row.createdAt.toISOString().slice(0, 10);
    const slot = byDay.get(key);
    if (slot) slot.debriefs += 1;
  }
  for (const row of outreachRows) {
    if (!row.sentAt) continue;
    const key = row.sentAt.toISOString().slice(0, 10);
    const slot = byDay.get(key);
    if (slot) slot.outreach += 1;
  }
  return byDay;
}

function buildBillMovementAlerts(context: ProfileV1Context, values: SettledProfileV1Sources) {
  const { clientId, now, day14 } = context;
  const { trackedBills } = values;

  const billMovementAlerts = (trackedBills.bills ?? [])
    .filter((b) => {
      if (!b.latestActionDate) return false;
      const d = new Date(b.latestActionDate);
      return (
        !Number.isNaN(d.getTime()) && d.getTime() >= day14.getTime() && d.getTime() <= now.getTime()
      );
    })
    .map((b) => {
      const actionText = (b.latestActionText ?? '').toLowerCase();
      const isHot = /\b(vote|floor|passed|enacted|markup|reported|signed)\b/.test(actionText);
      const whenIso = new Date(b.latestActionDate as Date).toISOString();
      const daysAgo = Math.max(
        0,
        Math.floor((now.getTime() - new Date(whenIso).getTime()) / (1000 * 60 * 60 * 24)),
      );
      return {
        id: `bill:${b.identifier}`,
        type: 'bill_movement',
        severity: isHot ? 'critical' : 'notable',
        title: `${b.identifier.toUpperCase()} moved${b.isManual ? ' (tracked)' : ''}`,
        subtitle: b.latestActionText ?? b.title,
        when: whenIso,
        countdownDays: null as number | null,
        countdownLabel: profileAlertRecencyLabel(whenIso, now),
        href: `/intelligence/bills/${encodeURIComponent(b.identifier)}?clientId=${encodeURIComponent(clientId)}`,
        _urgencyScore: 45 - Math.min(daysAgo, 45),
        _typeRank: 1,
      };
    });
  return billMovementAlerts;
}

function mergeAlerts(
  context: ProfileV1Context,
  values: SettledProfileV1Sources,
  commentAlertsForClient: SettledProfileV1Sources['commentAlerts']['alerts'],
  billMovementAlerts: ReturnType<typeof buildBillMovementAlerts>,
) {
  const { clientId, now } = context;
  const { changes, overdueCommentAlerts, competitorLdaAlerts, contractAwardAlerts, hearingAlerts } =
    values;
  const countdownLabel = (days: number | null): string | null => {
    if (days == null) return null;
    if (days < 0) return `Overdue ${Math.abs(days)}d`;
    if (days === 0) return 'Due today';
    if (days === 1) return '1d left';
    return `${days}d left`;
  };

  const mergedAlerts = [
    ...commentAlertsForClient.map((a) => {
      const days = a.daysToDeadline ?? null;
      return {
        id: `comment:${a.documentId}`,
        type: 'comment_deadline',
        severity: a.severity,
        title: a.title,
        subtitle: a.agencies.slice(0, 2).join(' / '),
        when: a.commentEndDate.toISOString(),
        countdownDays: days,
        countdownLabel: countdownLabel(days),
        href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&source=comment_deadline`,
        _urgencyScore: days == null ? 0 : 100 - Math.max(-30, Math.min(days, 100)),
        _typeRank: 2,
      };
    }),
    ...changes.map((c) => {
      const daysAgo = Math.max(
        0,
        Math.floor((now.getTime() - c.detectedAt.getTime()) / (1000 * 60 * 60 * 24)),
      );
      return {
        id: `change:${c.id}`,
        type: c.changeType,
        severity: c.severity,
        title: c.title,
        subtitle: c.source,
        when: c.detectedAt.toISOString(),
        countdownDays: null as number | null,
        countdownLabel: profileAlertRecencyLabel(c.detectedAt.toISOString(), now),
        href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&changeId=${encodeURIComponent(c.id)}`,
        _urgencyScore: 40 - Math.min(daysAgo, 40),
        _typeRank: 1,
      };
    }),
    ...hearingAlerts,
    ...billMovementAlerts,
    ...overdueCommentAlerts,
    ...competitorLdaAlerts,
    ...contractAwardAlerts,
  ];
  return mergedAlerts;
}

function buildAlerts(context: ProfileV1Context, values: SettledProfileV1Sources) {
  const { clientId, now } = context;
  const { commentAlerts, alertStateRows } = values;
  const severityRank = (severity: string): number => {
    if (severity === 'critical') return 3;
    if (severity === 'notable') return 2;
    return 1;
  };
  const commentAlertsForClient = commentAlerts.alerts.filter((a) => a.clientId === clientId);
  const billMovementAlerts = buildBillMovementAlerts(context, values);
  const mergedAlerts = mergeAlerts(context, values, commentAlertsForClient, billMovementAlerts);
  const stateByAlertId = new Map<string, { state: string; snoozedUntil: Date | null }>();
  for (const row of alertStateRows) {
    stateByAlertId.set(row.alertId, { state: row.state, snoozedUntil: row.snoozedUntil });
  }
  const isHidden = (alertId: string): boolean => {
    const st = stateByAlertId.get(alertId);
    if (!st) return false;
    if (st.state === 'dismissed') return true;
    if (st.state === 'snoozed') {
      // Snoozed with no/expired deadline → treat as hidden until snoozedUntil.
      if (!st.snoozedUntil) return true;
      return new Date(st.snoozedUntil).getTime() > now.getTime();
    }
    return false;
  };
  const visibleAlerts = mergedAlerts
    .filter((a) => !isHidden(a.id))
    .map((a) => ({
      ...a,
      // 'acknowledged' surfaces as a flag the UI uses to de-emphasize the row;
      // it is NOT hidden. Any other state (or none) → null.
      state: stateByAlertId.get(a.id)?.state === 'acknowledged' ? 'acknowledged' : null,
    }))
    .sort((a, b) => {
      const sev = severityRank(b.severity) - severityRank(a.severity);
      if (sev !== 0) return sev;
      const type = b._typeRank - a._typeRank;
      if (type !== 0) return type;
      const urgency = b._urgencyScore - a._urgencyScore;
      if (urgency !== 0) return urgency;
      return b.when.localeCompare(a.when);
    });
  const alertsHiddenCount = Math.max(0, visibleAlerts.length - 5);
  const topAlerts = visibleAlerts
    .slice(0, 20)
    .map(({ _urgencyScore, _typeRank, ...alert }) => alert);
  return { commentAlertsForClient, topAlerts, alertsHiddenCount };
}

function buildBriefingHighlights(
  context: ProfileV1Context,
  values: SettledProfileV1Sources,
  criticalDeadlines: number,
) {
  const { roi, trackedBills, changes } = values;
  const briefingHighlights: Array<{
    label: string;
    value: string | number | null;
    tone: 'critical' | 'notable' | 'info' | 'neutral';
  }> = [];
  if (criticalDeadlines > 0) {
    briefingHighlights.push({
      label: 'Deadlines',
      value: `${criticalDeadlines} due ≤7d`,
      tone: 'critical',
    });
  }
  if (trackedBills.total > 0) {
    briefingHighlights.push({
      label: 'Bills tracked',
      value: trackedBills.total,
      tone: 'notable',
    });
  }
  if ((roi.lobbySpend ?? 0) > 0) {
    briefingHighlights.push({
      label: 'Lobbying TTM',
      value: Math.round(roi.lobbySpend),
      tone: 'info',
    });
  }
  if (changes.length > 0) {
    briefingHighlights.push({
      label: 'New events (7d)',
      value: changes.length,
      tone: 'info',
    });
  }
  if (briefingHighlights.length === 0) {
    briefingHighlights.push({
      label: 'Status',
      value: 'Monitoring for new intelligence signals',
      tone: 'neutral',
    });
  }
  return briefingHighlights;
}

function buildBriefing(
  context: ProfileV1Context,
  values: SettledProfileV1Sources,
  commentAlertsForClient: SettledProfileV1Sources['commentAlerts']['alerts'],
) {
  const { client, clientId, now } = context;
  const { profile, trackedBills, changes } = values;
  const criticalDeadlines = commentAlertsForClient.filter(
    (a) => (a.daysToDeadline ?? 999) <= 7,
  ).length;
  const briefingHighlights = buildBriefingHighlights(context, values, criticalDeadlines);
  const fallbackSummaryParts: string[] = [];
  if (criticalDeadlines > 0) {
    fallbackSummaryParts.push(
      `${criticalDeadlines} comment deadline${criticalDeadlines === 1 ? '' : 's'} due within 7 days.`,
    );
  }
  if (trackedBills.total > 0) {
    fallbackSummaryParts.push(
      `${trackedBills.total} bill${trackedBills.total === 1 ? '' : 's'} currently tracked.`,
    );
  }
  fallbackSummaryParts.push(
    changes.length > 0
      ? `${changes.length} intelligence change${changes.length === 1 ? '' : 's'} detected this week.`
      : 'No new intelligence changes detected this week.',
  );
  const aiSummaryRaw = (profile as { aiSummary?: string | null }).aiSummary;
  const aiSummary = typeof aiSummaryRaw === 'string' ? aiSummaryRaw.trim() : '';
  const briefingSummary =
    aiSummary ||
    fallbackSummaryParts.join(' ') ||
    `No intelligence updates available for ${client.name}.`;
  const changesInboxHref = `/intelligence/changes?clientId=${encodeURIComponent(clientId)}`;
  const dailyBriefing = {
    summary: briefingSummary,
    highlights: briefingHighlights.slice(0, 4),
    generatedAt: now.toISOString(),
    eventCount: changes.length,
    ctaHref: changesInboxHref,
  };
  return { changesInboxHref, dailyBriefing };
}

function profileAlertRecencyLabel(whenIso: string, now: Date): string {
  const when = new Date(whenIso);
  const diffMs = now.getTime() - when.getTime();
  const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return '1d ago';
  return `${diffDays}d ago`;
}
