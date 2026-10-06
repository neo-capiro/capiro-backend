type Coverage = Record<string, unknown>;
export type PublisherIntakeReceipt = {
  id: string;
  source: string;
  source_url: string;
  observed_at: Date | string;
  scope: { publisher?: string };
  manifest: Record<string, unknown>;
  complete: boolean;
};
// Exact configured identities in apps/api/scripts/sync-rss-intel.ts. These are
// feed identities, not a claim that the reference catalog's regional scope is qualified.
export const publisherIntakeEndpoints = [
  { publisher: 'The Hill', slug: 'the_hill', url: 'https://thehill.com/feed/' },
  { publisher: 'Politico', slug: 'politico', url: 'https://rss.politico.com/politics-news.xml' },
  {
    publisher: 'Politico',
    slug: 'politico_congress',
    url: 'https://rss.politico.com/congress.xml',
  },
  {
    publisher: 'CBS Miami',
    slug: 'cbs_miami',
    url: 'https://www.cbsnews.com/miami/latest/rss/main',
  },
  { publisher: 'Florida Daily', slug: 'florida_daily', url: 'https://floridadaily.com/feed/' },
  {
    publisher: 'Florida Phoenix',
    slug: 'florida_phoenix',
    url: 'https://floridaphoenix.com/feed/',
  },
  { publisher: 'WUSF', slug: 'wusf', url: 'https://www.wusf.org/news.rss' },
] as const;
type ReceiptReader = {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};
export async function loadPublisherIntakeReceipts(tx: ReceiptReader) {
  // One latest receipt per exact endpoint, independent of article filters/window.
  // A newer failure must remain authoritative even when older articles exist.
  return tx.$queryRaw<
    PublisherIntakeReceipt[]
  >`SELECT r.id,r.source,r.source_url,r.observed_at,r.scope,r.manifest,r.complete
    FROM jsonb_to_recordset(${JSON.stringify(publisherIntakeEndpoints)}::jsonb) AS e(slug text,url text)
    CROSS JOIN LATERAL (
      SELECT id,source,source_url,observed_at,scope,manifest,complete FROM legiwatch_source_receipt
      WHERE source IN ('rss','publisher-news') AND source_url=e.url AND scope->>'publisher'=e.slug
      ORDER BY observed_at DESC,id DESC LIMIT 1
    ) r`;
}
const normalizedName = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
function receiptStatus(
  receipt: PublisherIntakeReceipt,
): 'succeeded' | 'partial' | 'failed' | 'unknown' {
  const m = receipt.manifest;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'unknown';
  if (m.status === 'failed') return 'failed';
  if (m.status === 'partial') return 'partial';
  // Legacy receipts omit status; numeric results and current-feed scope are their
  // success contract. complete=false means history is unqualified, not failure.
  if (
    (m.status === 'retained' || m.status == null) &&
    typeof m.retained === 'number' &&
    Number.isInteger(m.retained) &&
    m.retained >= 0 &&
    typeof m.rejected === 'number' &&
    Number.isInteger(m.rejected) &&
    m.rejected >= 0 &&
    ['current_feed_only', 'current_publisher_index_only'].includes(String(m.coverage))
  ) {
    return m.rejected > 0 || m.primaryFailure ? 'partial' : 'succeeded';
  }
  return 'unknown';
}
function intakeFor(source: Coverage, receipts: PublisherIntakeReceipt[]) {
  const endpoints = publisherIntakeEndpoints.filter(
    (endpoint) =>
      normalizedName(endpoint.publisher) === normalizedName(source.publisher) ||
      endpoint.url === source.source_url,
  );
  const feeds = endpoints.map((endpoint) => {
    const receipt = receipts
      .filter(
        (r) =>
          r.source_url === endpoint.url &&
          r.scope?.publisher === endpoint.slug &&
          ['rss', 'publisher-news'].includes(r.source) &&
          Number.isFinite(new Date(r.observed_at).getTime()),
      )
      .sort(
        (a, b) =>
          new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime() ||
          b.id.localeCompare(a.id),
      )[0];
    return {
      url: endpoint.url,
      publisher: endpoint.slug,
      status: receipt ? receiptStatus(receipt) : 'not_checked',
      observedAt: receipt ? new Date(receipt.observed_at).toISOString() : null,
      reason:
        receipt && typeof receipt.manifest?.reason === 'string' ? receipt.manifest.reason : null,
      primaryFailure:
        receipt && typeof receipt.manifest?.primaryFailure === 'string'
          ? receipt.manifest.primaryFailure
          : null,
    };
  });
  return {
    status: !feeds.length
      ? 'no_verified_endpoint'
      : feeds.every((f) => f.status === 'succeeded')
        ? 'succeeded'
        : feeds.every((f) => f.status === 'failed')
          ? 'failed'
          : feeds.every((f) => f.status === 'not_checked')
            ? 'not_checked'
            : 'partial',
    feeds,
  };
}
export type PublisherObservation = {
  publisher: string;
  articles: number;
  full_text_articles: number;
  latest_published_at: Date | string | null;
  latest_observed_at: Date | string | null;
};
const names: Record<string, string> = { 'the hill': 'thehill.com', politico: 'politico.com' };
function key(value: unknown): string {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (names[text]) return names[text]!;
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).hostname.replace(/^www\./, '');
  } catch {
    return text;
  }
}
const latest = (values: Array<Date | string | null>) => {
  const dates = values
    .filter((v): v is Date | string => v != null)
    .map((v) => new Date(v).getTime())
    .filter(Number.isFinite);
  return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
};
/** Observed publisher content is separate from configured regional/provider availability. */
export function reconcilePublisherCoverage(
  coverage: Coverage[],
  observed: PublisherObservation[],
  receipts: PublisherIntakeReceipt[] = [],
) {
  return coverage.map((source) => {
    const keys = new Set([
      key(source.publisher),
      ...(source.source_url ? [key(source.source_url)] : []),
    ]);
    const matches = observed.filter((row) => keys.has(key(row.publisher)));
    return {
      ...source,
      intake: intakeFor(source, receipts),
      retained: {
        articles: matches.reduce((n, row) => n + Number(row.articles), 0),
        fullTextArticles: matches.reduce((n, row) => n + Number(row.full_text_articles), 0),
        latestPublishedAt: latest(matches.map((row) => row.latest_published_at)),
        latestObservedAt: latest(matches.map((row) => row.latest_observed_at)),
      },
    };
  });
}
