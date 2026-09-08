import type { LdaFilingRow } from './lda-filings-api.js';

/** LDA amounts describe reporting periods; posting dates only order amendments. */
export function filingQuarter(period: string | null): number | null {
  const text = (period ?? '').toUpperCase().replace(/[_-]/g, ' ');
  const numeric = text.match(/\bQ([1-4])\b|\b([1-4])(?:ST|ND|RD|TH)?\s+QUARTER\b/);
  if (numeric) return Number(numeric[1] ?? numeric[2]);
  const ordinal = ['FIRST', 'SECOND', 'THIRD', 'FOURTH'].findIndex((word) =>
    text.includes(`${word} QUARTER`),
  );
  return ordinal < 0 ? null : ordinal + 1;
}

export function summarizeLdaPeriods(filings: LdaFilingRow[], now = new Date()) {
  const end = now.getUTCFullYear() * 4 + Math.floor(now.getUTCMonth() / 3) - 1;
  const start = end - 3;
  const year = Math.floor(end / 4);
  const quarter = (end % 4) + 1;
  const periodLabel = (index: number) => `Q${(index % 4) + 1} ${Math.floor(index / 4)}`;
  const groups = new Map<string, { row: LdaFilingRow; period: number; ambiguous: boolean }>();
  let unclassified = 0;
  for (const row of filings) {
    if (/LD\s*[- ]?1\b|REGISTRATION/i.test(row.filingType)) continue;
    const q = filingQuarter(row.filingPeriod);
    if (!q || !Number.isInteger(row.filingYear)) {
      unclassified++;
      continue;
    }
    const period = row.filingYear * 4 + q - 1;
    const identity = [
      row.registrantId ?? row.registrantName.trim().toLowerCase(),
      row.ldaClientId ?? row.clientName.trim().toLowerCase(),
      period,
    ];
    const key = JSON.stringify(identity);
    const previous = groups.get(key);
    const posted = Date.parse(row.postedAt ?? '') || 0;
    const previousPosted = Date.parse(previous?.row.postedAt ?? '') || 0;
    if (!previous || posted > previousPosted) groups.set(key, { row, period, ambiguous: false });
    else if (posted === previousPosted && row.amount !== previous.row.amount)
      previous.ambiguous = true;
  }
  const rows = [...groups.values()];
  const usable = rows.filter((entry) => !entry.ambiguous && Number.isFinite(entry.row.amount));
  const inWindow = usable.filter((entry) => entry.period >= start && entry.period <= end);
  const ambiguousWindow = rows.some(
    (entry) => entry.ambiguous && entry.period >= start && entry.period <= end,
  );
  const current = usable.filter((entry) => entry.period >= year * 4 && entry.period <= end);
  const prior = usable.filter((entry) => entry.period >= (year - 1) * 4 && entry.period <= end - 4);
  const sum = (entries: typeof usable) =>
    entries.reduce((total, entry) => total + entry.row.amount, 0);
  const comparable =
    new Set(current.map((entry) => entry.period)).size === quarter &&
    new Set(prior.map((entry) => entry.period)).size === quarter &&
    !rows.some(
      (entry) => entry.ambiguous && entry.period >= (year - 1) * 4 && entry.period <= end,
    ) &&
    unclassified === 0;
  const priorAmount = sum(prior);
  return {
    amount: ambiguousWindow || unclassified > 0 ? null : sum(inWindow),
    filingCount: inWindow.length,
    windowLabel: `${periodLabel(start)}–${periodLabel(end)}`,
    comparisonLabel: `Q1–Q${quarter} ${year} vs Q1–Q${quarter} ${year - 1}`,
    yoy:
      comparable && priorAmount > 0
        ? Math.round(((sum(current) - priorAmount) / priorAmount) * 100)
        : null,
    needsReview: ambiguousWindow || unclassified > 0,
  };
}
