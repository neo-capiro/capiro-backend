/**
 * Tracker email rendering (P1.1 test-alert + Phase 8 real-alert), ported from
 * apps/api/src/tracker/notifications/tracker-email.templates.ts. Pure string
 * builders, no I/O.
 */
import type { IntelAlertEvent } from '../intel-alert/intel-alert.types.js';

const BRAND = '#2447ff';
const INK = '#102033';
const MUTED = '#65758b';

const toneColor: Record<string, string> = {
  critical: '#b42318',
  notable: '#a45106',
  info: '#2447ff',
  success: '#167a4a',
};

function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f8fb;padding:24px;font-family:Inter,system-ui,Segoe UI,sans-serif;color:${INK}">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #d8e0ea;border-radius:14px;overflow:hidden">
    <div style="padding:18px 22px;border-bottom:1px solid #eef1f6;font-weight:700;font-size:15px;color:${INK}">Capiro · Bill Tracker</div>
    <div style="padding:22px">${inner}</div>
    <div style="padding:16px 22px;border-top:1px solid #eef1f6;font-size:11px;color:${MUTED}">
      You're receiving this because bill-tracking alerts are enabled for this client.
      Manage alerts in the client profile → Tracker → Configure.
    </div>
  </div></body></html>`;
}

/** Single realtime alert email — the real content for emitNewBillAlerts' fan-out send. */
export function renderAlertEmail(event: IntelAlertEvent): {
  subject: string;
  html: string;
  text: string;
} {
  const client = event.clientName ? ` · ${event.clientName}` : '';
  const subject = `${event.displayNum}: ${event.label}${client}`;
  const color = (event.tone && toneColor[event.tone]) ?? BRAND;
  const inner = `
    <div style="display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${color};background:${color}1a;padding:3px 9px;border-radius:999px">${esc(event.label)}</div>
    <div style="margin-top:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:700;color:${INK}">${esc(event.displayNum)}</div>
    <div style="margin-top:4px;font-size:16px;font-weight:600;line-height:1.35;color:${INK}">${esc(event.billTitle)}</div>
    <div style="margin-top:14px;font-size:13px;line-height:1.5;color:${MUTED}">${esc(event.detail)}</div>
    ${event.actionDate ? `<div style="margin-top:8px;font-size:12px;color:${MUTED}">Latest action · ${esc(event.actionDate)}</div>` : ''}
    ${
      event.summary
        ? `<div style="margin-top:14px"><span style="font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:10px;color:${MUTED}">What happened</span><div style="margin-top:4px;font-size:13px;line-height:1.55;color:${INK}">${esc(event.summary)}</div></div>`
        : ''
    }
    ${
      event.why
        ? `<div style="margin-top:14px;padding:11px 13px;background:#f6f8fb;border:1px solid #eef1f6;border-radius:8px;font-size:12px;line-height:1.5;color:${INK}"><span style="font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:10px;color:${MUTED}">Why this matters${event.clientName ? ` · ${esc(event.clientName)}` : ''}</span><div style="margin-top:4px">${esc(event.why)}</div></div>`
        : ''
    }
    ${
      event.matchedTags && event.matchedTags.length
        ? `<div style="margin-top:10px">${event.matchedTags
            .map(
              (tg) =>
                `<span style="display:inline-block;font-size:10px;font-weight:600;color:${MUTED};background:#eef1f6;padding:3px 9px;border-radius:999px;margin:0 5px 5px 0">${esc(tg)}</span>`,
            )
            .join('')}</div>`
        : ''
    }
    ${event.url ? `<a href="${esc(event.url)}" style="display:inline-block;margin-top:20px;background:${BRAND};color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px">Open in Tracker →</a>` : ''}`;
  const text = [
    `${event.displayNum}: ${event.label}`,
    event.billTitle,
    '',
    event.detail,
    event.actionDate ? `Latest action: ${event.actionDate}` : '',
    event.summary ? `What happened: ${event.summary}` : '',
    event.why
      ? `Why this matters${event.clientName ? ` (${event.clientName})` : ''}: ${event.why}`
      : '',
    ...(event.url ? ['', `Open: ${event.url}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, html: shell(inner), text };
}

/** Severity → sort rank (P0-02 digest grouping). Unknown severities sort last. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, notable: 1, info: 2, success: 3 };

/**
 * Stage → sort rank, reusing the existing `toneColor` vocabulary's key order
 * (critical, notable, info, success) as the "legislative stage" tiebreaker the
 * audit's required-fix item 2 asks for. NOTE: `DigestItem.label` values are
 * free-text stage descriptions ("Passed a chamber", "New CBO cost estimate"),
 * not literally these four tone words, so in practice almost every item falls
 * into the unmatched/last bucket and this key rarely differentiates anything —
 * it defers to the next key (deadline). Implemented literally per the plan's
 * instruction to reuse this vocabulary rather than inventing a new stage-rank
 * system; flagged in the phase completion report as a real ambiguity in the
 * plan text.
 */
const STAGE_RANK: Record<string, number> = Object.fromEntries(
  Object.keys(toneColor).map((k, i) => [k, i]),
);

/** One alert folded into a digest (P0-02) — enough to render without re-reading the queue's payload (it carries none). */
export interface DigestItem {
  clientName: string | null;
  displayNum: string;
  billTitle: string;
  label: string; // stage
  severity: string; // 'critical'|'notable'|'info'|...
  detail: string; // official action text
  actionDate: string | null;
  deadline: string | null;
  recommendedAction: string | null;
  why: string | null;
  url: string; // official source
  appUrl: string; // LegiWatch deep link (phase f)
}

