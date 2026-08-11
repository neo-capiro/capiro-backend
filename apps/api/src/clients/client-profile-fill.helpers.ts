import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const CLIENT_PROFILE_FILL_SOURCES = [
  'public_web',
  'synced_email',
  'sam_gov',
  'lda',
  'program_elements',
] as const;
export type ClientProfileFillSource = (typeof CLIENT_PROFILE_FILL_SOURCES)[number];

export const CLIENT_PROFILE_FILL_KINDS = [
  'profile_field',
  'government_identity',
  'person',
  'facility',
  'capability',
  'lda_identity',
  'lda_history',
  'program_element',
] as const;
export type ClientProfileFillKind = (typeof CLIENT_PROFILE_FILL_KINDS)[number];

export type ClientProfileFillFactKind = 'fact' | 'recommendation';
export type ClientProfileFillFindingStatus = 'pending' | 'accepted' | 'rejected' | 'informational';
export type ClientProfileFillRunStatus = 'running' | 'completed' | 'partial' | 'failed';

export type FillEvidence = {
  label: string;
  url?: string | null;
  excerpt?: string | null;
  source?: string | null;
  observedAt?: string | null;
  metadata?: Record<string, unknown>;
};

export function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortDeep(child)]),
    );
  }
  return value;
}

export function fillFindingHash(input: {
  kind: ClientProfileFillKind;
  targetKey: string;
  source: string;
  proposedValue: unknown;
}): string {
  return createHash('sha256')
    .update(
      stableJson({
        kind: input.kind,
        targetKey: input.targetKey,
        source: input.source,
        proposedValue: input.proposedValue,
      }),
    )
    .digest('hex');
}

export function normalizeWebsite(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let candidate = value;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function websiteDomain(raw: string | null | undefined): string | null {
  const normalized = normalizeWebsite(raw);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function emailDomain(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value || !value.includes('@')) return null;
  const domain = value.split('@').pop()?.trim() ?? '';
  return domain && !domain.includes(' ') ? domain : null;
}

export function normalizedName(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeComparableUrl(raw: string | null | undefined): string | null {
  const normalized = normalizeWebsite(raw);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.search = '';
    url.hash = '';
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

export function resolveEvidenceUrl(
  candidate: string | null | undefined,
  allowedUrls: Iterable<string>,
): string | null {
  const wanted = normalizeComparableUrl(candidate);
  if (!wanted) return null;
  const allowed = [...allowedUrls]
    .map((url) => ({ raw: url, normalized: normalizeComparableUrl(url) }))
    .filter((row): row is { raw: string; normalized: string } => Boolean(row.normalized));
  const exact = allowed.find((row) => row.normalized === wanted);
  return exact?.raw ?? null;
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stripHtmlToText(html: string, maxChars = 12_000): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  const text = decodeBasicEntities(withoutNoise.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
}

export function metaDescription(html: string): string | null {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeBasicEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 1000);
  }
  return null;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

export function isPrivateOrLocalIp(address: string): boolean {
  if (!isIP(address)) return false;
  const lower = address.toLowerCase();
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  );
}

export function capabilitySearchTerms(value: unknown): string[] {
  const rec = asRecord(value);
  const raw: string[] = [];
  for (const key of ['name', 'description'] as const) {
    if (typeof rec[key] === 'string') raw.push(rec[key] as string);
  }
  for (const key of ['keywords', 'tags'] as const) {
    const values = rec[key];
    if (Array.isArray(values)) {
      for (const item of values) if (typeof item === 'string') raw.push(item);
    }
  }
  const stop = new Set([
    'and', 'the', 'for', 'with', 'from', 'that', 'this', 'into', 'their', 'company',
    'system', 'systems', 'service', 'services', 'solution', 'solutions', 'technology',
    'technologies', 'platform', 'product', 'products', 'defense', 'federal', 'government',
  ]);
  const seen = new Set<string>();
  for (const text of raw) {
    for (const token of text.toLowerCase().split(/[^a-z0-9-]+/)) {
      const cleaned = token.replace(/^-+|-+$/g, '');
      if (cleaned.length < 4 || stop.has(cleaned)) continue;
      seen.add(cleaned);
    }
  }
  return [...seen].slice(0, 20);
}

export function provisionalPeScore(
  pe: { title?: string | null; description?: string | null },
  terms: string[],
): { score: number; matched: string[] } {
  const haystack = `${pe.title ?? ''} ${pe.description ?? ''}`.toLowerCase();
  const matched = terms.filter((term) => haystack.includes(term));
  if (!matched.length) return { score: 0, matched: [] };
  const score = Math.min(0.78, 0.34 + matched.length * 0.09);
  return { score: Number(score.toFixed(3)), matched };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}
