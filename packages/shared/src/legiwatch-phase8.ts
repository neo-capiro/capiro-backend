import { compileKeywordQuery, type KeywordAst } from './legiwatch-query.js';

export const NEWS_QUERY_VERSION = 'legiwatch-news-query-v1';
export const PHASE8_FEATURES = {
  // Retained Meri source reads still require the original capability gate.
  news: 'legiwatch_news_v1',
  budget: 'legiwatch_florida_budget_v1',
  editorial: 'legiwatch_editorial_v1',
} as const;
export function compileNewsQuery(raw: string) {
  const compiled = compileKeywordQuery(raw);
  function provider(n: KeywordAst): string {
    if (n.kind === 'term') {
      if (n.wildcard !== 'none') throw Error('NEWS_WILDCARD_REQUIRES_REVIEW');
      return `"${n.value}"`;
    }
    if (n.kind === 'phrase') return `"${n.value}"`;
    if (n.kind === 'not') return `NOT (${provider(n.child)})`;
    return `(${n.children.map(provider).join(n.kind === 'and' ? ' AND ' : ' OR ')})`;
  }
  try {
    return {
      ...compiled,
      adapterVersion: NEWS_QUERY_VERSION,
      providerQuery: compiled.ast ? provider(compiled.ast) : null,
    };
  } catch (error) {
    return {
      ...compiled,
      status: 'unsupported' as const,
      adapterVersion: NEWS_QUERY_VERSION,
      providerQuery: null,
      reasons: [(error as Error).message],
    };
  }
}
export function canonicalNewsUrl(raw: string) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw Error('INVALID_SOURCE_URL');
  url.hash = '';
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => keys.push(key));
  for (const key of keys)
    if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key))
      url.searchParams.delete(key);
  return url.toString();
}
export type EvidenceRef = {
  kind: 'news' | 'budget' | 'personnel' | 'research';
  id: string;
  revision: string;
  locator: string;
};
export type BudgetAmount = {
  id: string;
  projectId: string;
  fiscalYear: string;
  periodStart: string;
  periodEnd: string;
  currency: 'USD';
  fund: string;
  basis: 'recurring' | 'nonrecurring' | 'total';
  measure: 'money' | 'positions' | 'percentage';
  minorUnits: string | null;
  state: 'amount' | 'blank' | 'omitted' | 'embedded' | 'unpublished';
  stage: string;
  chamber: string;
  offer: string | null;
  sourceRevision: string;
  documentId: string;
  locator: string;
  unitMultiplier: string;
  allocationBasis: string;
  qualified: boolean;
  valueRole?: 'allocation_amount' | 'vetoed_amount';
};
export function dollarsToMinorUnits(raw: string, unitMultiplier = '1'): string {
  const text = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text) || !/^[1-9]\d*$/.test(unitMultiplier))
    throw Error('EXACT_MONEY_REQUIRED');
  const negative = text.startsWith('-'),
    [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  return (
    (negative ? -1n : 1n) *
    (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))) *
    BigInt(unitMultiplier)
  ).toString();
}
export function compareBudgetAmounts(left: BudgetAmount, right: BudgetAmount) {
  const reasons: string[] = [];
  if ((left.valueRole ?? 'allocation_amount') !== (right.valueRole ?? 'allocation_amount'))
    reasons.push('INCOMPATIBLE_VALUE_ROLE');
  for (const key of [
    'projectId',
    'fiscalYear',
    'periodStart',
    'periodEnd',
    'currency',
    'fund',
    'basis',
    'measure',
    'allocationBasis',
  ] as const)
    if (left[key] !== right[key]) reasons.push(`INCOMPATIBLE_${key}`);
  if (!left.qualified || !right.qualified) reasons.push('SOURCE_NOT_QUALIFIED');
  if (left.measure !== 'money' || right.measure !== 'money')
    reasons.push('MONEY_MEASURES_REQUIRED');
  if (
    [left, right].some(
      (a) => a.state !== 'amount' || a.minorUnits === null || !/^-?\d+$/.test(a.minorUnits),
    )
  )
    reasons.push('AMOUNT_UNAVAILABLE');
  if (reasons.length)
    return { left, right, comparable: false, reasons, deltaMinorUnits: null, percentage: null };
  const a = BigInt(left.minorUnits!),
    b = BigInt(right.minorUnits!),
    delta = b - a;
  const scaled = a === 0n ? null : (delta * 10000n) / (a < 0n ? -a : a);
  const percentage =
    scaled === null
      ? null
      : `${scaled < 0n ? '-' : ''}${(scaled < 0n ? -scaled : scaled) / 100n}.${((scaled < 0n ? -scaled : scaled) % 100n).toString().padStart(2, '0')}%`;
  return {
    left,
    right,
    comparable: true,
    reasons: a === 0n ? ['ZERO_BASELINE_PERCENTAGE_UNDEFINED'] : [],
    deltaMinorUnits: delta.toString(),
    percentage,
  };
}
export type BriefingTemplate = 'research_update' | 'daily_legislative_brief';
export const BRIEFING_TEMPLATES: Record<BriefingTemplate, string> = {
  research_update: 'Research Update',
  daily_legislative_brief: 'Daily Legislative Brief',
};
export type BriefingSchedule = {
  timezone: string;
  hour: number;
  minute: number;
  weekdays: number[];
  noChange: 'draft' | 'skip';
  sourceGap: 'hold' | 'draft';
  mode: 'prepare' | 'send';
};
export function validateBriefingSchedule(value: BriefingSchedule) {
  if (
    !value ||
    typeof value.timezone !== 'string' ||
    !value.timezone.trim() ||
    !Number.isInteger(value.hour) ||
    value.hour < 0 ||
    value.hour > 23 ||
    !Number.isInteger(value.minute) ||
    value.minute < 0 ||
    value.minute > 59 ||
    !Array.isArray(value.weekdays) ||
    !value.weekdays.length ||
    value.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
    !['draft', 'skip'].includes(value.noChange) ||
    !['hold', 'draft'].includes(value.sourceGap) ||
    !['prepare', 'send'].includes(value.mode)
  )
    throw Error('INVALID_BRIEFING_SCHEDULE');
  new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format(new Date());
  return value;
}
/** One local-day identity: the repeated DST hour cannot create two editions;
 * a skipped hour catches up after the jump. Missed previous days stay missed. */
export function briefingOccurrence(now: Date, schedule: BriefingSchedule): string | null {
  validateBriefingSchedule(schedule);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday!);
  if (
    !schedule.weekdays.includes(weekday) ||
    Number(values.hour) * 60 + Number(values.minute) < schedule.hour * 60 + schedule.minute
  )
    return null;
  return `${values.year}-${values.month}-${values.day}@${schedule.timezone}`;
}
