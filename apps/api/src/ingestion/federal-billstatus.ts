import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { eligibleFY26 } from './bill-text-scope.js';

export const FEDERAL_BILL_TYPES = [
  'hr',
  's',
  'hjres',
  'sjres',
  'hconres',
  'sconres',
  'hres',
  'sres',
] as const;
export type FederalBillType = (typeof FEDERAL_BILL_TYPES)[number];
export type FederalTextVersion = {
  versionId: string;
  type: string;
  date: string | null;
  formats: Array<{ type: string; url: string }>;
  packageId: string | null;
  collection: 'BILLS' | 'PLAW' | 'AMENDMENTS';
  versionCode: string | null;
  sourceUrl: string | null;
};
export type FederalAmendmentBinding = {
  id: string;
  billId: string;
  amendedAmendmentId: string | null;
  providerUpdatedAt: string | null;
  textVersionCount: number | null;
};
export type FederalBulkBill = {
  id: string;
  eligible: boolean;
  /** Exact XML proof for unchanged-parent reuse; absent on targeted API metadata. */
  sourceContentHash?: string;
  parent?: {
    title: string | null;
    introducedDate: string | null;
    originChamber: string | null;
    policyArea: string | null;
    sponsorName: string | null;
    sponsorState: string | null;
    sponsorParty: string | null;
    sponsorBioguideId: string | null;
    latestActionText: string | null;
    latestActionDate: string | null;
    actions: Array<{
      date: string | null;
      text: string | null;
      type: string | null;
      chamber: string | null;
    }>;
  };
  providerUpdatedAt: string | null;
  metadataUpdatedAt: string | null;
  subjects: string[];
  cosponsors: Array<{
    bioguideId: string;
    fullName: string;
    party: string | null;
    state: string | null;
    district: number | null;
    sponsorshipDate: string | null;
    withdrawnDate: string | null;
    isOriginal: boolean;
  }>;
  cosponsorEpisodes: FederalBulkBill['cosponsors'];
  versions: FederalTextVersion[];
  amendments: FederalAmendmentBinding[];
};
export type FederalBulkScope = {
  congress: number;
  billType: FederalBillType;
  archiveHash: string;
  expectedBills: number;
};
export const federalHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export const federalObject = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
const list = (v: unknown): unknown[] => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
function string(v: unknown, required = false): string | null {
  if (v == null || v === '') {
    if (required) throw Error('BILLSTATUS_REQUIRED_STRING');
    return null;
  }
  if (
    typeof v !== 'string' ||
    v.length > 10000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
  )
    throw Error('BILLSTATUS_INVALID_STRING');
  return v.trim() || null;
}
export function federalDate(value: string | null): Date | null {
  if (!value) return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value)?.[1];
  const date = new Date(value);
  if (
    !day ||
    !Number.isFinite(date.getTime()) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  )
    return null;
  return date;
}
function optionalDate(v: unknown): string | null {
  const value = string(v);
  if (value && !federalDate(value)) throw Error('BILLSTATUS_INVALID_METADATA_DATE');
  return value;
}
export function federalIdentity(v: unknown, amendment = false): string {
  const obj = federalObject(v),
    congress = Number(obj.congress),
    number = String(obj.number ?? ''),
    type = String(obj.type ?? '').toLowerCase();
  if (
    !Number.isSafeInteger(congress) ||
    congress < 1 ||
    !/^[1-9][0-9]*$/.test(number) ||
    !(amendment ? ['hamdt', 'samdt'] : (FEDERAL_BILL_TYPES as readonly string[])).includes(type)
  )
    throw Error('BILLSTATUS_IDENTITY_INVALID');
  return `${congress}-${type}-${number}`;
}
/** Congress law originals use a public-law directory and the same exact package filename. */
function congressPublicLawPackage(url: URL) {
  if (!['www.congress.gov', 'congress.gov'].includes(url.hostname) || url.search) return null;
  const match =
    /^\/([1-9][0-9]*)\/plaws\/(publ[1-9][0-9]*)\/(PLAW-\1\2)(?:\.(?:htm|pdf|xml)|_uslm\.xml)$/.exec(
      url.pathname,
    );
  return match ? { congress: match[1]!, packageId: match[3]! } : null;
}

