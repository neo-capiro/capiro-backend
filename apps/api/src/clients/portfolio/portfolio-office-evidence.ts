import { wholeWordHit } from '../../tracker/tracker-relevance.util.js';
import type { PortfolioEvidence } from './portfolio.contracts.js';

export const hitsTerms = (text: string, terms: readonly string[]) =>
  terms.some((term) => wholeWordHit(text.toLowerCase(), term));
export function currentCongress(at = new Date()): number {
  const year = at.getUTCFullYear();
  return Math.floor(((at < new Date(Date.UTC(year, 0, 3, 17)) ? year - 1 : year) - 1789) / 2) + 1;
}
export function officialEvidence(
  url: string | null,
  title: string,
  excerpt: string,
  at: Date | null,
): PortfolioEvidence | null {
  if (!url || !at || !Number.isFinite(at.getTime()) || at > new Date()) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      !/(^|\.)gov$/i.test(parsed.hostname)
    )
      return null;
  } catch {
    return null;
  }
  return {
    url,
    title: title.slice(0, 180),
    excerpt: excerpt.slice(0, 4000),
    observedAt: at.toISOString(),
    sourceType: 'official',
  };
}
