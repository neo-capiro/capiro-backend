/** Integration rehearsal. Refuses every database except the disposable fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { FundingCatalogStore } from '../src/external/tango/funding-catalog.store.js';
import { embedDocument, readDocument, readPendingDocuments } from './embed-funding-catalog.js';
import { EmbeddingProviderError } from '../src/embeddings/embedding-provider.js';
import { reconcileCatalog, selectReconciliationRows } from '../src/external/tango/funding-catalog.reconcile.js';
import { CatalogQuotaPause, type FundingCatalogClient } from '../src/external/tango/funding-catalog.client.js';
import { TangoError } from '../src/external/tango/tango.errors.js';
import { storeOriginalGrant, originalGrantAttachments } from '../src/external/tango/funding-grant-original.js';
import { fillGrantDocumentGaps } from '../src/external/tango/funding-grant-documents.js';
import { publishLocalFundingText, readNativePdfCandidates, reusableNativeFundingText, CURRENT_FUNDING_ATTACHMENT_SQL, ATTACHMENT_BODY_SQL, ATTACHMENT_TEXT_METADATA_SQL } from '../src/external/tango/funding-document-text.js';
import { discoverAttachmentLinks, realReadOpportunities, realUpsertMetadata, realReadFetchable, realRecordOutcome } from './sync-tango-opportunity-attachments.js';
import { fillGrantFromExtract, validateGrantExtractManifest } from '../src/external/tango/funding-grant-extract.js';
import { samFileUrlAliases } from '../src/external/tango/funding-catalog.mapper.js';

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Loopback disposable database required');
  if (url.pathname !== '/funding_test') throw new Error('Disposable funding_test database required');
  const prisma = new PrismaClient(), store = new FundingCatalogStore(prisma);
  let fixtureTenantId: string | undefined;
  try {
    await prisma.$executeRawUnsafe('TRUNCATE context_embeddings,federal_grant,sam_opportunity,tango_resource_snapshot,tango_resource_link,tango_sync_checkpoint,tango_opportunity_notice,opportunity_attachment,opportunity_document_text CASCADE');
    const grantId = '777123', noticeId = 'e'.repeat(32), localId = '00000000-0000-4000-8000-000000000123';
    await prisma.federalGrant.create({ data: { id: grantId, title: 'Legacy grant', agency: 'Agency', description: 'Existing richer grant description', costSharing: true, raw: { legacy: 'preserve me' } } });
    await prisma.samOpportunity.create({ data: { id: localId, noticeId, title: 'Legacy notice', noticeType: 'Solicitation', pocEmail: 'public@example.gov', raw: { resourceLinks: ['https://sam.gov/test.pdf'] } } });
    const fixtureTenant = await prisma.tenant.create({ data: { slug: `funding-rehearsal-${randomUUID()}`, name: 'Funding preservation fixture' } });
    fixtureTenantId = fixtureTenant.id;
    const fixtureClient = await prisma.client.create({ data: { tenantId: fixtureTenant.id, name: 'Client with saved opportunities' } });
    await prisma.clientFundingOpportunity.createMany({ data: [
      { tenantId: fixtureTenant.id, clientId: fixtureClient.id, source: 'grants_gov', grantOpportunityId: grantId,
        sourceRecordType: 'grants_gov_opportunity', sourceRecordKey: grantId, workflowStatus: 'saved',
        evidenceSourceType: 'user_action', userCreated: true, notes: 'Keep the grant eligibility discussion and client relationship' },
      { tenantId: fixtureTenant.id, clientId: fixtureClient.id, source: 'sam_gov', samOpportunityId: localId,
        sourceRecordType: 'sam_notice', sourceRecordKey: localId, workflowStatus: 'pursuing',
        evidenceSourceType: 'user_action', userCreated: true, notes: 'Keep the contract pursuit notes after amendments and closures' },
    ] });
    const savedClientRecords = await prisma.clientFundingOpportunity.findMany({ where: { tenantId: fixtureTenant.id }, orderBy: { id: 'asc' } });
    const grant = { grant_id: 777123, title: 'Updated grant', agency_code: 'ABC', status: { code: 'P' }, description: null, last_updated: '2026-10-24T00:00:00Z' };
    await store.grant(grant, true); await store.grant(grant, true);
    const savedGrant = await prisma.federalGrant.findUniqueOrThrow({ where: { id: grantId } });
    assert.equal(savedGrant.description, 'Existing richer grant description'); assert.equal(savedGrant.costSharing, true);
    assert.equal((savedGrant.raw as any).legacy, 'preserve me');
    assert.equal(await prisma.tangoResourceSnapshot.count({ where: { resourceType: 'grant' } }), 1);
    await store.grant({ ...grant, title: 'Stale version', last_updated: '2020-01-01T00:00:00Z' }, true);
    assert.equal((await prisma.federalGrant.findUniqueOrThrow({ where: { id: grantId } })).title, 'Updated grant');
    assert.equal((await store.observations.getActiveSnapshot('grant', grantId))?.sourceUpdatedAt?.toISOString(), '2026-10-24T00:00:00.000Z');
    const notice = { notice_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', title: 'Current notice', meta: { notice_type: { type: 'Solicitation' } }, active: false, description: 'Full notice body '.repeat(1000), response_deadline: null, last_updated: '2026-10-24T00:00:00Z', sam_url: `https://sam.gov/opp/${noticeId}/view` };
    assert.equal(await store.notice(notice, true), localId);
    assert.equal(await store.notice(notice, true), localId);
    assert.equal(await prisma.samOpportunity.count(), 1);
    const savedNotice = await prisma.samOpportunity.findUniqueOrThrow({ where: { id: localId } });
    assert.equal(savedNotice.pocEmail, 'public@example.gov'); assert.equal(savedNotice.active, false);
    const opportunity = { opportunity_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', sam_url: notice.sam_url, notice_history: [{ notice_id: noticeId, title: 'History' }], attachments: [{ attachment_id: 'document-1', url: 'https://sam.gov/test.pdf', name: 'Instructions', extracted_text: 'Complete extracted instructions '.repeat(500), extraction_status: 'completed', doc_role: 'instructions' }] };
    await store.opportunity(opportunity, true); await store.opportunity(opportunity, true);
    assert.equal(await prisma.opportunityAttachment.count(), 1);
    const attachment = await prisma.opportunityAttachment.findFirstOrThrow();
    assert.equal(attachment.status, 'metadata_only'); assert.equal(attachment.contentSha256, null);
    assert.equal((attachment.providerData as any).binding, 'provider_attachment_id');
    const selectedAttachment = await readDocument(prisma, 'attachment', attachment.id);
    assert.ok(selectedAttachment!.body.includes('Complete extracted instructions'));
    assert.equal(selectedAttachment!.provider_data.extracted_text, undefined);
    assert.equal(selectedAttachment!.provider_data.doc_role, 'instructions');
    assert.ok((await readDocument(prisma, 'notice', localId))!.body.includes('Full notice body'));
    assert.ok((await readDocument(prisma, 'grant', grantId))!.body.includes('Existing richer grant description'));
    assert.ok((await prisma.tangoOpportunityNotice.findFirstOrThrow()).description === notice.description.trim());
    let calls = 0;
    const invoke = async () => { calls++; return [1, ...Array(1023).fill(0)]; };
    const readAttachment = async () => (await prisma.$queryRawUnsafe<any[]>("SELECT id::text,CASE WHEN length(provider_data->>'extracted_text')>10 THEN concat_ws(E'\\n',file_name,provider_data->>'extracted_text') ELSE '' END AS body,source_url,provider_observed_at AS changed,embedded_content_hash,provider_attachment_id,provider_data,sam_opportunity_id::text,federal_grant_id FROM opportunity_attachment WHERE id=$1::uuid", attachment.id))[0];
    await embedDocument(prisma, 'attachment', await readAttachment(), invoke);
    await store.opportunity(opportunity, true);
    const refreshedAttachment = await prisma.opportunityAttachment.findUniqueOrThrow({ where: { id: attachment.id } });
    assert.ok(refreshedAttachment.embeddedAt! >= refreshedAttachment.providerObservedAt!);
    await prisma.opportunityAttachment.update({ where: { id: attachment.id }, data: { status: 'archived', contentSha256: 'a'.repeat(64), observedSizeBytes: 123n, archiveBucket: 'fixture', archiveKey: 'old-file', archivedAt: new Date() } });
    await store.opportunity({ ...opportunity, attachments: [{ attachment_id: 'document-1', url: 'https://sam.gov/revised.pdf', name: 'Instructions', extraction_status: 'pending' }] }, true);
    const revised = await prisma.opportunityAttachment.findUniqueOrThrow({ where: { id: attachment.id } });
    assert.equal(revised.status, 'metadata_only'); assert.equal(revised.archiveKey, null);
    assert.equal((revised.providerData as any).extracted_text, undefined);
    await embedDocument(prisma, 'attachment', await readAttachment(), invoke);
    assert.equal((await prisma.$queryRawUnsafe<any[]>("SELECT count(*)::int AS n FROM context_embeddings WHERE source_type='funding_attachment_chunk'"))[0].n, 0);
    calls = 0;
    const read = async () => (await prisma.$queryRawUnsafe<any[]>("SELECT id::text,concat_ws(E'\\n',title,agency,description,set_aside,naics_code,psc_code) AS body,source_url,last_synced_at AS changed,embedded_content_hash FROM sam_opportunity WHERE id=$1::uuid", localId))[0];
    await embedDocument(prisma, 'notice', await read(), invoke);
    const initial = calls;
    assert.ok(initial > 1);
    await store.notice(notice, true);
    const refreshedNotice = await prisma.samOpportunity.findUniqueOrThrow({ where: { id: localId } });
    assert.ok(refreshedNotice.embeddedAt! >= refreshedNotice.lastSyncedAt);
    await embedDocument(prisma, 'notice', await read(), invoke); assert.equal(calls, initial);
    // A completed inference can have a timestamp after an ingestor's read.
    // An explicit null invalidation must win even under that clock ordering.
    await prisma.samOpportunity.update({ where: { id: localId }, data: { embeddedAt: new Date('2099-01-01') } });
    await store.notice({ ...notice, description: 'Short updated official notice with a changed deadline' }, true);
    assert.equal((await prisma.samOpportunity.findUniqueOrThrow({ where: { id: localId } })).embeddedAt, null);
    await embedDocument(prisma, 'notice', await read(), invoke);
    const rows = await prisma.$queryRawUnsafe<any[]>('SELECT tenant_id,client_id,metadata_jsonb FROM context_embeddings WHERE source_type=$1', 'funding_notice_chunk');
    assert.equal(rows.length, 1); assert.equal(rows[0].tenant_id, null); assert.equal(rows[0].client_id, null);
    assert.equal(rows[0].metadata_jsonb.parentId, localId);
    const beforeRace = (await read()).embedded_content_hash;
    await prisma.samOpportunity.update({ where: { id: localId }, data: { description: 'New document waiting for a provider retry', lastSyncedAt: new Date() } });
    await assert.rejects(async () => embedDocument(prisma, 'notice', await read(), async () => {
      throw new EmbeddingProviderError('provider_request_failed', 'provider echo must stay private',
        { provider: 'aws-bedrock', model: 'amazon.titan-embed-text-v2:0', modelVersion: 'v2', dimensions: 1024 }, true,
        { name: 'ValidationException', message: 'provider echo must stay private', $metadata: { httpStatusCode: 400 } });
    }), (error: Error) => {
      assert.match(error.message, /cause=ValidationException status=400/);
      assert.ok(!error.message.includes('provider echo'));
      return true;
    });
    assert.equal((await read()).embedded_content_hash, beforeRace);
    assert.deepEqual(await prisma.$queryRawUnsafe<any[]>('SELECT tenant_id,client_id,metadata_jsonb FROM context_embeddings WHERE source_type=$1', 'funding_notice_chunk'), rows);
    await prisma.samOpportunity.update({ where: { id: localId }, data: { description: 'Race candidate content to be superseded', lastSyncedAt: new Date() } });
    await embedDocument(prisma, 'notice', await read(), async () => {
      await prisma.samOpportunity.update({ where: { id: localId }, data: { description: 'A newer amendment arrived during model inference', lastSyncedAt: new Date() } });
      return invoke();
    });
    assert.equal((await read()).embedded_content_hash, beforeRace);
    const nextNoticeId = 'd'.repeat(32);
    const nextLocalId = await store.notice({ ...notice, notice_id: nextNoticeId, sam_url: `https://sam.gov/opp/${nextNoticeId}/view` }, true);
    await store.opportunity({ ...opportunity, latest_notice_id: nextNoticeId, latest_notice: { notice_id: nextNoticeId }, attachments: [{ attachment_id: 'new-amendment-document', url: 'https://sam.gov/amendment.pdf', name: 'Amendment' }] }, true);
    assert.equal((await prisma.opportunityAttachment.findFirstOrThrow({ where: { providerAttachmentId: 'new-amendment-document' } })).samOpportunityId, nextLocalId);
    await assert.rejects(() => store.opportunity({ ...opportunity, latest_notice_id: nextNoticeId, latest_notice: { notice_id: noticeId } }, true), /Conflicting latest notice IDs/);
    const staleIds = ['a'.repeat(32), 'b'.repeat(32)];
    for (const [index, id] of staleIds.entries()) await prisma.samOpportunity.create({ data: {
      noticeId: id, title: 'Legacy active notice', noticeType: 'Solicitation', active: true,
      solicitationNumber: `RECON-${index}`, description: 'Retain this useful description', raw: { retained: true },
    } });
    const historicalNoticeId = 'c'.repeat(32);
    await prisma.samOpportunity.create({ data: { id: '00000000-0000-4000-8000-000000000001', noticeId: historicalNoticeId,
      title: 'Historical record sorts before current records', noticeType: 'Solicitation', active: false,
      solicitationNumber: 'RECON-HIST', description: 'Retain historical detail', raw: { retained: true } } });
    const extraNoticeId = 'f'.repeat(32), unknownNoticeId = '9'.repeat(32);
    await prisma.samOpportunity.create({ data: { noticeId: extraNoticeId, title: 'Additional known history', noticeType: 'Solicitation',
      active: false, solicitationNumber: 'RECON-0', description: 'Retain useful extra detail', raw: { retained: true } } });
    let requestedPages: number[] = [];
    const response = (page: number) => ({ count: 2, next: page === 1 ? 'https://tango.dev/api/notices/?page=2' : null,
      results: [{ ...notice, notice_id: staleIds[page-1], sam_url: `https://sam.gov/opp/${staleIds[page-1]}/view`,
        solicitation_number: `RECON-${page-1}`, active: false, description: null },
        ...(page === 1 ? [extraNoticeId, unknownNoticeId].map(id => ({ ...notice, notice_id: id,
          sam_url: `https://sam.gov/opp/${id}/view`, solicitation_number: 'RECON-0', active: false, description: null })) : [])] });
    const firstClient = { get: async (_resource: string, query: any) => {
      requestedPages.push(query.page); if (query.page === 2) throw new CatalogQuotaPause();
      return response(query.page);
    } } as unknown as FundingCatalogClient;
    const first = await reconcileCatalog(store, firstClient, 'notice', { commit: true, maxBatches: 10, maxRequests: 10 });
    assert.equal(first.complete, false); assert.equal(first.processed, 2);
    assert.equal(await prisma.samOpportunity.count({ where: { noticeId: unknownNoticeId } }), 0);
    const extraNotice = await prisma.samOpportunity.findUniqueOrThrow({ where: { noticeId: extraNoticeId } });
    assert.equal(extraNotice.description, 'Retain useful extra detail');
    assert.equal((extraNotice.raw as any).fundingReconciliation.outcome, 'observed');
    requestedPages = [];
    const resumed = await reconcileCatalog(store, { get: async (_resource: string, query: any) => {
      requestedPages.push(query.page);
      if (query.solicitation_number === 'RECON-HIST') return { count: 1, next: null,
        results: [{ ...notice, notice_id: historicalNoticeId, sam_url: `https://sam.gov/opp/${historicalNoticeId}/view`, solicitation_number: 'RECON-HIST' }] };
      return response(query.page);
    } } as unknown as FundingCatalogClient, 'notice', { commit: true, maxBatches: 10, maxRequests: 10 });
    assert.equal(resumed.complete, true); assert.deepEqual(requestedPages, [2, 1]);
    for (const id of staleIds) {
      const row = await prisma.samOpportunity.findUniqueOrThrow({ where: { noticeId: id } });
      assert.equal(row.active, false); assert.equal(row.description, 'Retain this useful description');
      assert.equal((row.raw as any).retained, true);
    }
    assert.throws(() => selectReconciliationRows({ results: [{ notice_id: staleIds[0], solicitation_number: 'UNREQUESTED' }], next: null },
      [{ id: 'local', key: staleIds[0]!, solicitation: 'RECON-0' }]), /ignored reconciliation filter/);
    // A fresh full notice with no description is a source gap, not a reason
    // to fetch it again. This also applies to a selection saved before refresh.
    const reuseNoticeId = 'a1'.repeat(16), reuseLocalId = '00000000-0000-4000-8000-000000000002';
    await prisma.samOpportunity.create({ data: { id: reuseLocalId, noticeId: reuseNoticeId,
      title: 'Source supplies no description', noticeType: 'Solicitation', active: true } });
    const reusePayload = { ...notice, notice_id: reuseNoticeId, sam_url: `https://sam.gov/opp/${reuseNoticeId}/view`,
      solicitation_number: null, description: null, active: true, response_deadline: null };
    await store.notice(reusePayload, true);
    const noRepeatClient = { get: async () => { throw new Error('Fresh exact-ID notice must not spend quota'); } } as unknown as FundingCatalogClient;
    assert.equal((await reconcileCatalog(store, noRepeatClient, 'notice', { commit: true, maxBatches: 10, maxRequests: 10 })).complete, true);
    const oldObservation = new Date(Date.now() - 4 * 86400_000).toISOString();
    await prisma.$executeRawUnsafe(`UPDATE sam_opportunity SET raw_jsonb=jsonb_set(raw_jsonb,'{tango,observedAt}',to_jsonb($1::text)) WHERE id=$2::uuid`, oldObservation, reuseLocalId);
    let staleRequest = false;
    await reconcileCatalog(store, { get: async (_resource: string, _query: unknown, id: string) => {
      assert.equal(id, reuseNoticeId); staleRequest = true; throw new CatalogQuotaPause();
    } } as unknown as FundingCatalogClient, 'notice', { commit: true, maxBatches: 10, maxRequests: 1 });
    assert.equal(staleRequest, true);
    await store.notice(reusePayload, true);
    const beforeNoticeReuse = await prisma.samOpportunity.findUniqueOrThrow({ where: { id: reuseLocalId } });
    assert.equal((await reconcileCatalog(store, noRepeatClient, 'notice', { commit: true, maxBatches: 10, maxRequests: 10 })).complete, true);
    assert.deepEqual(await prisma.samOpportunity.findUniqueOrThrow({ where: { id: reuseLocalId } }), beforeNoticeReuse);
    // A mismatched embedded government ID cannot satisfy source verification.
    await prisma.$executeRawUnsafe(`UPDATE sam_opportunity SET raw_jsonb=jsonb_set(raw_jsonb,'{tango,payload,notice_id}',to_jsonb($1::text)) WHERE id=$2::uuid`, 'b1'.repeat(16), reuseLocalId);
    let mismatchRequest = false;
    await reconcileCatalog(store, { get: async (_resource: string, _query: unknown, id: string) => {
      assert.equal(id, reuseNoticeId); mismatchRequest = true; return reusePayload;
    } } as unknown as FundingCatalogClient, 'notice', { commit: true, maxBatches: 10, maxRequests: 1 });
    assert.equal(mismatchRequest, true);
    await prisma.federalGrant.create({ data: { id: '12345', title: 'Missing from Tango', agency: 'Agency', status: 'posted', raw: { retained: true } } });
    const beforeMissing = await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } });
    await reconcileCatalog(store, { get: async () => { throw new TangoError('missing', { kind: 'not_found', operation: 'funding', statusCode: 404, detail: 'missing', rate: null }); } } as unknown as FundingCatalogClient,
      'grant', { commit: true, maxBatches: 10, maxRequests: 10, originalGrant: async () => null });
    const missing = await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } });
    assert.equal(missing.status, 'posted'); assert.equal(missing.syncedAt.toISOString(), beforeMissing.syncedAt.toISOString());
    assert.equal((missing.raw as any).fundingReconciliation.outcome, 'not_found_in_either_source');
    assert.equal((missing.raw as any).retained, true);
    await storeOriginalGrant(store, '12345', { id: 12345, ost: 'CLOSED', opportunityTitle: 'Official closure',
      synopsis: { synopsisDesc: 'Official historical description', lastUpdatedDate: '2026-10-24T00:00:00Z', responseDate: '2026-09-01' } }, true);
    const closedGrant = await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } });
    assert.equal(closedGrant.status, 'closed'); assert.equal(closedGrant.description, 'Official historical description');
    assert.equal((closedGrant.raw as any).retained, true);
    assert.equal((closedGrant.raw as any).grantsGovDocument.reason, 'tango_catalog_gap');
    await store.grant({ ...grant, grant_id: 12345 }, true);
    assert.equal((await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } })).status, 'closed');
    await store.grant({ ...grant, grant_id: 12345, last_updated: new Date(Date.now()+60_000).toISOString() }, true);
    assert.equal((await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } })).status, 'posted');
    await storeOriginalGrant(store, '12345', { id: 12345, ost: 'CLOSED' }, true);
    await storeOriginalGrant(store, '12345', { id: 12345, ost: 'UNDEFINED' }, true);
    const undefinedLifecycle = await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } });
    assert.equal(undefinedLifecycle.status, 'closed');
    assert.equal(undefinedLifecycle.description, 'Official historical description');
    assert.equal((undefinedLifecycle.raw as any).grantsGovDocument.payload.ost, 'UNDEFINED');
    await store.grant({ ...grant, grant_id: 12345 }, true);
    assert.equal((await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } })).status, 'closed');
    await assert.rejects(() => storeOriginalGrant(store, '12345', { id: 999, ost: 'CLOSED' }, true), /identity mismatch/);
    const manifest = validateGrantExtractManifest({ format: 'grants-gov-gap-repair-v1', extractDate: '20261023',
      archiveSha256: 'a'.repeat(64), sourceUrl: 'https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/GrantsDBExtract20261023v2.zip' });
    assert.throws(() => validateGrantExtractManifest({ ...manifest, sourceUrl: 'https://untrusted.example/extract.zip' }), /Unrecognized/);
    const extract = { OpportunityID: ['12345'], Description: ['Older XML description'], CloseDate: ['01012024'],
      AdditionalInformationOnEligibility: ['Historical eligibility text'], AwardCeiling: ['10000'] };
    assert.equal(await fillGrantFromExtract(store, extract, manifest, false), 'enriched');
    assert.equal((await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } })).eligibilityText, null);
    assert.equal(await fillGrantFromExtract(store, extract, manifest, true), 'enriched');
    assert.equal(await fillGrantFromExtract(store, extract, manifest, true), 'unchanged');
    const enriched = await prisma.federalGrant.findUniqueOrThrow({ where: { id: '12345' } });
    assert.equal(enriched.status, 'closed'); assert.equal(enriched.description, 'Official historical description');
    assert.equal(enriched.eligibilityText, 'Historical eligibility text');
    assert.equal((enriched.raw as any).retained, true);
    assert.equal((enriched.raw as any).grantsGovExtract.archiveSha256, manifest.archiveSha256);
    assert.equal(await fillGrantFromExtract(store, { ...extract, OpportunityID: ['999999999'] }, manifest, true), 'unmatched');
    assert.equal(await prisma.federalGrant.count({ where: { id: '999999999' } }), 0);
    await prisma.federalGrant.update({ where: { id: grantId }, data: { closeDate: null } });
    await fillGrantFromExtract(store, { ...extract, OpportunityID: [grantId] }, manifest, true);
    assert.equal((await prisma.federalGrant.findUniqueOrThrow({ where: { id: grantId } })).closeDate, null);
    await store.grant({ ...grant, attachments: [] }, true);
    const officialFile = { id: 354791, opportunityId: Number(grantId), fileName: 'Official instructions.pdf', mimeType: 'application/pdf', fileLobSize: 123 };
    const official = { id: Number(grantId), ost: 'POSTED', synopsisAttachmentFolders: [{ id: 12, opportunityId: Number(grantId), synopsisAttachments: [officialFile] }] };
    assert.throws(() => originalGrantAttachments(grantId, { ...official, synopsisAttachmentFolders: [{ opportunityId: 999 }] }), /identity mismatch/);
    const readOriginal = async (id: string) => { assert.equal(id, grantId); return official; };
    assert.equal((await fillGrantDocumentGaps(store, { commit: false, limit: 1, read: readOriginal, delayMs: 0 })).processed, 1);
    assert.equal(await prisma.opportunityAttachment.count({ where: { federalGrantId: grantId } }), 0);
    assert.equal((await fillGrantDocumentGaps(store, { commit: true, limit: 1, read: readOriginal, delayMs: 0 })).complete, false);
    assert.equal((await fillGrantDocumentGaps(store, { commit: true, limit: 1, read: readOriginal, delayMs: 0 })).complete, true);
    await prisma.federalGrant.create({ data: { id: '888123', title: 'Legacy without Tango observation', agency: 'Agency',
      status: 'posted', description: 'Preserve this legacy description', raw: { retained: true } } });
    const legacyOriginal = async (id: string) => { assert.equal(id, '888123'); return { id: 888123, ost: 'CLOSED' }; };
    assert.equal((await fillGrantDocumentGaps(store, { commit: true, limit: 1, read: legacyOriginal, delayMs: 0 })).processed, 1);
    const legacyGap = await prisma.federalGrant.findUniqueOrThrow({ where: { id: '888123' } });
    assert.equal(legacyGap.status, 'closed'); assert.equal(legacyGap.description, 'Preserve this legacy description');
    assert.equal((legacyGap.raw as any).retained, true);
    assert.equal((await fillGrantDocumentGaps(store, { commit: true, limit: 1, read: legacyOriginal, delayMs: 0 })).complete, true);
    const originalOnly = await prisma.federalGrant.create({ data: { id: '888124', title: 'Already checked originally', agency: 'Agency',
      status: 'posted', description: 'Fresh original-source record', raw: {} } });
    // Persist a selection, then let the document pass check that grant before
    // reconciliation resumes. No provider call or fresh date may be invented.
    await reconcileCatalog(store, { get: async () => { throw new CatalogQuotaPause(); } } as unknown as FundingCatalogClient,
      'grant', { commit: true, maxBatches: 10, maxRequests: 1 });
    await storeOriginalGrant(store, originalOnly.id, { id: Number(originalOnly.id), ost: 'POSTED' }, true);
    await prisma.federalGrant.create({ data: { id: '888125', title: 'Recently unavailable original', agency: 'Agency', status: 'posted',
      raw: { grantsGovDocumentGap: { outcome: 'not_found', observedAt: new Date().toISOString() } } } });
    const beforeReuse = await prisma.federalGrant.findUniqueOrThrow({ where: { id: originalOnly.id } });
    const reused = await reconcileCatalog(store, { get: async () => { throw new Error('Fresh original evidence must not spend Tango quota'); } } as unknown as FundingCatalogClient,
      'grant', { commit: true, maxBatches: 10, maxRequests: 10 });
    assert.equal(reused.complete, true);
    assert.deepEqual((await prisma.federalGrant.findUniqueOrThrow({ where: { id: originalOnly.id } })).raw, beforeReuse.raw);
    await prisma.federalGrant.create({ data: { id: '888126', title: 'Stale original evidence', agency: 'Agency', status: 'posted',
      raw: { grantsGovDocument: { observedAt: '2020-01-01T00:00:00.000Z' } } } });
    let staleOriginalCalls = 0;
    const refreshedOriginal = await reconcileCatalog(store, { get: async (_resource: string, _query: unknown, id: string) => {
      staleOriginalCalls++; assert.equal(id, '888126'); return { ...grant, grant_id: Number(id) };
    } } as unknown as FundingCatalogClient, 'grant', { commit: true, maxBatches: 10, maxRequests: 10 });
    assert.equal(refreshedOriginal.complete, true); assert.equal(staleOriginalCalls, 1);
    const grantFile = await prisma.opportunityAttachment.findFirstOrThrow({ where: { federalGrantId: grantId } });
    assert.equal(grantFile.sourceUrl, 'https://apply07.grants.gov/grantsws/rest/opportunity/att/download/354791');
    await storeOriginalGrant(store, grantId, official, true);
    assert.equal(await prisma.opportunityAttachment.count({ where: { federalGrantId: grantId } }), 1);
    await prisma.opportunityAttachment.update({ where: { id: grantFile.id }, data: { status: 'archived', contentSha256: 'c'.repeat(64), archiveBucket: 'fixture', archiveKey: 'file', observedSizeBytes: 123n, archivedAt: new Date() } });
    const binding = { id: grantFile.id, content_sha256: 'c'.repeat(64) };
    // PDF font mappings can emit lone UTF-16 surrogates. Exercise the real
    // Prisma JSON protocol and PostgreSQL publication, not just string helpers.
    assert.equal(await publishLocalFundingText(prisma, binding, { text: 'PDF font \uD800 upper \uDC00 lower \u0000 nul and \u{1F680} valid', truncated: false }), true);
    const repairedNative = await prisma.opportunityDocumentText.findFirstOrThrow({ where: { attachmentId: grantFile.id } });
    assert.equal(repairedNative.text, 'PDF font \uFFFD upper \uFFFD lower \uFFFD nul and \u{1F680} valid');
    assert.equal(repairedNative.truncated, true);
    assert.equal(repairedNative.charCount, repairedNative.text.length);
    assert.equal(await publishLocalFundingText(prisma, binding, { text: 'Full official PDF instructions', truncated: false }), true);
    const readGrantFile = async () => (await prisma.$queryRawUnsafe<any[]>(`SELECT id::text,${ATTACHMENT_BODY_SQL} AS body,source_url,provider_observed_at AS changed,
      embedded_content_hash,provider_attachment_id,provider_data,sam_opportunity_id::text,federal_grant_id,${ATTACHMENT_TEXT_METADATA_SQL} FROM opportunity_attachment WHERE id=$1::uuid`, grantFile.id))[0];
    assert.ok((await readGrantFile()).body.includes('Full official PDF instructions'));
    await embedDocument(prisma, 'attachment', await readGrantFile(), invoke);
    const localVector = (await prisma.$queryRawUnsafe<any[]>('SELECT metadata_jsonb FROM context_embeddings WHERE source_type=$1 AND source_id=$2', 'funding_attachment_chunk', `${grantFile.id}:0`))[0];
    assert.equal(localVector.metadata_jsonb.binding, 'archived_content_sha256');
    assert.equal(localVector.metadata_jsonb.attachmentContentSha256, binding.content_sha256);
    await prisma.opportunityAttachment.update({ where: { id: grantFile.id }, data: { contentSha256: 'd'.repeat(64), providerObservedAt: new Date() } });
    assert.equal((await readGrantFile()).body, '');
    assert.equal(await publishLocalFundingText(prisma, binding, { text: 'Stale old PDF', truncated: false }), false);
    await embedDocument(prisma, 'attachment', await readGrantFile(), invoke);
    assert.equal((await prisma.$queryRawUnsafe<any[]>('SELECT count(*)::int AS n FROM context_embeddings WHERE source_type=$1 AND source_id LIKE $2', 'funding_attachment_chunk', `${grantFile.id}:%`))[0].n, 0);
    await prisma.opportunityAttachment.update({ where: { id: grantFile.id }, data: { providerData: { extracted_text: 'Paid provider text has priority', extraction_status: 'completed' }, providerObservedAt: new Date() } });
    assert.equal((await readGrantFile()).text_method, 'provider');
    assert.ok((await readGrantFile()).body.includes('Paid provider text has priority'));
    const gsaPdf = await prisma.opportunityAttachment.create({ data: {
      samOpportunityId: localId, sourceUrl: 'https://sws.gsa.gov/sws-search/viewSolDocument.do?id=fixture',
      fileName: 'Solicitation.pdf', declaredMimeType: 'Solicitation', status: 'archived', contentSha256: 'f'.repeat(64),
      archiveBucket: 'fixture', archiveKey: 'funding-source-documents/gsa-fixture', observedSizeBytes: 123n,
      observedMimeType: 'application/pdf', archivedAt: new Date(),
    } });
    assert.ok((await readNativePdfCandidates(prisma, 'fixture', 100)).some(row => row.id === gsaPdf.id));
    await prisma.opportunityAttachment.update({ where: { id: gsaPdf.id }, data: { sourceUrl: 'https://sws.gsa.gov/admin' } });
    assert.ok(!(await readNativePdfCandidates(prisma, 'fixture', 100)).some(row => row.id === gsaPdf.id));
    await prisma.opportunityAttachment.update({ where: { id: gsaPdf.id }, data: { sourceUrl: gsaPdf.sourceUrl,
      providerData: { extracted_text: 'Paid GSA instructions take priority' } } });
    assert.ok(!(await readNativePdfCandidates(prisma, 'fixture', 100)).some(row => row.id === gsaPdf.id));
    await prisma.opportunityAttachment.update({ where: { id: gsaPdf.id }, data: { providerData: {} } });
    assert.equal(await publishLocalFundingText(prisma, { id: gsaPdf.id, content_sha256: gsaPdf.contentSha256 },
      { text: 'Recovered official GSA PDF instructions', truncated: false }), true);
    assert.ok((await readDocument(prisma, 'attachment', gsaPdf.id))!.body.includes('Recovered official GSA PDF instructions'));
    assert.ok(!(await readNativePdfCandidates(prisma, 'fixture', 100)).some(row => row.id === gsaPdf.id));
    console.log('PASS GSA PDF fallback: exact reviewed endpoint, paid-text priority, hash-bound publication and no repeated extraction');
    const samPdf = await prisma.opportunityAttachment.create({ data: {
      samOpportunityId: localId, sourceUrl: 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/'+'6'.repeat(32)+'/download',
      providerAttachmentId: 'sam-pdf-gap-fixture', providerData: { extraction_status: 'failed' },
      status: 'archived', contentSha256: 'e'.repeat(64), archiveBucket: 'fixture',
      archiveKey: 'funding-source-documents/sam-gap-fixture', observedSizeBytes: 123n,
      observedMimeType: 'application/pdf', archivedAt: new Date(),
    } });
    const samCandidate = async () => (await readNativePdfCandidates(prisma, 'fixture', 100)).some(row => row.id === samPdf.id);
    for (const status of ['failed','completed','extracting','pending','not_provided']) {
      await prisma.opportunityAttachment.update({ where: { id: samPdf.id }, data: { providerData: { extraction_status: status } } });
      assert.equal(await samCandidate(), ['failed','completed'].includes(status));
    }
    await prisma.opportunityAttachment.update({ where: { id: samPdf.id }, data: { providerAttachmentId: null, providerData: { extraction_status: 'failed' } } });
    assert.equal(await samCandidate(), true);
    for (const status of ['extracting','pending']) {
      await prisma.opportunityAttachment.update({ where: { id: samPdf.id }, data: { providerData: { extraction_status: status } } });
      assert.equal(await samCandidate(), false);
    }
    await prisma.opportunityAttachment.update({ where: { id: samPdf.id }, data: { providerData: {} } });
    assert.equal(await samCandidate(), true);
    await prisma.opportunityAttachment.update({ where: { id: samPdf.id }, data: { providerAttachmentId: 'sam-pdf-gap-fixture',
      providerData: { extraction_status: 'completed', extracted_text: 'Paid SAM text takes priority over local extraction' } } });
    assert.equal(await samCandidate(), false);
    await prisma.opportunityAttachment.update({ where: { id: samPdf.id }, data: { providerData: { extraction_status: 'failed' } } });
    assert.equal(await publishLocalFundingText(prisma, { id: samPdf.id, content_sha256: samPdf.contentSha256 },
      { text: 'Recovered native SAM document instructions', truncated: false }), true);
    assert.ok((await readDocument(prisma, 'attachment', samPdf.id))!.body.includes('Recovered native SAM document instructions'));
    assert.equal(await samCandidate(), false);
    const sharedNative = await reusableNativeFundingText(prisma, samPdf.contentSha256!);
    assert.deepEqual(sharedNative, { text: 'Recovered native SAM document instructions', truncated: false });
    assert.equal(await reusableNativeFundingText(prisma, '0'.repeat(64)), undefined);
    const legacyPdf = await prisma.opportunityAttachment.create({ data: {
      samOpportunityId: localId, sourceUrl: 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/'+'a'.repeat(32)+'/download',
      status: 'archived', contentSha256: samPdf.contentSha256, archiveBucket: 'fixture',
      archiveKey: samPdf.archiveKey, observedSizeBytes: 123n, observedMimeType: 'application/pdf', archivedAt: new Date(),
    } });
    assert.ok((await readNativePdfCandidates(prisma, 'fixture', 100)).some(row => row.id === legacyPdf.id));
    assert.equal(await publishLocalFundingText(prisma, { id: legacyPdf.id, content_sha256: legacyPdf.contentSha256 }, sharedNative!), true);
    assert.ok((await readDocument(prisma, 'attachment', legacyPdf.id))!.body.includes(sharedNative!.text));
    await prisma.opportunityAttachment.update({ where: { id: legacyPdf.id }, data: {
      providerAttachmentId: 'future-tango-link', providerData: { extracted_text: 'Later paid extraction must take priority over reused native text' },
    } });
    assert.ok((await readDocument(prisma, 'attachment', legacyPdf.id))!.body.includes('Later paid extraction'));
    assert.equal(await publishLocalFundingText(prisma, { id: legacyPdf.id, content_sha256: legacyPdf.contentSha256 }, sharedNative!), false);
    console.log('PASS SAM PDF fallback: archived legacy gaps, pending-provider exclusion, exact-byte text reuse, paid-text priority and no repeated extraction');
    await prisma.opportunityAttachment.update({ where: { id: grantFile.id }, data: { status: 'metadata_only',
      archiveBucket: null, archiveKey: null, archiveVersionId: null, archivedAt: null, lastAttemptAt: null } });
    const candidate = (await realReadFetchable(prisma)(100)).find(row => row.id === grantFile.id)!;
    assert.ok(candidate);
    assert.match(candidate.sourceVersion!, /^[a-f0-9]{64}$/);
    assert.equal('providerData' in candidate, false);
    const archived = { status: 'archived' as const, contentSha256: 'd'.repeat(64), observedSizeBytes: 123, observedMimeType: 'application/pdf',
      archiveBucket: 'fixture', archiveKey: 'file', archiveVersionId: null, deduplicated: true };
    assert.equal(await realRecordOutcome(prisma)(grantFile.id, archived, candidate), true);
    await prisma.opportunityAttachment.update({ where: { id: grantFile.id }, data: { providerData: { revision: 2 }, status: 'metadata_only',
      archiveBucket: null, archiveKey: null, archiveVersionId: null, archivedAt: null, contentSha256: null } });
    assert.equal(await realRecordOutcome(prisma)(grantFile.id, archived, candidate), false);
    assert.equal((await prisma.opportunityAttachment.findUniqueOrThrow({ where: { id: grantFile.id } })).archiveKey, null);
    // A newer link-free notice must not hide an older notice behind a cap.
    // Discovery progresses via the stored links, includes history, and never
    // resets provider metadata or a refusal during replay.
    await prisma.samOpportunity.updateMany({ data: { raw: {} } });
    const currentLegacy = await prisma.samOpportunity.create({ data: { noticeId: '1'.repeat(32), title: 'Legacy current', noticeType: 'Solicitation',
      active: true, postedDate: new Date('2020-01-01'), raw: { resourceLinks: [' https://sam.gov/legacy.pdf ', 'https://sam.gov/legacy.pdf', { url: 'https://sam.gov/second.pdf', name: 'Second' }], ignoredBody: 'large unrelated data' } } });
    const historicalLegacy = await prisma.samOpportunity.create({ data: { noticeId: '2'.repeat(32), title: 'Historical', noticeType: 'Solicitation',
      active: false, postedDate: new Date('2025-01-01'), raw: { resourceLinks: ['https://sam.gov/history.pdf'] } } });
    await prisma.samOpportunity.createMany({ data: [
      { noticeId: '3'.repeat(32), title: 'New but link-free', noticeType: 'Solicitation', active: true, postedDate: new Date(), raw: {} },
      { noticeId: '4'.repeat(32), title: 'Malformed links', noticeType: 'Solicitation', active: true, raw: { resourceLinks: 'wrong shape' } },
      { noticeId: '5'.repeat(32), title: 'Unusable links', noticeType: 'Solicitation', active: true, raw: { resourceLinks: [null, ' ', { url: 123 }] } },
    ] });
    const firstLegacy = await realReadOpportunities(prisma)(1);
    assert.deepEqual(firstLegacy.map(row => row.id), [currentLegacy.id]);
    assert.equal((firstLegacy[0]!.raw as any).ignoredBody, undefined);
    const discovered = discoverAttachmentLinks(firstLegacy).links;
    await realUpsertMetadata(prisma)(discovered);
    const retained = await prisma.opportunityAttachment.findFirstOrThrow({ where: { samOpportunityId: currentLegacy.id, sourceUrl: 'https://sam.gov/legacy.pdf' } });
    await prisma.opportunityAttachment.update({ where: { id: retained.id }, data: { status: 'refused', failureReason: 'host_not_allowed',
      providerAttachmentId: 'retained-provider-id', providerData: { extracted_text: 'Paid text must survive legacy replay' } } });
    await realUpsertMetadata(prisma)(discovered);
    assert.equal(await prisma.opportunityAttachment.count({ where: { samOpportunityId: currentLegacy.id } }), 2);
    assert.equal((await prisma.opportunityAttachment.findUniqueOrThrow({ where: { id: retained.id } })).status, 'refused');
    assert.equal((await prisma.opportunityAttachment.findUniqueOrThrow({ where: { id: retained.id } })).providerAttachmentId, 'retained-provider-id');
    assert.deepEqual((await realReadOpportunities(prisma)(1)).map(row => row.id), [historicalLegacy.id]);
    await realUpsertMetadata(prisma)(discoverAttachmentLinks(await realReadOpportunities(prisma)(1)).links);
    assert.equal((await realReadOpportunities(prisma)(1)).length, 0);
    const samFile = `https://sam.gov/api/prod/opps/v3/opportunities/resources/files/${'6'.repeat(32)}/download`;
    await prisma.samOpportunity.update({ where: { id: currentLegacy.id }, data: { raw: { resourceLinks: [samFile, `${samFile}?&token=`] } } });
    await realUpsertMetadata(prisma)(discoverAttachmentLinks(await realReadOpportunities(prisma)(1)).links);
    const legacyFile = await prisma.opportunityAttachment.findFirstOrThrow({ where: { samOpportunityId: currentLegacy.id, sourceUrl: samFile } });
    await prisma.opportunityAttachment.update({ where: { id: legacyFile.id }, data: { status: 'archived', contentSha256: '7'.repeat(64),
      observedSizeBytes: 123n, archiveBucket: 'fixture', archiveKey: 'legacy-file', archivedAt: new Date() } });
    await store.opportunity({ opportunity_id: 'legacy-alias-family', latest_notice_id: '1'.repeat(32), sam_url: `https://sam.gov/opp/${'1'.repeat(32)}/view`,
      attachments: [{ attachment_id: 'adopt-legacy-file', url: `${samFile}?&token=`, extracted_text: 'Paid text for existing legacy file' }] }, true);
    const adoptedLegacy = await prisma.opportunityAttachment.findUniqueOrThrow({ where: { id: legacyFile.id } });
    assert.equal(adoptedLegacy.providerAttachmentId, 'adopt-legacy-file');
    assert.equal(adoptedLegacy.sourceUrl, `${samFile}?&token=`);
    assert.equal(adoptedLegacy.archiveKey, 'legacy-file');
    assert.equal(adoptedLegacy.contentSha256, '7'.repeat(64));
    assert.equal((await realReadOpportunities(prisma)(1)).length, 0);
    await realUpsertMetadata(prisma)([{ samOpportunityId: currentLegacy.id, sourceUrl: samFile, fileName: null, declaredMimeType: null, declaredSizeBytes: null }]);
    assert.equal(await prisma.opportunityAttachment.count({ where: { samOpportunityId: currentLegacy.id } }), 3);
    assert.deepEqual(samFileUrlAliases(`${samFile}?token=nonempty`), [`${samFile}?token=nonempty`]);
    assert.deepEqual(samFileUrlAliases('https://other.example/document?&token='), ['https://other.example/document?&token=']);
    await prisma.samOpportunity.update({ where: { id: currentLegacy.id }, data: { raw: { resourceLinks: ['https://sam.gov/amendment.pdf'] } } });
    assert.deepEqual((await realReadOpportunities(prisma)(1)).map(row => row.id), [currentLegacy.id]);
    // Prefix replacement must not treat ID characters as LIKE wildcards or
    // remove a neighboring document; replay must reuse the exact old vectors.
    const prefixIds = ['prefix_%', 'prefix_AB', 'prefix_%2'];
    for (const id of prefixIds) {
      await prisma.federalGrant.create({ data: { id, title: id, agency: 'Fixture', description: 'Long prefix fixture '.repeat(500) } });
      await embedDocument(prisma, 'grant', (await readDocument(prisma, 'grant', id))!, invoke);
    }
    const prefixVectors = () => prisma.$queryRawUnsafe<Array<{ source_id: string; content_hash: string }>>(
      "SELECT source_id,content_hash FROM context_embeddings WHERE source_type='funding_grant_chunk' AND (source_id ~>=~ 'prefix_') AND (source_id ~<~ 'prefix`') ORDER BY source_id");
    const beforePrefix = await prefixVectors();
    assert.equal(await embedDocument(prisma, 'grant', (await readDocument(prisma, 'grant', prefixIds[0]!))!, invoke), 0);
    assert.deepEqual(await prefixVectors(), beforePrefix);
    await prisma.federalGrant.update({ where: { id: prefixIds[0] }, data: { description: 'Shorter prefix fixture' } });
    await embedDocument(prisma, 'grant', (await readDocument(prisma, 'grant', prefixIds[0]!))!, invoke);
    const afterPrefix = await prefixVectors();
    assert.equal(afterPrefix.filter(row => row.source_id.startsWith('prefix_%:')).length, 1);
    assert.deepEqual(afterPrefix.filter(row => !row.source_id.startsWith('prefix_%:')), beforePrefix.filter(row => !row.source_id.startsWith('prefix_%:')));
    console.log('PASS exact prefix lookup: literal IDs, vector reuse and shorter atomic replacements preserve neighboring documents');
    const unicodeNotice = await prisma.samOpportunity.create({ data: { noticeId: '9'.repeat(32), title: 'Unicode', noticeType: 'Solicitation',
      description: 'a'.repeat(5991) + '\u{1f680}' + 'b'.repeat(6500) } });
    await embedDocument(prisma, 'notice', (await readDocument(prisma, 'notice', unicodeNotice.id))!, invoke);
    const unicodeChunks = await prisma.$queryRawUnsafe<Array<{ content_text: string }>>('SELECT content_text FROM context_embeddings WHERE source_type=$1 AND source_id LIKE $2',
      'funding_notice_chunk', `${unicodeNotice.id}:%`);
    assert.ok(unicodeChunks.some(row => row.content_text.includes('\u{1f680}')));
    assert.ok((await prisma.samOpportunity.findUniqueOrThrow({ where: { id: unicodeNotice.id } })).embeddedAt);
    assert.deepEqual(await prisma.clientFundingOpportunity.findMany({ where: { tenantId: fixtureTenant.id }, orderBy: { id: 'asc' } }), savedClientRecords);
    assert.deepEqual(await prisma.client.findUniqueOrThrow({ where: { id: fixtureClient.id } }), fixtureClient);
    // Historical instructions are deliberately older than current documents.
    // Status AND deadline must win over age, role, and the mere grant FK.
    await prisma.opportunityAttachment.updateMany({ data: { lastAttemptAt: new Date() } });
    const priorityIds: string[] = [], currentIds: string[] = [];
    const priorityParents = { grant: [] as string[], notice: [] as string[] };
    const currentParents = { grant: [] as string[], notice: [] as string[] };
    for (const [index, isGrant, status, deadline, current] of [
      [0, true, 'closed', '2099-01-01', false], [1, true, 'posted', '2000-01-01', false],
      [2, false, false, '2099-01-01', false], [3, false, true, '2000-01-01', false],
      [4, true, 'posted', '2099-01-01', true], [5, true, 'forecasted', null, true],
      [6, false, true, '2099-01-01', true], [7, false, true, null, true],
    ] as const) {
      const parent = isGrant
        ? await prisma.federalGrant.create({ data: { id: `priority-${index}`, title: 'Priority fixture', agency: 'Fixture', status: String(status), closeDate: deadline ? new Date(deadline) : null } })
        : await prisma.samOpportunity.create({ data: { noticeId: `priority-${index}`, title: 'Priority fixture', noticeType: 'Solicitation', active: Boolean(status), responseDeadline: deadline ? new Date(deadline) : null } });
      const file = await prisma.opportunityAttachment.create({ data: {
        ...(isGrant ? { federalGrantId: parent.id } : { samOpportunityId: parent.id }),
        sourceUrl: `https://sam.gov/api/prod/opps/v3/opportunities/resources/files/${String(index).repeat(32)}/download`,
        status: 'metadata_only', firstSeenAt: new Date(current ? '2026-01-01' : '2000-01-01'),
        providerData: { doc_role: current ? 'other' : 'instructions' },
      } });
      const kind = isGrant ? 'grant' : 'notice';
      priorityParents[kind].push(parent.id); if (current) currentParents[kind].push(parent.id);
      if (isGrant) await prisma.federalGrant.update({ where: { id: parent.id }, data: { description: 'Searchable funding fixture description' } });
      else await prisma.samOpportunity.update({ where: { id: parent.id }, data: { description: 'Searchable funding fixture description' } });
      priorityIds.push(file.id); if (current) currentIds.push(file.id);
    }
    assert.deepEqual((await realReadFetchable(prisma)(4)).map(row => row.id).sort(), [...currentIds].sort());
    const classified = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM opportunity_attachment
      WHERE id=ANY($1::uuid[]) AND ${CURRENT_FUNDING_ATTACHMENT_SQL}`, priorityIds);
    assert.deepEqual(classified.map(row => row.id).sort(), [...currentIds].sort());
    await prisma.opportunityAttachment.updateMany({ where: { id: { in: priorityIds } }, data: {
      status: 'archived', archiveBucket: 'priority-fixture', archiveKey: 'funding-source-documents/priority',
      observedMimeType: 'application/pdf', observedSizeBytes: 123n, contentSha256: 'f'.repeat(64), archivedAt: new Date(),
    } });
    assert.deepEqual((await readNativePdfCandidates(prisma, 'priority-fixture', 4)).map(row => row.id).sort(), [...currentIds].sort());
    await prisma.opportunityAttachment.updateMany({ where: { id: { in: priorityIds } }, data: {
      providerData: { extracted_text: 'Searchable attachment fixture text' },
    } });
    for (const kind of ['grant', 'notice'] as const) {
      const selected = (await readPendingDocuments(prisma, kind, 1000)).map(row => row.id).filter(id => priorityParents[kind].includes(id));
      assert.deepEqual(selected.sort(), [...currentParents[kind]].sort());
    }
    assert.deepEqual((await readPendingDocuments(prisma, 'attachment', 1000)).map(row => row.id).filter(id => priorityIds.includes(id)).sort(), [...currentIds].sort());
    console.log('PASS active-only embeddings: closed and expired grants, notices and their attachments are excluded even with unused budget');
    console.log('PASS native Unicode publication: lone surrogates and NUL are replaced, valid pairs survive, partial status and character counts match stored text');
    console.log('PASS current document priority: grants and notices use status plus deadline; current downloads, native extraction and embedding classification precede older historical instructions');
    console.log('PASS saved funding records: IDs, client relationships, notes, workflow status and timestamps survive ingestion, replay, closures and embeddings');
    console.log('PASS PostgreSQL: preserved IDs/data, exact links, stale rejection, idempotency, provider-text provenance, atomic chunks, no-op reuse, shorter amendments, concurrent update protection');
    console.log('PASS reconciliation: page resume, exact notice identity, explicit closure, preserved text, ignored-filter rejection, and no closure inferred from 404');
    console.log('PASS official extract: source manifest, existing IDs only, missing fields only, preserved lifecycle/deadlines, replay and provenance');
    console.log('PASS grant documents: source gap selection/resume, exact file binding, idempotency, native text hash binding, stale-text removal and paid text priority');
    console.log('PASS archive race: a metadata amendment during download cannot publish the old file');
    console.log('PASS lifecycle replay: stale Tango data cannot reopen an official closure; a newer explicit update can');
    console.log('PASS coverage: legacy grants without Tango observations are checked; current notice reconciliation precedes historical records');
    console.log('PASS embedding freshness: unchanged observations do not requeue text; amendments invalidate even with a later embedding timestamp');
    console.log('PASS legacy document discovery: bounded progress, current-first history, malformed input, replay preservation, exact SAM file aliases and new links');
    console.log('PASS Unicode embeddings: a supplementary character at the chunk boundary publishes valid JSONB without dropping text');
    console.log('PASS reconciliation reuse: extra exact local notices are refreshed without creating unknown IDs; fresh original grant evidence survives resume and expires normally');
  } finally {
    try { if (fixtureTenantId) await prisma.tenant.delete({ where: { id: fixtureTenantId } }); }
    finally { await prisma.$disconnect(); }
  }
}
if (/test-tango-funding-postgres\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  if (process.argv.slice(2).includes('--help')) console.log('Usage: test-tango-funding-postgres. Requires a loopback DATABASE_URL named funding_test. Destructive synthetic fixture rehearsal. Exit 0: pass; 1: failure.');
  else void main().catch(error => { console.error(error); process.exitCode = 1; });
}