/** Only official immutable publication links can enter the retrieval stage. */
export function qualifiedFederalTextUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['www.govinfo.gov', 'govinfo.gov', 'www.congress.gov', 'congress.gov'].includes(
      url.hostname,
    ) ||
    url.hash ||
    (!/^\/(?:content\/pkg\/|crec\/|\d+\/(?:bills|amendments|crec)\/)/.test(url.pathname) &&
      !congressPublicLawPackage(url))
  )
    throw Error('FEDERAL_TEXT_URL_UNQUALIFIED');
  return url;
}
export function normalizeFederalVersions(
  providerDocumentId: string,
  kind: 'text' | 'amendment',
  input: unknown[],
): FederalTextVersion[] {
  const versions = input.map((value) => {
    const raw = federalObject(value),
      type = string(raw.type, true)!,
      date = string(raw.date);
    const formats = list(federalObject(raw.formats).item ?? raw.formats)
      .map((value) => {
        const item = federalObject(value),
          url = string(item.url, true)!;
        const parsed = qualifiedFederalTextUrl(url);
        const extension = /\.(xml|htm|html|pdf|txt)$/i.exec(parsed.pathname)?.[1]?.toLowerCase();
        const declared = string(item.type);
        const format = extension === 'htm' || extension === 'html' ? 'html' : extension;
        if (!format) throw Error('FEDERAL_TEXT_FORMAT_UNSUPPORTED');
        // GovInfo also labels XML "United States Legislative Markup"; the validated
        // publication extension determines the extraction format.
        return { type: format, url };
      })
      .sort((a, b) => a.url.localeCompare(b.url));
    const unique = [...new Map(formats.map((format) => [format.url, format])).values()];
    const preferred = [...unique].sort(
      (a, b) =>
        ['xml', 'html', 'txt', 'pdf'].indexOf(a.type) -
        ['xml', 'html', 'txt', 'pdf'].indexOf(b.type),
    )[0];
    const packageIds = unique
      .map((format) => {
        const url = new URL(format.url),
          law = congressPublicLawPackage(url);
        if (law && (kind !== 'text' || law.congress !== providerDocumentId.split('-')[0]))
          throw Error('FEDERAL_VERSION_PARENT_MISMATCH');
        return /\/content\/pkg\/([^/]+)\//.exec(url.pathname)?.[1] ?? law?.packageId;
      })
      .filter(Boolean) as string[];
    if (new Set(packageIds).size > 1) throw Error('FEDERAL_VERSION_PACKAGE_CONFLICT');
    const versionId = federalHash(JSON.stringify([providerDocumentId, type, date, unique]));
    let packageId: string | null = packageIds[0] ?? null;
    let collection: FederalTextVersion['collection'] =
      kind === 'amendment' ? 'AMENDMENTS' : packageId?.startsWith('PLAW-') ? 'PLAW' : 'BILLS';
    let versionCode: string | null = null;
    if (kind === 'text' && packageId) {
      if (collection === 'BILLS') {
        const match =
          /^BILLS-(\d+)(hr|s|hjres|sjres|hconres|sconres|hres|sres)(\d+)([a-z0-9]+)$/.exec(
            packageId,
          );
        if (!match || `${match[1]}-${match[2]}-${match[3]}` !== providerDocumentId)
          throw Error('FEDERAL_VERSION_PARENT_MISMATCH');
        versionCode = match[4]!;
      } else if (!/^PLAW-\d+publ\d+$/.test(packageId) && !/^PLAW-\d+pvtl\d+$/.test(packageId))
        throw Error('FEDERAL_LAW_PACKAGE_INVALID');
    }
    if (kind === 'amendment')
      packageId = `AMENDMENTS-${providerDocumentId}-${versionId.slice(0, 32)}`;
    // Congress publication paths may omit a GovInfo package; keep a stable source identity.
    if (!packageId && preferred)
      packageId = `BILLS-${providerDocumentId}-${versionId.slice(0, 32)}`;
    return {
      versionId,
      type,
      date,
      formats: unique,
      packageId,
      collection,
      versionCode,
      sourceUrl: preferred?.url ?? null,
    };
  });
  if (new Set(versions.map((v) => v.versionId)).size !== versions.length)
    throw Error('FEDERAL_DUPLICATE_VERSION');
  return versions;
}

