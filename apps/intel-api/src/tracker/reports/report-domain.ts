import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const digest = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const json = (v: unknown) => JSON.parse(JSON.stringify(v));
export function storedRendering(value: unknown): { html: string; text: string } {
  const rendered = object(value);
  if (typeof rendered.html !== 'string' || typeof rendered.text !== 'string')
    throw new BadRequestException('FROZEN_EXPORT_UNAVAILABLE_REGENERATE_REPORT');
  return { html: rendered.html, text: rendered.text };
}
export function dateOnly(v: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    throw new BadRequestException('VALID_LEGISLATIVE_DATE_REQUIRED');
  return v;
}
export function text(v: unknown, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new BadRequestException('INVALID_TEXT');
  return v.trim();
}
export function ids(v: unknown, max = 100): string[] {
  if (
    !Array.isArray(v) ||
    v.length > max ||
    v.some((x) => typeof x !== 'string' || !x || x.length > 200)
  )
    throw new BadRequestException('INVALID_ID_SELECTION');
  return [...new Set(v as string[])];
}
export function version(v: unknown): number {
  if (!Number.isSafeInteger(v) || Number(v) < 0)
    throw new BadRequestException('EXPECTED_VERSION_REQUIRED');
  return Number(v);
}
const choose = <T extends string>(v: unknown, choices: readonly T[], fallback: T): T => {
  if (v === undefined) return fallback;
  if (!choices.includes(v as T)) throw new BadRequestException('UNSUPPORTED_REPORT_SETTING');
  return v as T;
};
const bool = (v: unknown, fallback = false): boolean => {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new BadRequestException('BOOLEAN_REQUIRED');
  return v;
};
export interface ReportSettings {
  committees: 'off' | 'current' | 'all';
  actions: 'off' | 'last' | 'last3' | 'five_days' | 'all';
  relations: 'off' | 'title' | 'title_action';
  summary: boolean;
  order: 'number' | 'folder' | 'last_action';
  links: 'public' | 'subscribers';
  priority: boolean;
  externalComments: boolean;
  internalComments: boolean;
  billNotes: boolean;
  reportComments: boolean;
  actionDateFrom?: string;
  actionDateTo?: string;
  priorityOnly: boolean;
  acceptOptionalGaps: boolean;
  includeArchived: boolean;
}
export function settings(value: unknown): ReportSettings {
  const s = object(value);
  const result: ReportSettings = {
    committees: choose(s.committees, ['off', 'current', 'all'], 'off'),
    actions: choose(s.actions, ['off', 'last', 'last3', 'five_days', 'all'], 'last'),
    relations: choose(s.relations, ['off', 'title', 'title_action'], 'off'),
    summary: bool(s.summary, true),
    order: choose(s.order, ['number', 'folder', 'last_action'], 'number'),
    links: choose(s.links, ['public', 'subscribers'], 'subscribers'),
    priority: bool(s.priority),
    externalComments: bool(s.externalComments),
    internalComments: bool(s.internalComments),
    billNotes: bool(s.billNotes),
    reportComments: bool(s.reportComments),
    priorityOnly: bool(s.priorityOnly),
    acceptOptionalGaps: bool(s.acceptOptionalGaps),
    includeArchived: bool(s.includeArchived),
  };
  if (s.actionDateFrom) result.actionDateFrom = dateOnly(String(s.actionDateFrom));
  if (s.actionDateTo) result.actionDateTo = dateOnly(String(s.actionDateTo));
  if (result.actionDateFrom && result.actionDateTo && result.actionDateFrom > result.actionDateTo)
    throw new BadRequestException('ACTION_RANGE_REVERSED');
  return result;
}

/** Normalize captured controls, never names or guessed report/list joins. */
export function capturedReport(raw: Record<string, unknown>): ReportSettings {
  const lookup = (v: unknown, values: Record<string, string>) => {
    const selected = values[String(v)];
    if (!selected) throw new BadRequestException('CAPTURED_CONTROL_REQUIRES_REVIEW');
    return selected;
  };
  if (!Array.isArray(raw.other_checked_flags) || raw.other_checked_flags.length)
    throw new BadRequestException('ADDITIONAL_CAPTURED_CONTROLS_REQUIRE_REVIEW');
  return settings({
    committees: lookup(raw.committee_references, {
      'Off:': 'off',
      'Current Committee:': 'current',
      'All Committee References:': 'all',
    }),
    actions: lookup(raw.actions, {
      'Off:': 'off',
      'Last Action:': 'last',
      'Last 3 Actions:': 'last3',
      'Last 5 Days Actions:': 'five_days',
      'All Actions:': 'all',
    }),
    relations: lookup(raw.related_bills, {
      'Off:': 'off',
      'Title Only:': 'title',
      'Title and last action:': 'title_action',
    }),
    summary: raw.show_summary,
    order: lookup(raw.order, {
      'Bill number': 'number',
      Folder: 'folder',
      'Last action date': 'last_action',
    }),
    links: lookup(raw.bill_link_access, {
      'Anyone can view bill links': 'public',
      'Only LobbyTools subscribers can view bill links': 'subscribers',
    }),
  });
}

