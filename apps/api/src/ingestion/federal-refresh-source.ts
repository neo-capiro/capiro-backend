import { withGuardedWebResponse, readBodyWithSizeLimit } from '../meri/hardenedWebTransport.js';
import {
  FEDERAL_BILL_TYPES,
  federalDate,
  federalIdentity,
  federalObject,
  type FederalBillType,
} from './federal-billstatus.js';

export function federalArchiveUrl(type: FederalBillType) {
  if (!FEDERAL_BILL_TYPES.includes(type)) throw Error('FEDERAL_REFRESH_TYPE_INVALID');
  return `https://www.govinfo.gov/bulkdata/BILLSTATUS/119/${type}/BILLSTATUS-119-${type}.zip`;
}
/** Fixed public endpoints, public DNS pinning, bounded bodies and every HTTP attempt charged. */
export function federalRefreshTransport(options: {
  beforeAttempt: (url?: URL) => Promise<void>;
  check: () => void;
  remainingMs: () => number;
  transport?: typeof withGuardedWebResponse;
  sleep?: (ms: number) => Promise<void>;
}) {
  const transport = options.transport ?? withGuardedWebResponse;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  async function bytes(input: string, archive: boolean) {
    const target = new URL(input);
    const validate = (url: URL) => {
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        (archive
          ? !FEDERAL_BILL_TYPES.some((type) => url.href === federalArchiveUrl(type))
          : url.origin !== 'https://api.congress.gov' ||
            !/^\/v3\/(?:amendment\/119(?:\/(?:samdt|hamdt)\/[1-9][0-9]*\/text)?|bill\/119\/(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)\/[1-9][0-9]*(?:\/(?:text|subjects|cosponsors))?)$/.test(
              url.pathname,
            ))
      )
        throw Error('FEDERAL_REFRESH_URL_UNQUALIFIED');
      if (!archive && url.pathname !== target.pathname)
        throw Error('FEDERAL_REFRESH_REDIRECT_SCOPE');
    };
    validate(target);
    for (let attempt = 0; attempt < 3; attempt++) {
      options.check();
      const response = await transport(
        input,
        async (response, _url, scope) => {
          if (!response.ok)
            return {
              status: response.status,
              retryAfter: response.headers.get('retry-after'),
              body: null,
            };
          const mime = (response.headers.get('content-type') ?? '')
            .split(';')[0]!
            .trim()
            .toLowerCase();
          if (
            !(
              archive
                ? ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']
                : ['application/json', 'text/json']
            ).includes(mime)
          )
            throw Error('FEDERAL_REFRESH_MIME_MISMATCH');
          return {
            status: response.status,
            retryAfter: null,
            body: Buffer.from(
              await readBodyWithSizeLimit(response, archive ? 120_000_000 : 8_000_000, scope),
            ),
          };
        },
        {
          deadlineMs: Math.min(60000, options.remainingMs()),
          maxRedirects: 2,
          validateDestination: validate,
          beforeRequest: async (url) => {
            options.check();
            await options.beforeAttempt(url);
          },
          headers: { Accept: archive ? 'application/zip' : 'application/json' },
        },
      );
      if (response.body) return response.body;
      if (attempt === 2 || (response.status !== 429 && response.status < 500))
        throw Error(`FEDERAL_REFRESH_HTTP_${response.status}`);
      const seconds = Number(response.retryAfter),
        date = Date.parse(response.retryAfter ?? '');
      const wait =
        Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : Number.isFinite(date)
            ? Math.max(0, date - Date.now())
            : 1000 * 2 ** attempt;
      if (wait >= options.remainingMs()) throw Error('FEDERAL_REFRESH_DEADLINE');
      await sleep(wait);
    }
    throw Error('FEDERAL_REFRESH_FETCH_FAILED');
  }
  return {
    archive: (type: FederalBillType) => bytes(federalArchiveUrl(type), true),
    json: async (url: string) =>
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await bytes(url, false)),
      ) as unknown,
  };
}
export type FederalAmendmentMember = {
  congress: number;
  type: string;
  number: string;
  updateDate: string;
};
/** Raw count/offset proof precedes normalization; unknown, repeated, moved or truncated members fail closed. */
export function parseFederalAmendmentPage(value: unknown, offset: number, expected: number | null) {
  const payload = federalObject(value),
    page = federalObject(payload.pagination);
  if (
    !Array.isArray(payload.amendments) ||
    payload.amendments.length > 250 ||
    !Number.isSafeInteger(page.count) ||
    page.count < 1 ||
    page.count > 100000 ||
    (expected !== null && page.count !== expected)
  )
    throw Error('FEDERAL_REFRESH_AMENDMENT_COUNT_INVALID');
  const members: FederalAmendmentMember[] = payload.amendments.map((raw: unknown) => {
    const entry = federalObject(raw),
      id = federalIdentity(entry, true);
    if (
      !id.startsWith('119-') ||
      typeof entry.updateDate !== 'string' ||
      entry.updateDate.length > 64 ||
      !federalDate(entry.updateDate)
    )
      throw Error('FEDERAL_REFRESH_AMENDMENT_MEMBER_INVALID');
    return {
      congress: 119,
      type: id.split('-')[1]!,
      number: id.split('-')[2]!,
      updateDate: entry.updateDate,
    };
  });
  if (
    new Set(members.map((m) => federalIdentity(m, true))).size !== members.length ||
    offset + members.length > page.count
  )
    throw Error('FEDERAL_REFRESH_AMENDMENT_DUPLICATE');
  const next = page.next ?? null;
  if (next !== null) {
    const url = new URL(next);
    if (
      url.origin !== 'https://api.congress.gov' ||
      url.pathname !== '/v3/amendment/119' ||
      url.username ||
      url.password ||
      url.hash ||
      !members.length ||
      Number(url.searchParams.get('offset')) !== offset + members.length
    )
      throw Error('FEDERAL_REFRESH_AMENDMENT_CONTINUATION_INVALID');
  } else if (offset + members.length !== page.count)
    throw Error('FEDERAL_REFRESH_AMENDMENT_TRUNCATED');
  return { members, count: page.count as number, complete: next === null };
}
