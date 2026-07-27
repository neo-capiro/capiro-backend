/**
 * Tracker email rendering (P1.1 test-alert + Phase 8 real-alert), ported from
 * apps/api/src/tracker/notifications/tracker-email.templates.ts. Pure string
 * builders, no I/O.
 */
import type { IntelAlertEvent } from '../intel-alert/intel-alert.types.js';
import { billStage, type BillStage } from '@capiro/shared';

const BRAND = '#2447ff';
const INK = '#102033';
const MUTED = '#65758b';

const toneColor: Record<string, string> = {
  critical: '#b42318',
  notable: '#a45106',
  info: '#2447ff',
  success: '#167a4a',
};

/** Single definition of the app's public base URL (P1-06) — shared by every
 *  link builder in this file and in intel-alert.service.ts / tracker-test-alert.service.ts. */
export function appBaseUrl(): string {
  return (process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/$/, '');
}

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
    <div style="padding:18px 22px;border-bottom:1px solid #eef1f6;font-weight:700;font-size:15px;color:${INK}">Capiro · LegiWatch</div>
    <div style="padding:22px">${inner}</div>
    <div style="padding:16px 22px;border-top:1px solid #eef1f6;font-size:11px;color:${MUTED}">
      You're receiving this because LegiWatch alerts are enabled for this client.
      Manage alerts in LegiWatch → Configure.
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
    ${event.appUrl ? `<a href="${esc(event.appUrl)}" style="display:inline-block;margin-top:20px;background:${BRAND};color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px">Open in LegiWatch →</a>` : ''}
    ${event.url ? `<a href="${esc(event.url)}" style="display:inline-block;margin-top:20px;margin-left:10px;color:${BRAND};text-decoration:none;font-weight:600;font-size:13px;padding:9px 4px">View official source →</a>` : ''}`;
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
    ...(event.appUrl ? ['', `Open in LegiWatch: ${event.appUrl}`] : []),
    ...(event.url ? [`View official source: ${event.url}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, html: shell(inner), text };
}

/**
 * HP-07 (Gate G phase e): renderers for the 4 source types the registry
 * didn't cover — hearing, combined, regulation, program_element. Each has a
 * genuinely different evidence shape (intel-alert.types.ts's `hearing` /
 * `linkedBill` / `programElement` / `regulationInfo`), so each gets its own
 * layout rather than being force-fit into `renderAlertEmail`'s bill-shaped
 * fields. None of these fire in production yet — `LEGIWATCH_EMIT_SOURCE_TYPES`
 * still defaults to `bill` only; widening it is a separate, Neo-gated decision
 * (MASTER §7.7). This is pre-work so that flip needs no further code change.
 */

function ctaRow(appUrl: string | undefined, officialUrl: string | undefined, officialLabel: string): string {
  return `<div style="margin-top:16px">
    ${appUrl ? `<a href="${esc(appUrl)}" style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px">Open in LegiWatch →</a>` : ''}
    ${officialUrl ? `<a href="${esc(officialUrl)}" style="display:inline-block;margin-left:10px;color:${BRAND};text-decoration:none;font-weight:600;font-size:13px;padding:9px 4px">${esc(officialLabel)} →</a>` : ''}
  </div>`;
}

function pill(label: string, color: string): string {
  return `<div style="display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${color};background:${color}1a;padding:3px 9px;border-radius:999px">${esc(label)}</div>`;
}

/** Drop null/undefined entries and narrow to string[] so `.map(esc)` typechecks. */
function compact(parts: Array<string | null | undefined>): string[] {
  return parts.filter((p): p is string => Boolean(p));
}

/** A watchlist term mentioned during a hearing (sourceType 'hearing'). No
 *  official external source exists for this alert type (no evidence field
 *  carries a C-SPAN/committee-page URL) — only the in-app CTA is offered. */
export function renderHearingAlertEmail(event: IntelAlertEvent): { subject: string; html: string; text: string } {
  const client = event.clientName ? ` · ${event.clientName}` : '';
  const subject = `${event.billTitle}${client}`;
  const color = (event.tone && toneColor[event.tone]) ?? BRAND;
  const h = event.hearing;
  const mentions = h?.mentions ?? [];
  const inner = `
    ${pill(event.label, color)}
    <div style="margin-top:12px;font-size:16px;font-weight:600;line-height:1.35;color:${INK}">${esc(event.billTitle)}</div>
    <div style="margin-top:8px;font-size:13px;line-height:1.5;color:${MUTED}">${esc(event.detail)}</div>
    ${h?.committeeId || h?.occurredAt ? `<div style="margin-top:8px;font-size:12px;color:${MUTED}">${compact([h?.committeeId, h?.occurredAt]).map(esc).join(' · ')}</div>` : ''}
    ${
      mentions.length
        ? `<div style="margin-top:14px">${mentions
            .map(
              (m) =>
                `<div style="margin-top:8px;padding:8px 10px;background:#f6f8fb;border:1px solid #eef1f6;border-radius:6px;font-size:12.5px;line-height:1.5;color:${INK}">${m.speakerName ? `<span style="font-weight:700">${esc(m.speakerName)}:</span> ` : ''}${m.quote ? esc(m.quote) : '<span style="color:' + MUTED + '">Content pending decryption — view in LegiWatch</span>'}</div>`,
            )
            .join('')}</div>`
        : ''
    }
    ${ctaRow(event.appUrl, undefined, '')}`;
  const text = [
    event.billTitle,
    event.detail,
    ...(h?.committeeId || h?.occurredAt ? [[h?.committeeId, h?.occurredAt].filter(Boolean).join(' · ')] : []),
    ...mentions.map((m) => `${m.speakerName ? `${m.speakerName}: ` : ''}${m.quote ?? '(content pending decryption)'}`),
    ...(event.appUrl ? ['', `Open in LegiWatch: ${event.appUrl}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, html: shell(inner), text };
}