export type FederalExactDuplicateProof = {
  rule: 'exact-json-single-page-v1';
  sourceUrl: string;
  offset: 0;
  pageCount: 1;
  pageJson: string;
  pageSha256: string;
};

/** Replay the narrow exception without weakening the canonical version identity guard. */
export function replayFederalExactDuplicates(
  providerDocumentId: string,
  kind: 'text' | 'amendment',
  value: unknown,
) {
  const proof = federalObject(value),
    match = /^(\d+)-([a-z]+)-([1-9][0-9]*)$/.exec(providerDocumentId);
  if (
    !match ||
    !(kind === 'text' ? (FEDERAL_BILL_TYPES as readonly string[]) : ['hamdt', 'samdt']).includes(
      match[2]!,
    ) ||
    Object.keys(proof).some(
      (key) =>
        !['rule', 'sourceUrl', 'offset', 'pageCount', 'pageJson', 'pageSha256'].includes(key),
    ) ||
    proof.rule !== 'exact-json-single-page-v1' ||
    proof.offset !== 0 ||
    proof.pageCount !== 1 ||
    proof.sourceUrl !==
      `https://api.congress.gov/v3/${kind === 'text' ? 'bill' : 'amendment'}/${match[1]}/${match[2]}/${match[3]}/text` ||
    typeof proof.pageJson !== 'string' ||
    proof.pageJson.length > 8_000_000 ||
    federalHash(proof.pageJson) !== proof.pageSha256
  )
    throw Error('FEDERAL_DUPLICATE_PROOF_INVALID');
  const page = federalObject(JSON.parse(proof.pageJson)),
    pagination = federalObject(page.pagination);
  if (
    Object.keys(page).some((key) => !['pagination', 'textVersions'].includes(key)) ||
    !Array.isArray(page.textVersions) ||
    !Number.isSafeInteger(pagination.count) ||
    pagination.count < 2 ||
    pagination.count > 250 ||
    pagination.count !== page.textVersions.length ||
    (pagination.next !== undefined && pagination.next !== null)
  )
    throw Error('FEDERAL_DUPLICATE_PROOF_INVALID');
  const unique = [
    ...new Map(page.textVersions.map((entry: unknown) => [JSON.stringify(entry), entry])).values(),
  ];
  if (unique.length === page.textVersions.length) throw Error('FEDERAL_DUPLICATE_PROOF_INVALID');
  return {
    versions: normalizeFederalVersions(providerDocumentId, kind, unique),
    reportedCount: pagination.count as number,
    enumeratedCount: page.textVersions.length,
    duplicateCount: page.textVersions.length - unique.length,
  };
}

