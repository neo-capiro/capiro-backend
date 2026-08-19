/**
 * Data Explorer vNext — formatters + news-outlet brand helpers.
 *
 * Ported 1:1 from `pages/explorer/DataExplorerPage.tsx` (Phase 2 old-UI purge).
 * Output strings must stay byte-identical with the canonical page: the same
 * money/date rendering appears on app.capiro.ai and any drift here would show
 * two different "facts" for the same record across the two surfaces.
 */

export const PAGE_SIZE = 25;

export function formatMoney(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toLocaleString()}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

export function partyName(short: string): string {
  if (short === 'D') return 'Democrat';
  if (short === 'R') return 'Republican';
  if (short === 'I') return 'Independent';
  return short;
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

export interface SourceBrand {
  label: string;
  host: string;
  color: string;
  mono: string;
}

// Curated brand colors for the outlets Capiro tracks most heavily; anything
// else falls back to a deterministic hue derived from the source name so each
// outlet keeps a stable, recognizable mark across sessions.
export const OUTLET_BRANDS: Record<string, string> = {
  politico: '#e5121e',
  'roll call': '#0b6db3',
  rollcall: '#0b6db3',
  'the hill': '#1a8fd0',
  axios: '#0a3ab8',
  punchbowl: '#d94436',
  'punchbowl news': '#d94436',
  reuters: '#ff8000',
  bloomberg: '#1a1a2e',
  'the new york times': '#1a1a1a',
  'washington post': '#1a1a1a',
  'the washington post': '#1a1a1a',
  'wall street journal': '#1a1a1a',
  npr: '#c0143c',
  cnn: '#cc0000',
  'associated press': '#ff322e',
  ap: '#ff322e',
  'federal news network': '#16518a',
  govexec: '#0a6b53',
  'government executive': '#0a6b53',
  'defense news': '#2c5bd4',
  'inside health policy': '#2e6b43',
};

export function sourceBrand(source: string | null, url: string | null): SourceBrand {
  const label = (source ?? '').trim();
  const key = label.toLowerCase();
  let host = '';
  try {
    if (url) host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const hostKey = host.replace(/\.(com|org|net|gov|news|co)(\.[a-z]{2})?$/i, '');
  const color =
    OUTLET_BRANDS[key] ??
    OUTLET_BRANDS[hostKey] ??
    hashColor(key || host || 'news');
  return { label: label || host || 'News', host, color, mono: monogram(label || host) };
}

export function monogram(name: string): string {
  const cleaned = name.replace(/^the\s+/i, '').trim();
  const words = cleaned.split(/[\s.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase() || 'N';
}

export function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 52%, 42%)`;
}