/** A tracked bill referenced in a hearing (sourceType 'combined'). The
 *  official source IS available — it's the bill's own url. */
export function renderCombinedAlertEmail(event: IntelAlertEvent): { subject: string; html: string; text: string } {
  const client = event.clientName ? ` · ${event.clientName}` : '';
  const bill = event.linkedBill;
  const subject = `${bill?.displayNum ?? event.displayNum}: ${event.label}${client}`;
  const color = (event.tone && toneColor[event.tone]) ?? BRAND;
  const h = event.hearing;
  const mentions = h?.mentions ?? [];
  const inner = `
    ${pill(event.label, color)}
    <div style="margin-top:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:700;color:${INK}">${esc(bill?.displayNum ?? event.displayNum)}</div>
    <div style="margin-top:4px;font-size:16px;font-weight:600;line-height:1.35;color:${INK}">${esc(bill?.title ?? event.billTitle)}</div>
    <div style="margin-top:10px;font-size:13px;line-height:1.5;color:${MUTED}">${esc(event.detail)}</div>
    <div style="margin-top:14px;padding:11px 13px;background:#f6f8fb;border:1px solid #eef1f6;border-radius:8px;font-size:12px;line-height:1.5;color:${INK}">
      <span style="font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:10px;color:${MUTED}">Referenced in hearing</span>
      <div style="margin-top:4px;font-weight:600">${esc(h?.title ?? 'Hearing')}</div>
      ${
        mentions.length
          ? mentions
              .map(
                (m) =>
                  `<div style="margin-top:6px">${m.speakerName ? `<span style="font-weight:700">${esc(m.speakerName)}:</span> ` : ''}${m.quote ? esc(m.quote) : '<span style="color:' + MUTED + '">Content pending decryption</span>'}</div>`,
              )
              .join('')
          : ''
      }
    </div>
    ${ctaRow(event.appUrl, bill?.url, 'View official source')}`;
  const text = [
    `${bill?.displayNum ?? event.displayNum}: ${bill?.title ?? event.billTitle}`,
    event.detail,
    `Referenced in hearing: ${h?.title ?? 'Hearing'}`,
    ...mentions.map((m) => `  ${m.speakerName ? `${m.speakerName}: ` : ''}${m.quote ?? '(content pending decryption)'}`),
    ...(event.appUrl ? ['', `Open in LegiWatch: ${event.appUrl}`] : []),
    ...(bill?.url ? [`View official source: ${bill.url}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, html: shell(inner), text };
}

/** A newly matched federal or state rule (sourceType 'regulation'). Uses the
 *  generic flat `event.url`/`event.detail`/`event.actionDate` reads, which
 *  already work for this type, plus `regulationInfo` for agency/comment
 *  period. No `docketId`/`effectiveDate` — the writer never populates them
 *  (verified: SourceRule carries neither), so this renderer doesn't assume them. */
export function renderRegulationAlertEmail(event: IntelAlertEvent): { subject: string; html: string; text: string } {
  const client = event.clientName ? ` · ${event.clientName}` : '';
  const subject = `${event.billTitle}${client}`;
  const color = (event.tone && toneColor[event.tone]) ?? BRAND;
  const r = event.regulationInfo;
  const meta = compact([r?.agency, r?.ruleType, r?.jurisdiction && r.jurisdiction !== 'US' ? r.jurisdiction : null]);
  const inner = `
    ${pill(event.label, color)}
    <div style="margin-top:12px;font-size:16px;font-weight:600;line-height:1.35;color:${INK}">${esc(event.billTitle)}</div>
    ${meta.length ? `<div style="margin-top:4px;font-size:12px;color:${MUTED}">${meta.map(esc).join(' · ')}</div>` : ''}
    <div style="margin-top:10px;font-size:13px;line-height:1.5;color:${MUTED}">${esc(event.detail)}</div>
    ${r?.commentEndDate ? `<div style="margin-top:8px;font-size:12px;color:${MUTED}">Comment period ends · ${esc(r.commentEndDate)}</div>` : ''}
    ${ctaRow(event.appUrl, event.url, 'View official source')}`;
  const text = [
    event.billTitle,
    meta.join(' · '),
    event.detail,
    ...(r?.commentEndDate ? [`Comment period ends: ${r.commentEndDate}`] : []),
    ...(event.appUrl ? ['', `Open in LegiWatch: ${event.appUrl}`] : []),
    ...(event.url ? [`View official source: ${event.url}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, html: shell(inner), text };
}

/** A funding-delta match against a Program Element watchlist term (sourceType
 *  'program_element'). No official external source exists — the second link
 *  is the internal PE-360 dossier (`programElement.href`, a relative path
 *  that needs the app base URL prefixed), not a government source. */
export function renderProgramElementAlertEmail(event: IntelAlertEvent): { subject: string; html: string; text: string } {
  const client = event.clientName ? ` · ${event.clientName}` : '';
  const subject = `${event.billTitle}${client}`;
  const color = (event.tone && toneColor[event.tone]) ?? BRAND;
  const pe = event.programElement;
  const from = pe?.amountFromMillions != null ? `$${pe.amountFromMillions.toFixed(1)}M` : null;
  const to = pe?.amountToMillions != null ? `$${pe.amountToMillions.toFixed(1)}M` : null;
  const move = from && to ? `${from} → ${to}` : null;
  const peUrl = pe?.href ? `${appBaseUrl()}${pe.href}` : undefined;
  const inner = `
    ${pill(event.label, color)}
    <div style="margin-top:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:700;color:${INK}">${esc(pe?.peCode ?? event.billId)}</div>
    <div style="margin-top:4px;font-size:16px;font-weight:600;line-height:1.35;color:${INK}">${esc(event.billTitle)}</div>
    <div style="margin-top:10px;font-size:13px;line-height:1.5;color:${MUTED}">${esc(event.detail)}</div>
    ${
      move || pe?.fiscalYear
        ? `<div style="margin-top:8px;font-size:12px;color:${MUTED}">${compact([pe?.fiscalYear ? `FY${pe.fiscalYear}` : null, move]).map(esc).join(' · ')}</div>`
        : ''
    }
    ${ctaRow(event.appUrl, peUrl, 'Open Program Element')}`;
  const text = [
    event.billTitle,
    event.detail,
    ...(move || pe?.fiscalYear ? [[pe?.fiscalYear ? `FY${pe.fiscalYear}` : null, move].filter(Boolean).join(' · ')] : []),
    ...(event.appUrl ? ['', `Open in LegiWatch: ${event.appUrl}`] : []),
    ...(peUrl ? [`Open Program Element: ${peUrl}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, html: shell(inner), text };
}

/** Severity → sort rank (P0-02 digest grouping). Unknown severities sort last. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, notable: 1, info: 2, success: 3 };

/**
 * Stage → sort rank (MP-01). The plan asked to rank on the alert's canonical
 * changeType via "the shared procedural status rank" — no such table exists
 * anywhere in the codebase (grepped; the closest namesakes, bill-dossier's
 * funding STAGE_ORDER and the board's BOARD_TABLE_STAGE_ORDER, are different
 * domains). What genuinely IS shared is `billStage()` (`@capiro/shared`),
 * the same classifier the tracker BOARD already uses for its four columns
 * (introduced/committee/passed/enacted) — reused here instead of inventing a
 * parallel one, and it needs no new field on DigestItem: it reads
 * `item.detail`, which already carries the official action text.
 * STAGE_SIGNIFICANCE inverts BILL_STAGES' natural (chronological) order into
 * sort priority — 'enacted' is the most newsworthy digest item, so it sorts
 * FIRST, not last.
 */
const STAGE_SIGNIFICANCE: Record<BillStage, number> = {
  enacted: 0,
  passed: 1,
  committee: 2,
  introduced: 3,
};

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
    const stageA = STAGE_SIGNIFICANCE[billStage(a.detail)];
    const stageB = STAGE_SIGNIFICANCE[billStage(b.detail)];
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

/** Test alert email fired from the Configure panel. `legiwatchUrl` is the
 *  primary CTA (Feed, client-preselected); `clientTrackerUrl` is a secondary
 *  text link to the client-profile LegiWatch tab (P1-06). */
export function renderTestEmail(
  clientName: string | null,
  legiwatchUrl: string,
  clientTrackerUrl: string,
): { subject: string; html: string; text: string } {
  const subject = `Test alert — Capiro LegiWatch${clientName ? ` · ${clientName}` : ''}`;
  const inner = `<div style="font-size:15px;font-weight:600;color:${INK}">Your LegiWatch alerts are wired up ✓</div>
    <div style="margin-top:10px;font-size:13px;line-height:1.5;color:${MUTED}">This is a sample alert confirming email delivery for ${esc(clientName ?? 'this client')}. Real alerts fire when something you track moves — a bill, a hearing, a regulation, or a Program Element.</div>
    <a href="${esc(legiwatchUrl)}" style="display:inline-block;margin-top:18px;background:${BRAND};color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:9px 16px;border-radius:8px">Open LegiWatch →</a>
    <a href="${esc(clientTrackerUrl)}" style="display:inline-block;margin-top:18px;margin-left:10px;color:${BRAND};text-decoration:none;font-weight:600;font-size:13px;padding:9px 4px">Open the client profile →</a>`;
  const text = `Your LegiWatch alerts are wired up.\n\nThis is a sample alert confirming email delivery${clientName ? ` for ${clientName}` : ''}.\n\nOpen LegiWatch: ${legiwatchUrl}\nOpen the client profile: ${clientTrackerUrl}`;
  return { subject, html: shell(inner), text };
}

/** Per-source email renderers (P1-07, HP-07). A source with NO renderer is
 *  not emailable — fanOut skips it rather than sending a bill-shaped email
 *  for a hearing/PE/regulation event. All 6 source types now have one; only
 *  `LEGIWATCH_EMIT_SOURCE_TYPES` (still `bill` by default) decides which
 *  actually reach this fan-out — widening it is a separate, Neo-gated
 *  decision (MASTER §7.7), not a code change.
 *
 *  `state_bill` is included: bill-change-detector.service.ts's writeShadowAlert
 *  is the SAME writer for both the federal and state rails (its own doc
 *  comment: "parameterized (S4.3) so the exact same watermark/dedup/fan-out
 *  machinery serves both rails") — it populates evidence.displayNum,
 *  evidence.billTitle, evidence.stage, and evidence.actionText identically for
 *  sourceType='state_bill' and sourceType='bill'. Verified by reading
 *  writeShadowAlert directly (2026-07-25); no state-rail field is empty. */
export const ALERT_EMAIL_RENDERERS: Record<
  string,
  (e: IntelAlertEvent) => { subject: string; html: string; text: string }
> = {
  bill: renderAlertEmail,
  state_bill: renderAlertEmail, // same fields; jurisdiction rides in the event
  hearing: renderHearingAlertEmail,
  combined: renderCombinedAlertEmail,
  regulation: renderRegulationAlertEmail,
  program_element: renderProgramElementAlertEmail,
};

export function rendererFor(
  sourceType: string | undefined,
): ((e: IntelAlertEvent) => { subject: string; html: string; text: string }) | null {
  return ALERT_EMAIL_RENDERERS[sourceType ?? 'bill'] ?? null;
}
