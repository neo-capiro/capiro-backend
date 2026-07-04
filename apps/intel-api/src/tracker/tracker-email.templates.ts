/**
 * Tracker email rendering (P1.1) — the test-alert template, ported verbatim
 * from apps/api/src/tracker/notifications/tracker-email.templates.ts (the
 * realtime/digest templates stay legacy-side; the unified fan-out renders its
 * own). Pure string builders, no I/O.
 */
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
