import { load } from 'cheerio';
import {
  houseNoticeObservation,
  senateNoticeObservation,
  type SenateNoticeRef,
} from './adapters/florida-calendar.adapter.js';
import { contentHash } from './hearing-identity.js';

export type FloridaJlbcAliasReview = {
  repairId: string;
  aliasId: string;
  canonicalId: string;
  externalEventId: string;
  officialIdentity: string;
  date: string;
  startsAt: string;
  endsAt: string;
  title: string;
  houseLocation: string;
  senateLocation: string;
  bodySourceKey: string;
  aliasBodySourceKey: string;
  houseMonthlyUrl: string;
  houseNoticeUrl: string;
  senateNoticeUrl: string;
  agenda: readonly string[];
};

const AGENDA = [
  'Consideration of the Long-Range Financial Outlook',
  'Consideration of the following budget amendments:',
  'Agency for Health Care Administration',
  'EOG #B2027-0146',
  'EOG #B2027-0136',
  'EOG #B2027-0095',
  'Fish and Wildlife Conservation Commission',
  'EOG #P2027-0023',
  'Department of Military Affairs',
  'EOG #B2027-0161',
  'Department of Transportation',
  'EOG #W2027-0022',
  'EOG #W2027-0023',
  'EOG #W2027-0021',
  'EOG #W2027-0024',
  'Department of Financial Services',
  'EOG #B2027-0190',
  'Division of Emergency Management',
  'EOG #B2027-0139',
  'EOG #B2027-0104',
  'Department of Commerce',
  'EOG #B2027-0077',
  'Department of State',
  'EOG #B2027-0091',
  'Department of Law Enforcement',
  'EOG #B2027-0131',
  'EOG #B2027-0130',
  'EOG #B2027-0162',
  'Other Business',
] as const;

/**
 * One reviewed cross-provider pair. This is deliberately code-owned rather
 * than an operator-supplied manifest: this verb can never be widened to a
 * second event by changing task environment variables.
 */
export const FLORIDA_JLBC_ALIAS_REVIEW: Readonly<FloridaJlbcAliasReview> = Object.freeze({
  repairId: 'fl-jlbc-openstates-official-2026-09-20',
  aliasId: 'state-fl-77380beb39c1f52d4b6e95765e6530bc',
  canonicalId: 'state-fl-fcc8b09689bcb41294daf87c22afaea3',
  externalEventId: 'ocd-event/a02f8006-d61c-436b-bd3b-e5080dad8f67',
  officialIdentity: 'fl:joint:lbc:notice:6914-15223',
  date: '2026-09-11',
  startsAt: '2026-09-11T15:00:00.000Z',
  endsAt: '2026-09-11T18:00:00.000Z',
  title: 'Joint Legislative Budget Commission',
  houseLocation: '110 SOB',
  senateLocation: 'Toni Jennings Committee Room, 110 Senate Building',
  bodySourceKey: 'fl:joint:lbc',
  aliasBodySourceKey:
    'unresolved-body:openstates:ocd-organization/e779cf08-9f72-4663-a9e0-ad306359310a',
  houseMonthlyUrl:
    'https://www.flhouse.gov/Sections/HouseCalendar/finalizedmeetingnotice.aspx?mode=month',
  houseNoticeUrl: 'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15223',
  senateNoticeUrl: 'https://www.flsenate.gov/Committees/Show/JLBC/MeetingNotice/6914',
  agenda: AGENDA,
});

export type VerifiedFloridaJlbcProof = {
  repairId: string;
  aliasId: string;
  canonicalId: string;
  externalEventId: string;
  officialIdentity: string;
  evidenceUrls: [string, string, string];
  title: string;
  date: string;
  startsAt: string;
  endsAt: string;
  houseLocation: string;
  senateLocation: string;
  agendaHash: string;
  proofHash: string;
};

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

function refuse(reason: string): never {
  throw new Error(`Florida JLBC alias review refused: ${reason}`);
}

/** Reject even a well-formed but different Florida pair. */
export function validateFloridaJlbcAliasReview(review: FloridaJlbcAliasReview): void {
  if (contentHash(review) !== contentHash(FLORIDA_JLBC_ALIAS_REVIEW))
    refuse('the manifest is not the exact code-reviewed JLBC pair');
}

function exactAgenda(actual: readonly string[], review: FloridaJlbcAliasReview, source: string) {
  if (
    actual.length !== review.agenda.length ||
    actual.some((line, index) => clean(line) !== review.agenda[index])
  )
    refuse(`${source} agenda changed`);
}

function orderedAgenda(text: string, review: FloridaJlbcAliasReview, source: string): void {
  let offset = 0;
  for (const line of review.agenda) {
    const next = text.indexOf(line, offset);
    if (next < 0) refuse(`${source} agenda changed at ${line}`);
    offset = next + line.length;
  }
}

function documentUrls(value: { fields: { documents?: Array<{ url: string }> } }): string[] {
  return (value.fields.documents ?? []).map((document) => document.url).sort();
}

