type Coverage = Record<string, unknown>;
export type PublisherObservation = {
  publisher: string; articles: number; full_text_articles: number;
  latest_published_at: Date | string | null; latest_observed_at: Date | string | null;
};
const names: Record<string, string> = { 'the hill': 'thehill.com', politico: 'politico.com' };
function key(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (names[text]) return names[text]!;
  try { return new URL(text.includes('://') ? text : `https://${text}`).hostname.replace(/^www\./, ''); }
  catch { return text; }
}
const latest = (values: Array<Date | string | null>) => {
  const dates = values.filter((v): v is Date | string => v != null).map((v) => new Date(v).getTime()).filter(Number.isFinite);
  return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
};
/** Observed publisher content is separate from configured regional/provider availability. */
export function reconcilePublisherCoverage(coverage: Coverage[], observed: PublisherObservation[]) {
  return coverage.map((source) => {
    const keys = new Set([key(source.publisher), ...(source.source_url ? [key(source.source_url)] : [])]);
    const matches = observed.filter((row) => keys.has(key(row.publisher)));
    return { ...source, retained: {
      articles: matches.reduce((n, row) => n + Number(row.articles), 0),
      fullTextArticles: matches.reduce((n, row) => n + Number(row.full_text_articles), 0),
      latestPublishedAt: latest(matches.map((row) => row.latest_published_at)),
      latestObservedAt: latest(matches.map((row) => row.latest_observed_at)),
    } };
  });
}
