import { contentHash, isoDay } from './hearing-identity.js';

export type FloridaLegislativeChamber = 'house' | 'senate' | 'joint';

export interface FloridaOpenstatesAliasReview {
  repairId: string;
  aliasId: string;
  canonicalId: string;
  externalEventId: string;
  publisherMediaEntryId: string;
  session: string;
  date: string;
  chamber: FloridaLegislativeChamber;
  stateCommitteeId: string;
  bodySourceKey: string;
  aliasEvidenceUrl: string;
  canonicalEvidenceUrl: string;
  reason: string;
}

export interface FloridaAliasHearingReviewRow {
  id: string;
  canonicalHearingId: string | null;
  geographicJurisdiction: string | null;
  legislativeSession: string | null;
  chamber: string;
  committeeName: string;
  stateCommitteeId: string | null;
  bodySourceKey: string | null;
  date: Date;
}

export interface FloridaAliasCommitteeReviewRow {
  id: string;
  state: string;
  chamber: string | null;
  legislativeSession: string | null;
  officialSourceKey: string | null;
  name: string;
}

function fail(reason: string): never {
  throw new Error(`Florida OpenStates alias review refused: ${reason}`);
}

function displayChamber(chamber: FloridaLegislativeChamber): string {
  if (chamber === 'house') return 'House';
  if (chamber === 'senate') return 'Senate';
  return 'Joint';
}

function normalizedStateChamber(value: string | null): FloridaLegislativeChamber | null {
  const chamber = (value ?? '').trim().toLowerCase();
  if (chamber === 'upper' || chamber === 'senate') return 'senate';
  if (chamber === 'lower' || chamber === 'house') return 'house';
  if (chamber === 'joint') return 'joint';
  return null;
}

function requireEvidenceUrl(value: string, kind: 'alias' | 'canonical'): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`${kind} evidence URL is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    fail(`${kind} evidence URL must be credential-free HTTPS`);
  const host = url.hostname.toLowerCase();
  if (kind === 'canonical') {
    if (host !== 'thefloridachannel.org' || !/^\/videos\/[^/]+\/$/.test(url.pathname))
      fail('canonical evidence must be an exact Florida Channel video page');
  } else if (!(
    host === 'thefloridachannel.org' ||
    host === 'flsenate.gov' ||
    host.endsWith('.flsenate.gov') ||
    host === 'flhouse.gov' ||
    host.endsWith('.flhouse.gov')
  )) {
    fail('alias evidence must be an official Florida legislative publisher page');
  }
  return url;
}

export function validateFloridaOpenstatesAliasReview(review: FloridaOpenstatesAliasReview): void {
  if (!/^[a-z0-9][a-z0-9._-]{7,79}$/.test(review.repairId)) fail('invalid repair id');
  if (
    !/^state-fl-[a-f0-9]{32}$/.test(review.aliasId) ||
    !/^state-fl-[a-f0-9]{32}$/.test(review.canonicalId) ||
    review.aliasId === review.canonicalId
  )
    fail('exact distinct Florida hearing ids are required');
  if (!/^ocd-event\/[0-9a-f-]{36}$/i.test(review.externalEventId))
    fail('raw OpenStates event id is required');
  if (!/^1_[a-z0-9]+$/i.test(review.publisherMediaEntryId))
    fail('publisher Kaltura entry id is required');
  if (!/^20\d{2}$/.test(review.session)) fail('four-digit Florida session is required');
  if (
    !/^20\d{2}-\d{2}-\d{2}$/.test(review.date) ||
    new Date(`${review.date}T00:00:00Z`).toISOString().slice(0, 10) !== review.date ||
    review.date.slice(0, 4) !== review.session
  )
    fail('valid in-session calendar date is required');
  const bodyPrefix = `fl:${review.chamber}:`;
  if (
    !review.bodySourceKey.startsWith(bodyPrefix) ||
    /(?:^|:)(?:tfc|openstates|unresolved-body)(?:$|:)/i.test(review.bodySourceKey)
  )
    fail('an exact qualified official committee body key is required');
  if (!review.stateCommitteeId.trim() || review.stateCommitteeId.length > 240)
    fail('exact state committee id is required');
  requireEvidenceUrl(review.aliasEvidenceUrl, 'alias');
  requireEvidenceUrl(review.canonicalEvidenceUrl, 'canonical');
  if (!review.reason?.trim() || review.reason.trim().length < 24)
    fail('a substantive reviewed reason is required');
}

export function validateFloridaOpenstatesAliasRows(
  review: FloridaOpenstatesAliasReview,
  alias: FloridaAliasHearingReviewRow,
  canonical: FloridaAliasHearingReviewRow,
  committee: FloridaAliasCommitteeReviewRow,
): void {
  validateFloridaOpenstatesAliasReview(review);
  if (alias.id !== review.aliasId || canonical.id !== review.canonicalId)
    fail('review ids do not match the loaded hearings');
  if (canonical.canonicalHearingId !== null) fail('canonical target is itself an alias');
  if (alias.canonicalHearingId !== null && alias.canonicalHearingId !== canonical.id)
    fail('provisional row already points at a different canonical hearing');
  for (const hearing of [alias, canonical]) {
    if (
      hearing.geographicJurisdiction !== 'FL' ||
      hearing.legislativeSession !== review.session ||
      hearing.chamber !== displayChamber(review.chamber) ||
      isoDay(hearing.date) !== review.date
    )
      fail('hearing geography, session, chamber, or date conflicts with the review');
  }
  if (
    alias.stateCommitteeId !== review.stateCommitteeId ||
    alias.bodySourceKey !== review.bodySourceKey
  )
    fail(
      'provisional hearing has not been qualified to the reviewed committee; run the ledger-continuity OpenStates sync first',
    );
  const canonicalAlreadyQualified =
    canonical.stateCommitteeId === review.stateCommitteeId &&
    canonical.bodySourceKey === review.bodySourceKey;
  const canonicalArchiveBody =
    canonical.stateCommitteeId === null &&
    new RegExp(`^fl:${review.chamber}:tfc:`).test(canonical.bodySourceKey ?? '');
  if (!canonicalAlreadyQualified && !canonicalArchiveBody)
    fail('canonical target is neither the reviewed committee nor a Florida Channel bridge');
  if (
    committee.id !== review.stateCommitteeId ||
    committee.state !== 'FL' ||
    committee.legislativeSession !== review.session ||
    normalizedStateChamber(committee.chamber) !== review.chamber ||
    committee.officialSourceKey !== `FL:${review.session}:${review.bodySourceKey}` ||
    alias.committeeName !== committee.name
  )
    fail('reviewed state committee identity is not exact');
}

export function floridaAliasPlanHash(value: unknown): string {
  return contentHash(value);
}