function requireOfficialDocuments(
  observation: { fields: { documents?: Array<{ url: string }> } },
  review: FloridaJlbcAliasReview,
  source: string,
): void {
  const expected = [review.houseNoticeUrl, review.senateNoticeUrl].sort();
  const actual = documentUrls(observation);
  if (expected.some((url) => !actual.includes(url)))
    refuse(`${source} does not publish both exact reviewed notice URLs`);
}

export async function verifyFloridaJlbcOfficialProof(
  review: FloridaJlbcAliasReview,
  fetchPage: (url: string) => Promise<Uint8Array>,
  pdfText: (bytes: Uint8Array) => Promise<string>,
): Promise<VerifiedFloridaJlbcProof> {
  validateFloridaJlbcAliasReview(review);
  const [monthlyBytes, houseBytes, senateBytes] = await Promise.all([
    fetchPage(review.houseMonthlyUrl),
    fetchPage(review.houseNoticeUrl),
    fetchPage(review.senateNoticeUrl),
  ]);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const monthlyHtml = decode(monthlyBytes);
  const houseHtml = decode(houseBytes);
  const senateText = (await pdfText(senateBytes)).replace(/\r/g, '');

  const $ = load(monthlyHtml);
  const matchingMonthly = $('.meeting-notice')
    .toArray()
    .filter(
      (element) => clean($(element).find('.committee-title').first().text()) === review.title,
    );
  if (matchingMonthly.length !== 1)
    refuse('live House monthly page must contain exactly one JLBC row');
  const monthly = $(matchingMonthly[0]!);
  const day = clean(monthly.closest('.meeting-day').find('.card-header').first().text());
  const values = new Map<string, string>();
  monthly.find('.details > div').each((_, element) => {
    values.set(
      clean($(element).find('.label').first().text()),
      clean($(element).find('.value').first().text()),
    );
  });
  const monthlyAgenda = monthly
    .find('.meeting-notice-details')
    .first()
    .text()
    .split(/\r?\n+/)
    .map(clean)
    .filter(Boolean);
  if (
    day !== 'Friday, September 11, 2026' ||
    values.get('Meeting Start Time:') !== '09/11/2026 11:00 AM' ||
    values.get('Meeting End Time:') !== '09/11/2026 02:00 PM' ||
    values.get('Location:') !== review.houseLocation
  )
    refuse('live House monthly date, time, or location changed');
  exactAgenda(monthlyAgenda, review, 'live House monthly page');

  const house = houseNoticeObservation(houseHtml, review.houseNoticeUrl, null, null);
  if (
    house.officialIdentity !== review.officialIdentity ||
    house.bodySourceKey !== review.bodySourceKey ||
    house.fields.title !== review.title ||
    house.fields.time?.date !== review.date ||
    house.fields.time?.startsAt !== review.startsAt ||
    house.fields.time?.endsAt !== review.endsAt ||
    house.fields.location !== review.houseLocation
  )
    refuse('exact House notice facts changed');
  exactAgenda(
    (house.fields.agenda ?? []).map((item) => item.title),
    review,
    'exact House notice',
  );
  requireOfficialDocuments(house, review, 'House notice');

  const senateRef: SenateNoticeRef = {
    id: '6914',
    bodyCode: 'JLBC',
    bodyName: review.title,
    date: review.date,
    rawTime: '11:00 a.m.—2:00 p.m.',
    sourceUrl: review.senateNoticeUrl,
    documents: [
      {
        key: review.senateNoticeUrl,
        url: review.senateNoticeUrl,
        title: 'Published meeting notice',
        kind: 'notice',
        publishedAt: null,
      },
    ],
    watchUrl: null,
    canceled: false,
  };
  const senate = senateNoticeObservation(senateRef, senateText, '2027');
  if (
    senate.officialIdentity !== review.officialIdentity ||
    senate.bodySourceKey !== review.bodySourceKey ||
    senate.fields.title !== review.title ||
    senate.fields.time?.date !== review.date ||
    senate.fields.time?.startsAt !== review.startsAt ||
    senate.fields.time?.endsAt !== review.endsAt ||
    senate.fields.location !== review.senateLocation
  )
    refuse('exact Senate notice facts changed');
  requireOfficialDocuments(senate, review, 'Senate notice');
  orderedAgenda(senateText, review, 'exact Senate notice');

  const facts = {
    title: review.title,
    date: review.date,
    startsAt: review.startsAt,
    endsAt: review.endsAt,
    houseLocation: review.houseLocation,
    senateLocation: review.senateLocation,
    agenda: review.agenda,
    evidenceUrls: [review.houseMonthlyUrl, review.houseNoticeUrl, review.senateNoticeUrl],
  };
  return {
    repairId: review.repairId,
    aliasId: review.aliasId,
    canonicalId: review.canonicalId,
    externalEventId: review.externalEventId,
    officialIdentity: review.officialIdentity,
    evidenceUrls: [review.houseMonthlyUrl, review.houseNoticeUrl, review.senateNoticeUrl],
    title: review.title,
    date: review.date,
    startsAt: review.startsAt,
    endsAt: review.endsAt,
    houseLocation: review.houseLocation,
    senateLocation: review.senateLocation,
    agendaHash: contentHash(review.agenda),
    proofHash: contentHash(facts),
  };
}