export function normalizeFederalCosponsors(values: unknown[]) {
  const cosponsors = values.map((value) => {
    const c = federalObject(value),
      bioguideId = string(c.bioguideId, true)!;
    if (!/^[A-Z][0-9]{6}$/.test(bioguideId)) throw Error('BILLSTATUS_COSPONSOR_ID_INVALID');
    const district = c.district == null || c.district === '' ? null : Number(c.district);
    if (district !== null && (!Number.isInteger(district) || district < 0 || district > 100))
      throw Error('BILLSTATUS_COSPONSOR_DISTRICT_INVALID');
    const original = String(c.isOriginalCosponsor ?? 'False').toLowerCase();
    if (!['true', 'false', 'y', 'n'].includes(original))
      throw Error('BILLSTATUS_COSPONSOR_ORIGINAL_INVALID');
    return {
      bioguideId,
      fullName: string(c.fullName, true)!,
      party: string(c.party),
      state: string(c.state),
      district,
      sponsorshipDate: optionalDate(c.sponsorshipDate),
      withdrawnDate: optionalDate(c.sponsorshipWithdrawnDate),
      isOriginal: ['true', 'y'].includes(original),
    };
  });
  // The canonical table has one row per member. Preserve every withdrawal/rejoin
  // episode in the immutable receipt/archive and project the latest membership.
  const currentCosponsors = new Map<string, (typeof cosponsors)[number]>();
  for (const cosponsor of cosponsors) {
    const previous = currentCosponsors.get(cosponsor.bioguideId);
    if (
      previous &&
      (!previous.sponsorshipDate ||
        !cosponsor.sponsorshipDate ||
        (previous.sponsorshipDate === cosponsor.sponsorshipDate &&
          JSON.stringify(previous) !== JSON.stringify(cosponsor)))
    )
      throw Error('BILLSTATUS_COSPONSOR_EPISODE_AMBIGUOUS');
    if (!previous || cosponsor.sponsorshipDate! > previous.sponsorshipDate!)
      currentCosponsors.set(cosponsor.bioguideId, cosponsor);
  }
  return { current: [...currentCosponsors.values()], episodes: cosponsors };
}

export function parseFederalBillStatusXml(
  xml: string,
  scope: Pick<FederalBulkScope, 'congress' | 'billType'>,
  filename?: string,
): FederalBulkBill {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw Error('BILLSTATUS_XML_INVALID');
  const parsed = new XMLParser({
    parseTagValue: false,
    trimValues: true,
    ignoreAttributes: true,
  }).parse(xml);
  const bill = federalObject(federalObject(parsed.billStatus).bill),
    id = federalIdentity(bill);
  if (
    !id.startsWith(`${scope.congress}-${scope.billType}-`) ||
    (filename && filename !== `BILLSTATUS-${scope.congress}${scope.billType}${bill.number}.xml`)
  )
    throw Error('BILLSTATUS_ARCHIVE_IDENTITY_MISMATCH');
  const actionDates = list(federalObject(bill.actions).item)
    .map((action) => string(federalObject(action).actionDate))
    .filter(Boolean) as string[];
  const subjects = list(federalObject(federalObject(bill.subjects).legislativeSubjects).item).map(
    (subject) => string(federalObject(subject).name, true)!,
  );
  const normalizedCosponsors = normalizeFederalCosponsors(
    list(federalObject(bill.cosponsors).item),
  );
  const amendments = list(federalObject(bill.amendments).amendment).map((value) => {
    const a = federalObject(value),
      amendmentId = federalIdentity(a, true),
      billId = federalIdentity(a.amendedBill);
    if (billId !== id) throw Error('BILLSTATUS_AMENDMENT_PARENT_MISMATCH');
    const count = federalObject(a.textVersions).count;
    if (count != null && (!/^\d+$/.test(String(count)) || Number(count) > 10000))
      throw Error('BILLSTATUS_AMENDMENT_COUNT_INVALID');
    return {
      id: amendmentId,
      billId,
      amendedAmendmentId: a.amendedAmendment ? federalIdentity(a.amendedAmendment, true) : null,
      providerUpdatedAt: optionalDate(a.updateDate),
      textVersionCount: count == null ? null : Number(count),
    };
  });
  const sponsor = federalObject(list(federalObject(bill.sponsors).item)[0]);
  const latest = federalObject(bill.latestAction);
  return {
    id,
    eligible: eligibleFY26(string(bill.introducedDate), actionDates),
    sourceContentHash: federalHash(xml),
    parent: {
      title: string(bill.title),
      introducedDate: string(bill.introducedDate),
      originChamber: string(bill.originChamber),
      policyArea: string(federalObject(bill.policyArea).name),
      sponsorName: string(sponsor.fullName),
      sponsorState: string(sponsor.state),
      sponsorParty: string(sponsor.party),
      sponsorBioguideId: string(sponsor.bioguideId),
      latestActionText: string(latest.text),
      latestActionDate: optionalDate(latest.actionDate),
      actions: list(federalObject(bill.actions).item).map((value) => {
        const action = federalObject(value);
        return {
          date: string(action.actionDate),
          text: string(action.text) ?? string(action.actionCode) ?? string(action.type),
          type: string(action.type),
          chamber: string(action.chamber),
        };
      }),
    },
    subjects: [...new Set(subjects)].sort(),
    cosponsors: normalizedCosponsors.current,
    cosponsorEpisodes: normalizedCosponsors.episodes,
    providerUpdatedAt: optionalDate(bill.updateDateIncludingText ?? bill.updateDate),
    metadataUpdatedAt: optionalDate(bill.updateDate),
    versions: normalizeFederalVersions(id, 'text', list(federalObject(bill.textVersions).item)),
    amendments,
  };
}