/**
 * Batched daily/weekly digest (P0-02, audit required-fix item 2). Grouping,
 * exactly as specified: client (alphabetical) → severity → legislative stage
 * → deadline (ascending, nulls last) → required action (present before
 * absent). Reuses `shell()`/`esc()` so chrome and escaping stay identical to
 * the realtime template; every interpolated field goes through `esc()`.
 */
export function renderDigestEmail(
  cadence: 'daily' | 'weekly',
  items: DigestItem[],
): { subject: string; html: string; text: string } {
  const byClient = new Map<string, DigestItem[]>();
  for (const item of items) {
    const key = item.clientName ?? '(unassigned)';
    const arr = byClient.get(key) ?? [];
    arr.push(item);
    byClient.set(key, arr);
  }
  const clientNames = Array.from(byClient.keys()).sort((a, b) => a.localeCompare(b));

  const compare = (a: DigestItem, b: DigestItem): number => {
    const sevA = SEVERITY_RANK[a.severity] ?? 4;
    const sevB = SEVERITY_RANK[b.severity] ?? 4;
    if (sevA !== sevB) return sevA - sevB;
    const stageA = STAGE_RANK[a.label.toLowerCase()] ?? 4;
    const stageB = STAGE_RANK[b.label.toLowerCase()] ?? 4;
    if (stageA !== stageB) return stageA - stageB;
    if (a.deadline !== b.deadline) {
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return a.deadline.localeCompare(b.deadline);
    }
    const actionA = a.recommendedAction ? 0 : 1;
    const actionB = b.recommendedAction ? 0 : 1;
    return actionA - actionB;
  };

  const sections: string[] = [];
  const textLines: string[] = [];
  for (const clientName of clientNames) {
    const sorted = [...byClient.get(clientName)!].sort(compare);
    sections.push(
      `<div style="margin-top:20px;font-size:13px;font-weight:700;color:${INK};border-bottom:1px solid #eef1f6;padding-bottom:6px">${esc(clientName)}</div>`,
    );
    textLines.push('', clientName, '─'.repeat(clientName.length));
    for (const item of sorted) {
      const color = toneColor[item.severity] ?? BRAND;
      sections.push(`
        <div style="margin-top:14px;padding-top:2px">
          <div style="display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${color};background:${color}1a;padding:2px 8px;border-radius:999px">${esc(item.label)}</div>
          <div style="margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:700;color:${INK}">${esc(item.displayNum)}</div>
          <div style="margin-top:2px;font-size:14px;font-weight:600;line-height:1.35;color:${INK}">${esc(item.billTitle)}</div>
          <div style="margin-top:6px;font-size:12.5px;line-height:1.5;color:${MUTED}">${esc(item.detail)}</div>
          ${item.deadline ? `<div style="margin-top:6px;font-size:11.5px;color:${MUTED}">Deadline · ${esc(item.deadline)}</div>` : ''}
          ${item.recommendedAction ? `<div style="margin-top:6px;padding:8px 10px;background:#f6f8fb;border:1px solid #eef1f6;border-radius:6px;font-size:11.5px;line-height:1.45;color:${INK}"><span style="font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:9px;color:${MUTED}">Recommended action</span><div style="margin-top:3px">${esc(item.recommendedAction)}</div></div>` : ''}
          <div style="margin-top:8px">
            <a href="${esc(item.appUrl)}" style="font-size:11.5px;font-weight:600;color:${BRAND};text-decoration:none">Open in LegiWatch →</a>
            ${item.url ? `<a href="${esc(item.url)}" style="margin-left:14px;font-size:11.5px;font-weight:600;color:${MUTED};text-decoration:none">Official source →</a>` : ''}
          </div>
        </div>`);
      textLines.push(
        `- [${item.label}] ${item.displayNum}: ${item.billTitle}`,
        `  ${item.detail}`,
        ...(item.deadline ? [`  Deadline: ${item.deadline}`] : []),
        ...(item.recommendedAction ? [`  Recommended action: ${item.recommendedAction}`] : []),
        `  LegiWatch: ${item.appUrl}${item.url ? ` | Source: ${item.url}` : ''}`,
      );
    }
  }

  const subject = `[Capiro] LegiWatch ${cadence === 'daily' ? 'daily' : 'weekly'} digest — ${items.length} update${items.length === 1 ? '' : 's'}`;
  const html = sections.join('');
  const text = [subject, ...textLines].join('\n');
  return { subject, html: shell(html), text };
}

/** Test alert email fired from the Configure panel. */
export function renderTestEmail(
  clientName: string | null,
  boardUrl: string,
): { subject: string; html: string; text: string } {
  const subject = `Test alert — Capiro bill tracker${clientName ? ` · ${clientName}` : ''}`;
  const inner = `<div style="font-size:15px;font-weight:600;color:${INK}">Your bill-tracker alerts are wired up ✓</div>
    <div style="margin-top:10px;font-size:13px;line-height:1.5;color:${MUTED}">This is a sample alert confirming email delivery for ${esc(clientName ?? 'this client')}. Real alerts fire when a tracked bill moves (amendment, hearing, vote, enactment).</div>
    <a href="${esc(boardUrl)}" style="display:inline-block;margin-top:18px;background:${BRAND};color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px">Open Tracker →</a>`;
  const text = `Your bill-tracker alerts are wired up.\n\nThis is a sample alert confirming email delivery${clientName ? ` for ${clientName}` : ''}.\n\nOpen: ${boardUrl}`;
  return { subject, html: shell(inner), text };
}
