import type { TrackerAlertEvent } from './tracker-notification.types.js';

const BRAND = '#2447ff';
const INK = '#102033';
const MUTED = '#65758b';

function esc(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const toneColor: Record<string, string> = {
  critical: '#b42318',
  notable: '#a45106',
  info: '#2447ff',
  success: '#167a4a',
};

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

/** Single realtime alert email. */
export function renderAlertEmail(event: TrackerAlertEvent): {
  subject: string;
  html: string;
  text: string;
} {
  const client = event.clientName ? ` · ${event.clientName}` : '';
  const subject = `${event.displayNum}: ${event.label}${client}`;
  const color = toneColor[event.tone] ?? BRAND;
  const inner = `
    <div style="display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${color};background:${color}1a;padding:3px 9px;border-radius:999px">${esc(event.label)}</div>
    <div style="margin-top:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:700;color:${INK}">${esc(event.displayNum)}</div>
    <div style="margin-top:4px;font-size:16px;font-weight:600;line-height:1.35;color:${INK}">${esc(event.billTitle)}</div>
    <div style="margin-top:14px;font-size:13px;line-height:1.5;color:${MUTED}">${esc(event.detail)}</div>
    ${event.actionDate ? `<div style="margin-top:8px;font-size:12px;color:${MUTED}">Latest action · ${esc(event.actionDate)}</div>` : ''}
    <a href="${esc(event.url)}" style="display:inline-block;margin-top:20px;background:${BRAND};color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px">Open in Tracker →</a>`;
  const text = [
    `${event.displayNum}: ${event.label}`,
    event.billTitle,
    '',
    event.detail,
    event.actionDate ? `Latest action: ${event.actionDate}` : '',
    '',
    `Open: ${event.url}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, html: shell(inner), text };
}

/** Daily/weekly digest of multiple events for one user. */
export function renderDigestEmail(
  events: TrackerAlertEvent[],
  cadence: 'daily' | 'weekly',
  boardUrl: string,
): { subject: string; html: string; text: string } {
  const subject = `Your ${cadence} bill tracker digest — ${events.length} update${events.length === 1 ? '' : 's'}`;
  const rows = events
    .map((e) => {
      const color = toneColor[e.tone] ?? BRAND;
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #eef1f6">
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:${INK}">${esc(e.displayNum)}
          <span style="font-family:Inter,sans-serif;font-weight:700;font-size:10px;color:${color};background:${color}1a;padding:2px 7px;border-radius:999px;margin-left:6px">${esc(e.label)}</span>
        </div>
        <div style="margin-top:3px;font-size:13px;color:${INK}">${esc(e.billTitle)}</div>
        <div style="margin-top:2px;font-size:12px;color:${MUTED}">${esc(e.detail)}</div>
      </td></tr>`;
    })
    .join('');
  const inner = `<div style="font-size:14px;font-weight:600;color:${INK}">${events.length} bill update${events.length === 1 ? '' : 's'}</div>
    <table style="width:100%;border-collapse:collapse;margin-top:8px">${rows}</table>
    <a href="${esc(boardUrl)}" style="display:inline-block;margin-top:18px;background:${BRAND};color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px">Open Tracker →</a>`;
  const text = [
    `Your ${cadence} bill tracker digest — ${events.length} updates`,
    '',
    ...events.map((e) => `• ${e.displayNum} — ${e.label}: ${e.billTitle}`),
    '',
    `Open: ${boardUrl}`,
  ].join('\n');
  return { subject, html: shell(inner), text };
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