export async function inspectFrozenFederalBillStatus(
  archive: Buffer,
  scope: FederalBulkScope,
  check = () => {},
) {
  if (
    !Number.isInteger(scope.congress) ||
    scope.congress < 1 ||
    !(FEDERAL_BILL_TYPES as readonly string[]).includes(scope.billType) ||
    !Number.isInteger(scope.expectedBills) ||
    scope.expectedBills < 1 ||
    scope.expectedBills > 50000 ||
    !/^[a-f0-9]{64}$/.test(scope.archiveHash) ||
    federalHash(archive) !== scope.archiveHash
  )
    throw Error('BILLSTATUS_SCOPE_OR_HASH_MISMATCH');
  if (archive.length > 120_000_000) throw Error('BILLSTATUS_ARCHIVE_SIZE_LIMIT');
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(archive),
    entries = Object.values(zip.files);
  if (entries.length !== scope.expectedBills) throw Error('BILLSTATUS_ARCHIVE_COUNT_MISMATCH');
  const bills: FederalBulkBill[] = [];
  let expanded = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    check();
    const original =
      (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (entry.dir || original !== entry.name || !/^BILLSTATUS-\d+[a-z]+\d+\.xml$/.test(original))
      throw Error('BILLSTATUS_UNSAFE_ENTRY');
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [],
        stream = entry.nodeStream('nodebuffer') as Readable;
      let size = 0,
        failed = false;
      stream
        .on('data', (chunk: Buffer) => {
          size += chunk.length;
          expanded += chunk.length;
          if (size > 10_000_000 || expanded > 512_000_000) {
            failed = true;
            stream.destroy();
            reject(Error('BILLSTATUS_EXPANSION_LIMIT'));
            return;
          }
          chunks.push(chunk);
        })
        .on('error', reject)
        .on('end', () => {
          if (!failed) resolve(Buffer.concat(chunks));
        });
    });
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    bills.push(parseFederalBillStatusXml(xml, scope, entry.name));
  }
  if (new Set(bills.map((b) => b.id)).size !== bills.length)
    throw Error('BILLSTATUS_DUPLICATE_BILL');
  bills.sort((a, b) => a.id.localeCompare(b.id));
  const amendments = new Map<string, FederalAmendmentBinding>();
  for (const amendment of bills.flatMap((b) => b.amendments)) {
    const previous = amendments.get(amendment.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(amendment))
      throw Error('BILLSTATUS_AMENDMENT_BINDING_CONFLICT');
    amendments.set(amendment.id, amendment);
  }
  return {
    bills,
    eligible: bills.filter((b) => b.eligible),
    manifest: {
      schemaVersion: 1,
      congress: scope.congress,
      billType: scope.billType,
      archiveHash: scope.archiveHash,
      sourceUrl: `https://www.govinfo.gov/bulkdata/BILLSTATUS/${scope.congress}/${scope.billType}/BILLSTATUS-${scope.congress}-${scope.billType}.zip`,
      sourceListComplete: true,
      inspectedBills: bills.length,
      billIds: bills.map((b) => b.id),
      eligibleBillIds: bills.filter((b) => b.eligible).map((b) => b.id),
      amendments: [...amendments.values()].sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}
