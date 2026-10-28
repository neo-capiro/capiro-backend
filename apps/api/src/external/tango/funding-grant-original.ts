import type { FundingCatalogStore } from './funding-catalog.store.js';
import { compact, date, hash, stable, object, text, type RecordData } from './funding-catalog.mapper.js';
import { catalogEmbeddingState } from './funding-embedding-state.js';

const ENDPOINT = 'https://api.grants.gov/v1/api/fetchOpportunity';
/** Exact-ID document fallback for grants absent from Tango's P/F catalog.
 * No search, independent schedule, credentials, or client writes. */
export async function readOriginalGrant(id: string, transport = fetch): Promise<RecordData | null> {
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid grant identifier');
  const response = await transport(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opportunityId: Number(id) }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Original grant document HTTP ${response.status}`);
  const envelope = object(await response.json());
  if (envelope.errorcode !== 0) throw new Error('Original grant document returned an application error');
  const payload = object(envelope.data);
  // The public API also represents a missing opportunity as HTTP 200 with
  // this explicit message and no ID. It is unavailable, never "closed".
  const messages = Array.isArray(payload.errorMessages) ? payload.errorMessages : [payload.errorMessages];
  if (payload.id == null && messages.includes('There is no record found for your search.')) return null;
  if (String(payload.id) !== id) throw new Error('Original grant document identity mismatch');
  return payload;
}

export function originalGrantFields(payload: RecordData): RecordData {
  const block = object(payload.synopsis ?? payload.forecast);
  const number = (v: unknown) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  const labels = (items: unknown, key: string) => Array.isArray(items) ? items.map(x => text(object(x)[key])).filter(Boolean) : [];
  const eligibility = labels(block.applicantTypes, 'description'), cfda = labels(payload.cfdas, 'cfdaNumber');
  const instruments = labels(block.fundingInstruments, 'description');
  const status = ({ POSTED: 'posted', FORECASTED: 'forecasted', CLOSED: 'closed', ARCHIVED: 'archived' } as Record<string,string>)[String(payload.ost).toUpperCase()];
  // Grants.gov can return an exact-ID record with ost=UNDEFINED and no
  // synopsis. Preserve its existing lifecycle while retaining available
  // documents and the raw status; only known explicit states may change it.
  return compact({ status, title: text(payload.opportunityTitle), description: text(block.synopsisDesc ?? block.forecastDesc),
    eligibilityText: text(block.applicantEligibilityDesc), eligibility: eligibility.length ? eligibility : undefined,
    cfdaNumbers: cfda.length ? cfda : undefined, fundingInstrument: instruments.length ? instruments.join('; ') : undefined,
    category: text(object(payload.opportunityCategory).description),
    awardCeiling: number(block.awardCeiling), awardFloor: number(block.awardFloor), estimatedFunding: number(block.estimatedFunding),
    expectedAwards: number(block.numberOfAwards), costSharing: typeof block.costSharing === 'boolean' ? block.costSharing : undefined,
    openDate: date(block.postingDate), closeDate: date(block.responseDate ?? block.estApplicationResponseDate),
    responseDateDesc: text(block.responseDateDesc ?? block.estApplicationResponseDateDesc),
    lastUpdatedAt: date(block.lastUpdatedDate), docType: text(payload.docType), revision: number(payload.revision),
    amendmentCount: Array.isArray(payload.opportunityHistoryDetails) ? payload.opportunityHistoryDetails.length : undefined,
  });
}

export async function storeOriginalGrant(store: FundingCatalogStore, id: string, payload: RecordData, commit: boolean, reason = 'tango_catalog_gap') {
  if (String(payload.id) !== id) throw new Error('Original grant document identity mismatch');
  const fields = originalGrantFields(payload);
  const attachments = originalGrantAttachments(id, payload);
  if (!commit) return;
  const existing = await store.prisma.federalGrant.findUniqueOrThrow({ where: { id } });
  const older = existing.lastUpdatedAt && fields.lastUpdatedAt && fields.lastUpdatedAt < existing.lastUpdatedAt;
  if (older) {
    for (const key of Object.keys(fields)) {
      // The live official ost value is authoritative lifecycle evidence even
      // when the synopsis's content-edit timestamp predates a cached version.
      if (key !== 'status' && (existing as RecordData)[key] != null && (existing as RecordData)[key] !== '') delete fields[key];
    }
  }
  const now = new Date();
  const previousDocument = object(object(existing.raw).grantsGovDocument);
  const previousStatus = String(object(previousDocument.payload).ost ?? '').toLowerCase();
  const lifecycle = fields.status ? { status: fields.status, observedAt: now.toISOString() }
    : previousDocument.lifecycle ?? (['posted','forecasted','closed','archived'].includes(previousStatus)
      ? { status: previousStatus, observedAt: previousDocument.observedAt } : null);
  await store.prisma.federalGrant.update({ where: { id }, data: { ...fields, detailSyncedAt: now, syncedAt: now, ...catalogEmbeddingState(existing, fields, 'grant', now),
    raw: { ...object(existing.raw), grantsGovDocumentGap: null, grantsGovDocument: { payload, lifecycle, observedAt: now.toISOString(), sourceUrl: `https://www.grants.gov/search-results-detail/${id}`, reason } } } });
  for (const attachment of attachments) {
    const previous = await store.prisma.opportunityAttachment.findFirst({ where: { federalGrantId: id, sourceUrl: attachment.sourceUrl } });
    const changed = previous && object(previous.providerData).originalVersion !== attachment.providerData.originalVersion;
    const data = { ...attachment, providerObservedAt: now, embeddedAt: null, ...(changed ? { status: 'metadata_only', contentSha256: null, observedSizeBytes: null,
      observedMimeType: null, archiveBucket: null, archiveKey: null, archiveVersionId: null, archivedAt: null,
      lastAttemptAt: null, failureReason: null, failureDetail: null } : {}) };
    if (previous) await store.prisma.opportunityAttachment.update({ where: { id: previous.id }, data });
    else await store.prisma.opportunityAttachment.create({ data });
  }
}

/** The exact public download path is used by Grants.gov's own detail page.
 * Both folder and file must name this government opportunity ID. */
export function originalGrantAttachments(id: string, payload: RecordData) {
  const attachments = [];
  for (const folder of Array.isArray(payload.synopsisAttachmentFolders) ? payload.synopsisAttachmentFolders : []) {
    if (String(folder.opportunityId) !== id) throw new Error('Grant attachment folder identity mismatch');
    for (const file of Array.isArray(folder.synopsisAttachments) ? folder.synopsisAttachments : []) {
      if (String(file.opportunityId) !== id || !/^\d+$/.test(String(file.id))) throw new Error('Grant attachment identity mismatch');
      attachments.push({ federalGrantId: id, sourceUrl: `https://apply07.grants.gov/grantsws/rest/opportunity/att/download/${file.id}`,
        fileName: text(file.fileName) ?? null, declaredMimeType: text(file.mimeType) ?? null,
        declaredSizeBytes: Number.isSafeInteger(file.fileLobSize) && file.fileLobSize >= 0 ? BigInt(file.fileLobSize) : null,
        postedDate: date(file.lastUpdatedDate ?? file.createdDate),
        providerData: { source: 'grants.gov', originalAttachmentId: String(file.id), grant_id: id,
          folder: { ...folder, synopsisAttachments: undefined }, file, type: 'file', binding: 'government_attachment_id',
          originalVersion: hash(stable(file)), extraction_status: 'not_provided' },
      });
    }
  }
  return attachments;
}
