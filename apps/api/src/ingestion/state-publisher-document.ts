import { createHash } from 'node:crypto';
import type { LegiscanDocument } from '../external/legiscan/legiscan.client.js';
import { withGuardedWebResponse, readBodyWithSizeLimit } from '../meri/hardenedWebTransport.js';
import { validDocumentIdentity, type StateDocumentStub } from './state-document-stub.js';

// Exact official publisher hosts. Unknown hosts/CDNs remain pending for a
// reviewed addition or the existing provider fallback; suffix matching is forbidden.
const HOSTS: Record<string, string[]> = {
  AL: ['alison.legislature.state.al.us'],
  AK: ['www.akleg.gov', 'www.legis.state.ak.us'],
  AZ: ['www.azleg.gov', 'apps.azleg.gov'],
  AR: ['arkleg.state.ar.us', 'www.arkleg.state.ar.us'],
  CA: ['leginfo.legislature.ca.gov'],
  CO: ['leg.colorado.gov'],
  CT: ['www.cga.ct.gov'],
  DE: ['legis.delaware.gov'],
  DC: ['lims.dccouncil.gov'],
  FL: ['www.flsenate.gov', 'www.flhouse.gov'],
  GA: ['www.legis.ga.gov'],
  HI: ['www.capitol.hawaii.gov'],
  ID: ['legislature.idaho.gov'],
  IL: ['www.ilga.gov', 'ilga.gov'],
  IN: ['iga.in.gov'],
  IA: ['www.legis.iowa.gov'],
  KS: ['kslegislature.gov', 'www.kslegislature.gov'],
  KY: ['apps.legislature.ky.gov'],
  LA: ['www.legis.la.gov'],
  ME: ['legislature.maine.gov'],
  MD: ['mgaleg.maryland.gov'],
  MA: ['malegislature.gov'],
  MI: ['legislature.mi.gov', 'www.legislature.mi.gov'],
  MN: ['www.revisor.mn.gov'],
  MS: ['billstatus.ls.state.ms.us'],
  MO: ['documents.house.mo.gov', 'www.senate.mo.gov', 'senate.mo.gov'],
  MT: ['leg.mt.gov', 'bills.legmt.gov', 'docs.legmt.gov'],
  NE: ['nebraskalegislature.gov'],
  NV: ['www.leg.state.nv.us'],
  NH: ['gc.nh.gov', 'www.gencourt.state.nh.us'],
  NJ: ['pub.njleg.gov', 'www.njleg.state.nj.us'],
  NM: ['www.nmlegis.gov'],
  NY: ['assembly.state.ny.us', 'legislation.nysenate.gov'],
  NC: ['www.ncleg.gov', 'dashboard.ncleg.gov', 'webservices.ncleg.gov'],
  ND: ['ndlegis.gov', 'www.ndlegis.gov'],
  OH: ['search-prod.lis.state.oh.us', 'www.legislature.ohio.gov'],
  OK: ['www.oklegislature.gov', 'www3.oklegislature.gov', 'webserver1.lsb.state.ok.us'],
  OR: ['olis.oregonlegislature.gov'],
  PA: ['www.palegis.us', 'www.legis.state.pa.us'],
  RI: ['webserver.rilegislature.gov'],
  SC: ['www.scstatehouse.gov'],
  SD: ['mylrc.sdlegislature.gov', 'sdlegislature.gov'],
  TN: ['www.capitol.tn.gov', 'publications.tnsosfiles.com'],
  TX: ['capitol.texas.gov'],
  UT: ['le.utah.gov', 'pf.utleg.gov'],
  VT: ['legislature.vermont.gov', 'ljfo.vermont.gov'],
  VA: ['lis.virginia.gov', 'budget.lis.virginia.gov', 'lis.blob.core.windows.net'],
  WA: ['lawfilesext.leg.wa.gov', 'fnspublic.ofm.wa.gov'],
  WV: ['www.wvlegislature.gov'],
  WI: ['docs.legis.wisconsin.gov'],
  WY: ['wyoleg.gov', 'www.wyoleg.gov'],
};

