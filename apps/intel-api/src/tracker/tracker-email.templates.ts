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