export interface PublishedEvent {
  key: string;
  kind: string;
  sourceIdentity: string;
  revisionHash: string;
  date: string | null;
  text: string;
  order: number;
  observedAt: string;
  url: string | null;
  adopted?: boolean | null;
  notificationEligible?: boolean;
}
export interface Committee {
  id: string;
  name: string;
  current: boolean;
  date: string | null;
}
export interface RelatedBill {
  id: string | null;
  number: string | null;
  title: string | null;
  category: string;
  sourceUrl: string | null;
  actions: PublishedEvent[];
}
export interface ReportBill {
  id: string;
  number: string;
  title: string;
  sponsor: string | null;
  jurisdiction: string;
  sessionKey: string;
  status: string | null;
  sourceUrl: string | null;
  summary: string | null;
  sourceCheckedAt: string | null;
  sourceCheckAttemptedAt: string | null;
  sourceCheckStatus: string | null;
  coverage: { actions: boolean; committees: boolean; relations: boolean; amendments: boolean };
  committees: Committee[];
  relations: RelatedBill[];
  events: PublishedEvent[];
}
export interface ReportAssignment {
  id: string;
  folderId: string;
  folderName: string;
  folderVersion: number;
  archived: boolean;
  billId: string;
  version: number;
  topPriority: boolean;
  importance: string;
  position: string;
  internalComments: string;
  externalComments: string;
}
export interface ReportRow {
  id: string;
  number: string;
  title: string;
  sponsor: string | null;
  status: string | null;
  folderId: string;
  folderName: string;
  assignmentId: string;
  assignmentVersion: number;
  folderVersion: number;
  sourceUrl: string | null;
  billUrl: string | null;
  summary: string | null;
  lastActionAt: string | null;
  sourceCheckedAt: string | null;
  sourceCheckStatus: string | null;
  actions: PublishedEvent[];
  amendments: PublishedEvent[];
  committees: Committee[];
  relations: Array<Omit<RelatedBill, 'actions'> & { lastAction: PublishedEvent | null }>;
  priority?: string;
  position?: string;
  externalComments?: string;
  internalComments?: string;
}
export interface ReportDocument {
  mode: 'bill_report';
  name: string;
  reportId: string;
  definitionVersion: number;
  audience: 'external' | 'internal';
  cutoff: string;
  generatedAt: string;
  datePolicy: string;
  currentFieldsNotice: string;
  settings: ReportSettings;
  rows: ReportRow[];
  complete: boolean;
  issues: Array<{ billId: string; field: string; reason: string; blocking: boolean }>;
  sourceCheckpoint: string;
  observedEventKeys: string[];
  observedEvents: Array<{ key: string; observedAt: string }>;
  selectionHash: string;
  updates?: {
    windowStart: string;
    windowEnd: string;
    records: Array<PublishedEvent & { billId: string; number: string }>;
  };
}
export const selectionHash = (assignments: ReportAssignment[]) =>
  digest(
    assignments
      .map((a) => [a.id, a.version, a.folderId, a.folderVersion, a.archived])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
export function numericBillOrder(
  a: Pick<ReportRow, 'id' | 'number'>,
  b: Pick<ReportRow, 'id' | 'number'>,
) {
  const av = BigInt(a.number.replace(/\D/g, '') || '0'),
    bv = BigInt(b.number.replace(/\D/g, '') || '0');
  return (
    (av < bv ? -1 : av > bv ? 1 : 0) ||
    a.number.replace(/\d/g, '').localeCompare(b.number.replace(/\d/g, '')) ||
    a.id.localeCompare(b.id)
  );
}
const byAction = (a: PublishedEvent, b: PublishedEvent) =>
  (a.date ?? '').localeCompare(b.date ?? '') || a.order - b.order || a.key.localeCompare(b.key);
export function makeDocument(input: {
  report: { id: string; name: string; version: number; settings: unknown };
  assignments: ReportAssignment[];
  bills: ReportBill[];
  cutoff: string;
  now: Date;
  audience: 'external' | 'internal';
}): ReportDocument {
  const cutoff = dateOnly(input.cutoff),
    s = settings(input.report.settings);
  const fiveStart = new Date(cutoff);
  fiveStart.setUTCDate(fiveStart.getUTCDate() - 4);
  const five = fiveStart.toISOString().slice(0, 10);
  const issues: ReportDocument['issues'] = [];
  const issue = (billId: string, field: string, reason: string, required = true) =>
    issues.push({ billId, field, reason, blocking: required || !s.acceptOptionalGaps });
  const catalog = new Map(input.bills.map((b) => [b.id, b]));
  const keys = new Set<string>();
  const observations = new Map<string, string>();
  const rows: ReportRow[] = [];
  for (const a of input.assignments) {
    if ((a.archived && !s.includeArchived) || (s.priorityOnly && !a.topPriority)) continue;
    const b = catalog.get(a.billId);
    if (!b) {
      issue(a.billId, 'identity', 'Canonical bill mapping unavailable');
      continue;
    }
    // A source failure cannot make a bill disappear through an action filter
    // and turn an unknown result into a complete no-change report.
    if (b.sourceCheckStatus !== 'success' || !b.sourceCheckedAt)
      issue(b.id, 'source', `Source check ${b.sourceCheckStatus ?? 'unknown'}`);
    if (b.sourceCheckedAt && input.now.getTime() - Date.parse(b.sourceCheckedAt) > 24 * 3600_000)
      issue(b.id, 'freshness', 'Last successful source check is more than 24 hours old');
    if (!b.coverage.actions) issue(b.id, 'actions', 'Published action coverage incomplete');
    const actions = b.events
      .filter((e) => e.kind === 'action' && e.date && e.date <= cutoff)
      .sort(byAction);
    if (
      (s.actionDateFrom || s.actionDateTo) &&
      !actions.some(
        (e) =>
          (!s.actionDateFrom || e.date! >= s.actionDateFrom) &&
          (!s.actionDateTo || e.date! <= s.actionDateTo),
      )
    )
      continue;
    for (const e of b.events)
      if (e.observedAt <= input.now.toISOString()) {
        keys.add(e.key);
        observations.set(e.key, e.observedAt);
      }
    if (!b.title.trim() || !b.sourceUrl)
      issue(b.id, 'identity', 'Required title or original source link unavailable');
    if (s.summary && !b.summary) issue(b.id, 'summary', 'Source description unavailable', false);
    if (s.committees === 'all' && !b.coverage.committees)
      issue(b.id, 'committees', 'Complete committee references unavailable', false);
    if (
      s.relations !== 'off' &&
      (!b.coverage.relations || b.relations.some((r) => !r.id || !r.title))
    )
      issue(b.id, 'relations', 'Related bill detail incomplete', false);
    if (s.billNotes)
      issue(
        b.id,
        'billNotes',
        'Global bill notes are not available in the source projection',
        false,
      );
    if (s.reportComments)
      issue(
        b.id,
        'reportComments',
        'Captured comments are historical observations and require separate review',
        false,
      );
    const displayed =
      s.actions === 'off'
        ? []
        : s.actions === 'last'
          ? actions.slice(-1)
          : s.actions === 'last3'
            ? actions.slice(-3)
            : s.actions === 'five_days'
              ? actions.filter((e) => e.date! >= five)
              : actions;
    const row: ReportRow = {
      id: b.id,
      number: b.number,
      title: b.title,
      sponsor: b.sponsor,
      status: b.status,
      folderId: a.folderId,
      folderName: a.folderName,
      assignmentId: a.id,
      assignmentVersion: a.version,
      folderVersion: a.folderVersion,
      sourceUrl: safeUrl(b.sourceUrl),
      billUrl: s.links === 'public' ? safeUrl(b.sourceUrl) : `/bills/${encodeURIComponent(b.id)}`,
      summary: s.summary ? b.summary : null,
      lastActionAt: actions.at(-1)?.date ?? null,
      sourceCheckedAt: b.sourceCheckedAt,
      sourceCheckStatus: b.sourceCheckStatus,
      actions: displayed,
      amendments: b.events
        .filter((e) => e.kind === 'amendment' && (!e.date || e.date <= cutoff))
        .sort(byAction),
      committees:
        s.committees === 'off'
          ? []
          : b.committees.filter((c) => s.committees === 'all' || c.current),
      relations:
        s.relations === 'off'
          ? []
          : b.relations.map(({ actions: relationActions, ...r }) => ({
              ...r,
              lastAction:
                s.relations === 'title_action'
                  ? (relationActions
                      .filter((e) => e.date && e.date <= cutoff)
                      .sort(byAction)
                      .at(-1) ?? null)
                  : null,
            })),
    };
    if (s.priority) {
      row.priority = a.topPriority ? `Top priority · ${a.importance}` : a.importance;
      row.position = a.position;
    }
    if (s.externalComments) row.externalComments = a.externalComments;
    if (s.internalComments && input.audience === 'internal')
      row.internalComments = a.internalComments;
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      (s.order === 'folder'
        ? a.folderName.localeCompare(b.folderName)
        : s.order === 'last_action'
          ? (b.lastActionAt ?? '').localeCompare(a.lastActionAt ?? '')
          : 0) ||
      numericBillOrder(a, b) ||
      a.folderId.localeCompare(b.folderId),
  );
  return {
    mode: 'bill_report',
    name: input.report.name,
    reportId: input.report.id,
    definitionVersion: input.report.version,
    audience: input.audience,
    cutoff,
    generatedAt: input.now.toISOString(),
    settings: s,
    rows,
    issues,
    complete: !issues.some((i) => i.blocking),
    sourceCheckpoint: input.now.toISOString(),
    observedEventKeys: [...keys].sort(),
    observedEvents: [...observations]
      .map(([key, observedAt]) => ({ key, observedAt }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    selectionHash: selectionHash(input.assignments),
    datePolicy:
      'Capiro policy: inclusive legislative dates; five-day display includes cutoff plus preceding four calendar dates.',
    currentFieldsNotice:
      'Titles, summaries and status reflect the source at generation. The cutoff filters dated actions, not historical versions of current fields.',
  };
}

export const escapeHtml = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const safeUrl = (url: string | null): string | null => {
  try {
    const u = new URL(url ?? '');
    return ['https:', 'http:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
export function renderReport(d: ReportDocument, appOrigin = 'https://os.capiro.ai') {
  const e = escapeHtml;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(d.name)}</title>
  <style>body{font:15px/1.55 system-ui,sans-serif;color:#182624;max-width:900px;margin:32px auto;padding:0 24px}h1{font-size:32px;line-height:1.2}h2{font-size:20px;break-after:avoid}h3{font-size:14px}a{color:#136f63;overflow-wrap:anywhere}article{border-top:1px solid #d8dfdc;padding:16px 0}p{margin:8px 0}.meta{font-size:12px;color:#556762}.warning{padding:12px;border:1px solid #b78321;background:#fff8e7}li{margin-bottom:6px}@media print{body{margin:0;max-width:none;font-size:10pt}h1,h2,h3{break-after:avoid}li{break-inside:avoid}thead{display:table-header}a{color:inherit}}</style></head><body>
  <p class="meta">CAPIRO · LEGISLATIVE REPORT · ${e(d.audience.toUpperCase())}</p><h1>${e(d.name)}</h1><p>Published records through ${e(d.cutoff)}</p>
  <p class="meta">Generated ${e(d.generatedAt)} · Definition ${d.definitionVersion + 1} · ${d.rows.length} folder/bill rows</p>
  <p class="meta">${e(d.currentFieldsNotice)}</p>${d.issues.length ? `<aside class="warning"><strong>${d.complete ? 'Source notes' : 'Source check incomplete — delivery held'}</strong><ul>${d.issues.map((i) => `<li>${e(i.billId)}: ${e(i.reason)}</li>`).join('')}</ul></aside>` : ''}
  ${d.updates ? `<section><h2>New published records</h2><p class="meta">Observed ${e(d.updates.windowStart)} through ${e(d.updates.windowEnd)}. An older legislative date may be a late publication.</p>${d.updates.records.length ? `<ul>${d.updates.records.map((r) => `<li><strong>${e(r.number)} · ${e(r.kind)}</strong><br>${e(r.date ?? 'Date unavailable')} — ${e(r.text)}${safeUrl(r.url) ? ` · <a href="${e(r.url)}">Source record</a>` : ''}</li>`).join('')}</ul>` : '<p>No new published records in this occurrence.</p>'}</section>` : ''}
  ${d.rows
    .map((r) => {
      const url = r.billUrl?.startsWith('/') ? `${appOrigin}${r.billUrl}` : safeUrl(r.billUrl);
      return `<article><h2>${url ? `<a href="${e(url)}">${e(r.number)}</a>` : e(r.number)} · ${e(r.title)}</h2>
    <p class="meta">${e(r.folderName)} · ${e(r.sponsor)} · ${e(r.status)}</p>${d.settings.links === 'subscribers' ? '<p class="meta">Bill detail links require an authorized Capiro account.</p>' : ''}
    ${r.summary ? `<h3>Source description</h3><p>${e(r.summary)}</p>` : ''}
    ${r.committees.length ? `<h3>Committee references</h3><ul>${r.committees.map((c) => `<li>${e(c.name)}${c.current ? ' · Current' : ''}${c.date ? ` · ${e(c.date)}` : ''}</li>`).join('')}</ul>` : ''}
    ${d.settings.actions !== 'off' ? `<h3>Published actions</h3>${r.actions.length ? `<ul>${r.actions.map((a) => `<li>${e(a.date)} — ${e(a.text)}</li>`).join('')}</ul>` : '<p>No actions in the selected display window.</p>'}` : ''}
    ${r.relations.length ? `<h3>Related bills</h3><ul>${r.relations.map((x) => `<li>${e(x.category)} · ${e(x.number)} — ${e(x.title ?? 'Detail unavailable')}${x.lastAction ? `<br>${e(x.lastAction.date)} — ${e(x.lastAction.text)}` : ''}</li>`).join('')}</ul>` : ''}
    ${r.priority ? `<p>${e(r.priority)} · ${e(r.position)}</p>` : ''}${r.externalComments ? `<h3>External comments</h3><p>${e(r.externalComments)}</p>` : ''}
    ${d.audience === 'internal' && r.internalComments ? `<h3>Internal comments</h3><p>${e(r.internalComments)}</p>` : ''}
    <p class="meta">Source check: ${e(r.sourceCheckStatus ?? 'unknown')} · ${e(r.sourceCheckedAt ?? 'not available')}${safeUrl(r.sourceUrl) ? ` · <a href="${e(r.sourceUrl)}">Original record</a>` : ''}</p></article>`;
    })
    .join('')}
  <footer class="meta">${e(d.datePolicy)}<p>This document has no public sharing permission. Legislative facts and source descriptions are distinct from Capiro analysis.</p></footer></body></html>`;
  const plainText = [
    d.name,
    `Published records through ${d.cutoff}`,
    d.currentFieldsNotice,
    ...(d.updates
      ? [
          'New published records',
          ...d.updates.records.map(
            (r) =>
              `${r.number} · ${r.kind} · ${r.date ?? 'Date unavailable'}: ${r.text}\n${r.url ?? ''}`,
          ),
        ]
      : []),
    ...d.issues.map((i) => `${i.billId}: ${i.reason}`),
    ...d.rows.map((r) =>
      [
        `${r.number} ${r.title}`,
        `${r.folderName} · ${r.sponsor ?? ''} · ${r.status ?? ''}`,
        r.summary ? `Source description: ${r.summary}` : '',
        ...r.committees.map((c) => `Committee: ${c.name}${c.current ? ' (current)' : ''}`),
        ...r.actions.map((a) => `${a.date}: ${a.text}`),
        ...r.relations.map(
          (x) =>
            `${x.category}: ${x.number ?? ''} ${x.title ?? 'Detail unavailable'}${x.lastAction ? ` — ${x.lastAction.date}: ${x.lastAction.text}` : ''}`,
        ),
        r.priority ? `${r.priority} · ${r.position ?? ''}` : '',
        r.externalComments ?? '',
        d.audience === 'internal' ? (r.internalComments ?? '') : '',
        r.billUrl?.startsWith('/')
          ? `${appOrigin}${r.billUrl} (authorized account required)`
          : (r.billUrl ?? ''),
        `Source check: ${r.sourceCheckStatus ?? 'unknown'} · ${r.sourceCheckedAt ?? 'unavailable'}`,
        r.sourceUrl ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    d.datePolicy,
  ].join('\n\n');
  return { html, text: plainText };
}
