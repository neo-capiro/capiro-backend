import { createHash } from 'node:crypto';
import { qualifyImport } from '../../src/government-forecasts/forecast-import-command.js';

export const AGENDA_LISTING = 'https://www.reginfo.gov/public/do/eAgendaXmlReport';
const xmlUrl = (edition: string) =>
  `https://www.reginfo.gov/public/do/XMLViewFileAction?f=REGINFO_RIN_DATA_${edition}.xml`;

export class SourceCheckFailure extends Error {}
export interface SourceDependencies {
  fetch: typeof globalThis.fetch;
  now: () => Date;
  retain: (name: string, bytes: Uint8Array) => Promise<void>;
}

/** Only canonical XML links on the publisher's listing can select an edition. */
export function currentAgendaEdition(html: string): string {
  const editions = new Set<string>();
  for (const match of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      const url = new URL((match[2] ?? '').replace(/&amp;/g, '&'), AGENDA_LISTING);
      const edition = /^REGINFO_RIN_DATA_(\d{4}(?:0[1-9]|1[0-2]))\.xml$/.exec(
        url.searchParams.get('f') ?? '',
      )?.[1];
      if (edition && url.href === xmlUrl(edition)) editions.add(edition);
    } catch {
      // Unrelated malformed links cannot select a source or host.
    }
  }
  const latest = [...editions].sort().at(-1);
  if (!latest) throw new SourceCheckFailure('OFFICIAL_EDITION_UNAVAILABLE');
  return latest;
}

async function download(
  url: string,
  limit: number,
  media: 'html' | 'xml',
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
) {
  let response: Response | undefined;
  try {
    response = await fetcher(url, {
      redirect: 'error',
      signal,
      headers: {
        Accept: media === 'xml' ? 'application/xml,text/xml' : 'text/html',
        'Cache-Control': 'no-cache, no-store',
      },
    });
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (
      response.status !== 200 ||
      response.url !== url ||
      !response.body ||
      !(media === 'xml' ? ['application/xml', 'text/xml'] : ['text/html']).includes(type ?? '')
    )
      throw new SourceCheckFailure('OFFICIAL_RESPONSE_INVALID');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
      throw new SourceCheckFailure('OFFICIAL_RESPONSE_TOO_LARGE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new SourceCheckFailure('OFFICIAL_RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    signal.throwIfAborted();
    return {
      bytes: Buffer.concat(chunks),
      headers: {
        date: response.headers.get('date'),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        contentType: type,
      },
    };
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    if (error instanceof SourceCheckFailure) throw error;
    throw new SourceCheckFailure('OFFICIAL_FETCH_FAILED');
  }
}

function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SourceCheckFailure('OFFICIAL_UTF8_INVALID');
  }
}

/** Three finite requests, one 90-second deadline, no retry or caller-selected URL. */
export async function collectOfficialAgenda(deps: SourceDependencies) {
  const signal = AbortSignal.timeout(90000);
  const startedAt = deps.now().toISOString();
  const before = await download(AGENDA_LISTING, 1024 * 1024, 'html', signal, deps.fetch);
  await deps.retain('listing-before.html', before.bytes);
  const edition = currentAgendaEdition(decode(before.bytes));
  const sourceUrl = xmlUrl(edition);
  const source = await download(sourceUrl, 40 * 1024 * 1024, 'xml', signal, deps.fetch);
  const observedAt = deps.now().toISOString();
  await deps.retain('source.xml', source.bytes);
  const after = await download(AGENDA_LISTING, 1024 * 1024, 'html', signal, deps.fetch);
  await deps.retain('listing-after.html', after.bytes);
  if (currentAgendaEdition(decode(after.bytes)) !== edition)
    throw new SourceCheckFailure('OFFICIAL_EDITION_CHANGED');
  const verifiedAt = deps.now().toISOString();
  if (startedAt > observedAt || observedAt > verifiedAt)
    throw new SourceCheckFailure('OBSERVATION_CLOCK_REVERSED');
  const sha256 = createHash('sha256').update(source.bytes).digest('hex');
  let snapshot;
  try {
    snapshot = qualifyImport(decode(source.bytes), { edition, sha256 });
  } catch {
    throw new SourceCheckFailure('OFFICIAL_SNAPSHOT_UNQUALIFIED');
  }
  return {
    sourceUrl,
    listingUrl: AGENDA_LISTING,
    edition,
    sha256,
    observedAt,
    startedAt,
    verifiedAt,
    bytes: source.bytes.length,
    headers: source.headers,
    listingBeforeSha256: createHash('sha256').update(before.bytes).digest('hex'),
    listingAfterSha256: createHash('sha256').update(after.bytes).digest('hex'),
    sourceRunDate: snapshot.sourceRunDate,
    publisherIssuedAt: null,
    candidates: snapshot.candidates.length,
    completedMilestones: snapshot.completedMilestones.length,
    withdrawals: snapshot.withdrawnRins.length,
    rejected: snapshot.rejected.length,
  };
}