export class PublisherDocumentError extends Error {
  constructor(
    code: string,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
const nextRequest = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();

export function publisherDestination(state: string, url: URL): void {
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !HOSTS[state]?.includes(url.hostname)
  )
    throw new PublisherDocumentError('PUBLISHER_HOST_UNQUALIFIED');
  if (url.hostname === 'lis.blob.core.windows.net' && !/^\/files\/\d+\.pdf$/i.test(url.pathname))
    throw new PublisherDocumentError('PUBLISHER_PATH_UNQUALIFIED');
}

export function publisherRetryDelay(value: string | null, now = Date.now()): number {
  if (!value) return 60_000;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds)
    ? Math.min(86_400_000, Math.max(1000, milliseconds))
    : 60_000;
}

/** Request starts per host are >=1 second apart, without worker sleeps for
 * long Retry-After windows. The durable queue receives the remaining delay. */
async function paced<T>(host: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(host) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const wait = (nextRequest.get(host) ?? 0) - Date.now();
      if (wait > 1000) throw new PublisherDocumentError('PUBLISHER_RETRY_AFTER', wait);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      nextRequest.set(host, Date.now() + 1000);
      return run();
    });
  queues.set(host, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(host) === pending) queues.delete(host);
  }
}

export async function fetchStatePublisherDocument(
  state: string,
  billId: number,
  stub: StateDocumentStub,
): Promise<LegiscanDocument> {
  if (
    !validDocumentIdentity(stub) ||
    !Number.isSafeInteger(billId) ||
    billId < 1 ||
    !Number.isSafeInteger(stub.size) ||
    stub.size! < 1 ||
    stub.size! > 20_000_000 ||
    !['application/pdf', 'text/html', 'text/plain'].includes(stub.mime ?? '') ||
    !stub.stateUrl
  )
    throw new PublisherDocumentError('PUBLISHER_METADATA_UNQUALIFIED');
  const url = new URL(stub.stateUrl);
  // Fragments are never sent by HTTP. Do not misrepresent a latest-page fetch as
  // a fragment-selected historical version; publisher-specific resolution is separate.
  if (url.hash) throw new PublisherDocumentError('PUBLISHER_HISTORICAL_URL_UNQUALIFIED');
  if (url.protocol === 'http:') url.protocol = 'https:';
  publisherDestination(state, url);
  return withGuardedWebResponse(
    url.href,
    async (response, finalUrl, scope) => {
      if (response.status === 429 || response.status === 503) {
        const delay = publisherRetryDelay(response.headers.get('retry-after'));
        nextRequest.set(new URL(finalUrl).hostname, Date.now() + delay);
        throw new PublisherDocumentError('PUBLISHER_RETRY_AFTER', delay);
      }
      if (!response.ok) throw new PublisherDocumentError('PUBLISHER_HTTP_' + response.status);
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (mime !== stub.mime) throw new PublisherDocumentError('PUBLISHER_MIME_MISMATCH');
      const bytes = Buffer.from(await readBodyWithSizeLimit(response, stub.size!, scope));
      if (bytes.length !== stub.size) throw new PublisherDocumentError('DOCUMENT_SIZE_MISMATCH');
      if (createHash('md5').update(bytes).digest('hex') !== stub.providerHash!.toLowerCase())
        throw new PublisherDocumentError('DOCUMENT_PROVIDER_HASH_MISMATCH');
      if (mime === 'application/pdf' && bytes.subarray(0, 5).toString() !== '%PDF-')
        throw new PublisherDocumentError('PUBLISHER_CONTENT_SIGNATURE_MISMATCH');
      return {
        bill_id: billId,
        doc_id: stub.providerId,
        document_kind: stub.kind,
        type: stub.versionType ?? stub.kind,
        title: stub.title ?? undefined,
        mime: stub.mime!,
        date: stub.date,
        state_link: stub.stateUrl!,
        url: stub.url ?? undefined,
        text_size: stub.size!,
        text_hash: stub.providerHash!,
        doc: bytes.toString('base64'),
        acquisition: { source: 'publisher', url: finalUrl },
      };
    },
    {
      deadlineMs: 30000,
      maxRedirects: 4,
      headers: {
        'User-Agent': 'Capiro-Ingestion-Bot/1.0 (+https://capiro.ai)',
        Accept: stub.mime!,
      },
      validateDestination: (destination) => publisherDestination(state, destination),
      beforeRequest: (destination) => paced(destination.hostname, async () => {}),
    },
  );
}
