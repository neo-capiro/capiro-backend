import { createInterface } from 'node:readline';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { hash, object, type RecordData } from './funding-catalog.mapper.js';
import type { FundingCatalogStore } from './funding-catalog.store.js';
import { catalogEmbeddingState } from './funding-embedding-state.js';

export interface GrantExtractManifest { format: string; sourceUrl: string; extractDate: string; archiveSha256: string }
export function validateGrantExtractManifest(value: unknown): GrantExtractManifest {
  const m = object(value);
  if (m.format !== 'grants-gov-gap-repair-v1' || !/^\d{8}$/.test(m.extractDate) || !/^[a-f0-9]{64}$/.test(m.archiveSha256) ||
      m.sourceUrl !== `https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/GrantsDBExtract${m.extractDate}v2.zip`) throw new Error('Unrecognized official grant extract');
  return m as GrantExtractManifest;
}

/** The extract has no explicit lifecycle. Fill holes only; never close grants,
 * change IDs, create grants, or replace richer Tango/legacy fields. */
export async function fillGrantFromExtract(store: FundingCatalogStore, payload: RecordData, manifest: GrantExtractManifest, commit: boolean) {
  const values = (key: string): string[] => Array.isArray(payload[key]) ? payload[key].filter((v: unknown) => typeof v === 'string' && v.trim()) : [];
  const first = (key: string) => values(key)[0];
  const id = first('OpportunityID');
  if (!id || !/^\d+$/.test(id)) throw new Error('Invalid official grant ID');
  const existing = await store.prisma.federalGrant.findUnique({ where: { id } });
  if (!existing) return 'unmatched';
  const documentHash = hash(JSON.stringify(payload));
  if (object(object(existing.raw).grantsGovExtract).documentHash === documentHash) return 'unchanged';
  const fields: RecordData = {};
  const missing = (key: string) => (existing as RecordData)[key] == null || (existing as RecordData)[key] === '' || (Array.isArray((existing as RecordData)[key]) && !(existing as RecordData)[key].length);
  const put = (key: string, value: unknown) => { if (missing(key) && value !== undefined && value !== '') fields[key] = value; };
  put('description', first('Description'));
  put('eligibilityText', first('AdditionalInformationOnEligibility'));
  put('title', first('OpportunityTitle')); put('agency', first('AgencyName'));
  put('opportunityNumber', first('OpportunityNumber'));
  if (values('CFDANumbers').length) put('cfdaNumbers', values('CFDANumbers'));
  for (const [field, source] of [['awardCeiling','AwardCeiling'],['awardFloor','AwardFloor'],['estimatedFunding','EstimatedTotalProgramFunding'],['expectedAwards','ExpectedNumberOfAwards']]) {
    const raw = first(source!); if (raw !== undefined && Number.isFinite(Number(raw))) put(field!, Number(raw));
  }
  const parseDate = (raw?: string) => {
    if (!raw || !/^\d{8}$/.test(raw)) return undefined;
    const iso = `${raw.slice(4)}-${raw.slice(0,2)}-${raw.slice(2,4)}`;
    const value = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(value.getTime()) && value.toISOString().startsWith(iso) ? value : undefined;
  };
  // A fresh Tango null may deliberately clear an obsolete deadline.
  if (!object(existing.raw).tango) {
    put('openDate', parseDate(first('PostDate'))); put('closeDate', parseDate(first('CloseDate')));
  }
  const sharing = first('CostSharingOrMatchingRequirement');
  if (sharing === 'Yes' || sharing === 'No') put('costSharing', sharing === 'Yes');
  if (!Object.keys(fields).length) return 'unchanged';
  const now = new Date();
  if (commit) await store.prisma.federalGrant.update({ where: { id }, data: { ...fields, syncedAt: now, ...catalogEmbeddingState(existing, fields, 'grant', now),
    raw: { ...object(existing.raw), grantsGovExtract: { ...manifest, documentHash, fieldsAdded: Object.keys(fields), payload } } } });
  return 'enriched';
}

/** Operator-only one-time gap repair, under the same catalog advisory lock. */
export async function importGrantExtract(store: FundingCatalogStore, location: string, commit: boolean, limit: number) {
  const url = new URL(location), bucket = process.env.OPPORTUNITY_ATTACHMENT_BUCKET;
  if (url.protocol !== 's3:' || url.hostname !== bucket || !url.pathname.startsWith('/funding-source-documents/grant-extracts/') || url.search || url.hash) throw new Error('Grant extract must be in the approved private archive prefix');
  const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: url.pathname.slice(1) }));
  if (!response.Body || !(response.Body instanceof Readable)) throw new Error('Grant extract body unavailable');
  const lines = createInterface({ input: response.Body, crlfDelay: Infinity });
  let manifest: GrantExtractManifest | undefined;
  const counts = { enriched: 0, unchanged: 0, unmatched: 0, complete: true };
  try {
    for await (const line of lines) {
      if (!manifest) { manifest = validateGrantExtractManifest(JSON.parse(line)); continue; }
      const outcome = await fillGrantFromExtract(store, JSON.parse(line), manifest, commit);
      counts[outcome]++;
      if (counts.enriched >= limit) { counts.complete = false; break; }
    }
    if (!manifest) throw new Error('Empty grant extract');
  } finally { lines.close(); response.Body.destroy(); client.destroy(); }
  console.log(JSON.stringify({ event: 'GRANT_EXTRACT_GAP_REPAIR', commit, ...counts }));
  return counts;
}
