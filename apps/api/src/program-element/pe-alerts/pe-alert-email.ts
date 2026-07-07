/**
 * pe-alert-email — pure logic for PE Watch alert emails + unified watchlist
 * matching (PE Watch auto-update plan, Phase 2).
 *
 * The alerts themselves already exist: the program-element writer, the
 * budget-doc watcher, and the mention matcher all emit IntelligenceChange rows
 * carrying relatedPeCodes. This module turns a window of those rows into
 * per-user digest emails (scoped to each user's program_element_watch set) and
 * matches client watchlists against PE titles/capability terms so alerts carry
 * client relevance. The script (scripts/send-pe-alert-emails.ts) owns
 * Prisma/SES wiring, the tenant canary gate, and the send watermark.
 */

export interface PeAlertItem {
  id: string;
  changeType: string;
  /** critical | notable | info */
  severity: string;
  title: string;
  description: string | null;
  relatedPeCodes: string[];
  detectedAt: Date;
}

export interface UserDigest {
  critical: PeAlertItem[];
  regular: PeAlertItem[];
}

/** Alerts relevant to one user: any related PE is in their watched set. */
export function digestForUser(alerts: PeAlertItem[], watched: Set<string>): UserDigest {
  const seen = new Set<string>();
  const mine = alerts.filter((a) => {
    if (seen.has(a.id)) return false;
    if (!a.relatedPeCodes.some((pe) => watched.has(pe))) return false;
    seen.add(a.id);
    return true;
  });
  const byTime = (x: PeAlertItem, y: PeAlertItem): number =>
    y.detectedAt.getTime() - x.detectedAt.getTime();
  return {
    critical: mine.filter((a) => a.severity === 'critical').sort(byTime),
    regular: mine.filter((a) => a.severity !== 'critical').sort(byTime),
  };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPeDigestEmail(
  digest: UserDigest,
  opts: { appBaseUrl: string },
): { subject: string; html: string; text: string } {
  const total = digest.critical.length + digest.regular.length;
  const subject =
    `PE Watch daily digest — ${total} update${total === 1 ? '' : 's'}` +
    (digest.critical.length > 0 ? ` (${digest.critical.length} critical)` : '');

  const textLines: string[] = [];
  const htmlRows: string[] = [];
  const renderItem = (a: PeAlertItem, badge: string): void => {
    const links = a.relatedPeCodes
      .map((pe) => `${opts.appBaseUrl}/program-elements/${encodeURIComponent(pe)}`)
      .join(' ');
    const firstLine = (a.description ?? '').split('\n')[0] ?? '';
    textLines.push(`${badge} ${a.title}`, firstLine ? `  ${firstLine}` : '', `  ${links}`, '');
    htmlRows.push(
      `<tr><td style="padding:6px 10px;vertical-align:top;white-space:nowrap"><strong>${esc(badge)}</strong></td>` +
        `<td style="padding:6px 10px"><div>${esc(a.title)}</div>` +
        (firstLine ? `<div style="color:#555">${esc(firstLine)}</div>` : '') +
        `<div>${a.relatedPeCodes
          .map(
            (pe) =>
              `<a href="${esc(`${opts.appBaseUrl}/program-elements/${encodeURIComponent(pe)}`)}">${esc(pe)}</a>`,
          )
          .join(' · ')}</div></td></tr>`,
    );
  };
  for (const a of digest.critical) renderItem(a, 'CRITICAL');
  for (const a of digest.regular) renderItem(a, a.severity === 'notable' ? 'NOTABLE' : 'INFO');

  const html =
    `<p>Your watched program elements had <strong>${total}</strong> update${total === 1 ? '' : 's'} in the last day.</p>` +
    `<table style="border-collapse:collapse;font-family:system-ui,sans-serif;font-size:14px">${htmlRows.join('')}</table>` +
    `<p style="color:#777;font-size:12px">PE Watch · configure email alerts on the <a href="${esc(`${opts.appBaseUrl}/program-elements`)}">Program Elements</a> page</p>`;

  return { subject, html, text: textLines.join('\n') };
}

// ── Unified watchlist matching (plan Phase 2 step: one client watchlist powers
//    PE alerts too). Whole-word, case-insensitive matching of watchlist tag
//    terms against a PE's title + capability terms. Terms that are too short
//    or single generic words are skipped — candidate quality over recall.

export interface WatchlistTagLike {
  tag?: string;
  synonyms?: string[];
  relatedEntities?: string[];
}

export interface ClientWatchlistLike {
  clientId: string;
  tags: WatchlistTagLike[];
}

export interface PeMatchable {
  peCode: string;
  title: string;
  capabilityTerms: string[];
}

/** A term is usable when it is specific enough to mean something in a PE title. */
export function isUsableWatchTerm(term: string): boolean {
  const t = term.trim();
  if (t.length < 4) return false;
  const tokens = t.split(/\s+/);
  if (tokens.length >= 2) return true;
  // Single token: allow designators like F-35 / MQ-9 / AIM-260 (letter+digit mix),
  // reject plain words ("autonomy", "aircraft") — too generic against titles.
  return /\d/.test(t) && /[a-z]/i.test(t);
}

function wholeWordIncludes(haystackLower: string, termLower: string): boolean {
  let idx = haystackLower.indexOf(termLower);
  while (idx !== -1) {
    const before = idx === 0 ? '' : haystackLower[idx - 1];
    const afterIdx = idx + termLower.length;
    const after = afterIdx >= haystackLower.length ? '' : haystackLower[afterIdx];
    const boundary = (c: string | undefined): boolean => !c || !/[a-z0-9]/.test(c);
    if (boundary(before) && boundary(after)) return true;
    idx = haystackLower.indexOf(termLower, idx + 1);
  }
  return false;
}

/** Client ids whose watchlist terms hit this PE's title/capability terms. */
export function matchWatchlistClients(
  pe: PeMatchable,
  watchlists: ClientWatchlistLike[],
): string[] {
  const haystack = `${pe.title} ${pe.capabilityTerms.join(' ')}`.toLowerCase();
  const out: string[] = [];
  for (const wl of watchlists) {
    let hit = false;
    for (const tag of wl.tags) {
      const terms = [tag.tag, ...(tag.synonyms ?? []), ...(tag.relatedEntities ?? [])].filter(
        (t): t is string => typeof t === 'string' && isUsableWatchTerm(t),
      );
      if (terms.some((t) => wholeWordIncludes(haystack, t.toLowerCase()))) {
        hit = true;
        break;
      }
    }
    if (hit) out.push(wl.clientId);
  }
  return out;
}

/** Parse the ClientWatchlist.tags Json column defensively. */
export function parseWatchlistTags(tagsJson: unknown): WatchlistTagLike[] {
  if (!Array.isArray(tagsJson)) return [];
  return tagsJson.filter((t): t is WatchlistTagLike => typeof t === 'object' && t !== null);
}
