import { contentHash, normalizedTitleKey } from './hearing-identity.js';
import { storedCommitteeIdentity } from './hearing-committee-identity.js';

export interface AliasReview {
  aliasId: string;
  canonicalId: string;
  reason: string;
  evidenceUrls: string[];
}
export interface ReviewedHearing {
  id: string;
  canonicalHearingId?: string | null;
  geographicJurisdiction?: string | null;
  congress?: number | null;
  chamber: string;
  visibility: string;
  committeeCode?: string | null;
  committeeSystemCode?: string | null;
  subcommitteeSystemCode?: string | null;
  title: string;
  date: Date;
  startsAt: Date | null;
}

/** Intentionally narrower than discovery. A manual repair never merges on a
 * similar title or a date alone, nor silently reconciles conflicting schedules. */
export function validateOfficialAliasReview(
  review: AliasReview,
  alias: ReviewedHearing,
  canonical: ReviewedHearing,
): void {
  const fail = (reason: string): never => {
    throw new Error(`Alias review refused: ${reason}`);
  };
  if (
    review.aliasId !== alias.id ||
    review.canonicalId !== canonical.id ||
    alias.id === canonical.id
  )
    fail('exact distinct hearing IDs are required');
  const a = /^(cm|sen)-(\d+)-(\d+)$/.exec(alias.id);
  const c = /^(cm|sen)-(\d+)-(\d+)$/.exec(canonical.id);
  if (!a || !c || a[1] === c[1] || a[2] !== c[2] || a[3] !== c[3])
    fail('the same official Senate event identifier and Congress are required');
  const ac = storedCommitteeIdentity(alias),
    cc = storedCommitteeIdentity(canonical);
  // The Senate schedule also publishes joint commissions. Congress.gov owns
  // the Joint chamber classification, proven by the shared official jc code.
  const jointScope =
    canonical.chamber.toLowerCase() === 'joint' &&
    alias.chamber.toLowerCase() === 'senate' &&
    cc.committeeSystemCode?.startsWith('jc') &&
    ac.committeeSystemCode === cc.committeeSystemCode;
  for (const row of [alias, canonical]) {
    if (row.canonicalHearingId) fail('existing aliases/chains require a separate review');
    if (
      (row.chamber.toLowerCase() !== 'senate' &&
        !(jointScope && row.chamber.toLowerCase() === 'joint')) ||
      (row.geographicJurisdiction && row.geographicJurisdiction !== 'US')
    )
      fail('only federal Senate events qualify');
    if (row.congress != null && row.congress !== Number(a![2])) fail('Congress scope conflict');
  }
  if (
    !['public', 'private'].includes(alias.visibility) ||
    alias.visibility !== canonical.visibility
  )
    fail('visibility conflict or unknown visibility');
  if (
    !ac.committeeSystemCode ||
    ac.committeeSystemCode !== cc.committeeSystemCode ||
    ac.subcommitteeSystemCode !== cc.subcommitteeSystemCode
  )
    fail('committee/subcommittee scope conflict');
  if (
    alias.date.toISOString() !== canonical.date.toISOString() ||
    !alias.startsAt ||
    !canonical.startsAt ||
    alias.startsAt.getTime() !== canonical.startsAt.getTime()
  )
    fail('schedule conflict or missing time');
  if (
    normalizedTitleKey(alias.title).length < 12 ||
    normalizedTitleKey(alias.title) !== normalizedTitleKey(canonical.title)
  )
    fail('published title conflict');
  if (
    !review.reason?.trim() ||
    !Array.isArray(review.evidenceUrls) ||
    review.evidenceUrls.length < 2
  )
    fail('a reason and both publisher evidence URLs are required');
  let matchingCongressUrl = false;
  for (const value of review.evidenceUrls) {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !/(^|\.)(congress\.gov|senate\.gov)$/.test(url.hostname)
    )
      fail('unqualified evidence URL');
    if (
      /(^|\.)congress\.gov$/.test(url.hostname) &&
      new RegExp(
        `/event/${a![2]}th-Congress/${jointScope ? 'joint' : 'senate'}-event/${a![3]}/?$`,
        'i',
      ).test(url.pathname)
    )
      matchingCongressUrl = true;
  }
  if (!matchingCongressUrl) fail('missing exact Congress.gov Senate event URL');
}

export function aliasPlanHash(value: unknown): string {
  return contentHash(value);
}
