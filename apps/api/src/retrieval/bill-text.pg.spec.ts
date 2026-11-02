import { PrismaClient, type Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { structureText } from '../ingestion/bill-document-structure.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';
import { BillTextService } from './bill-text.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { BILL_JURISDICTIONS } from './bill-text-query.js';

// Root supplies a disposable synthetic database. This test never uses DATABASE_URL implicitly.
const url = process.env.BILL_TEXT_SEARCH_TEST_DATABASE_URL;
const pg = url ? describe : describe.skip;
pg('bill text PostgreSQL contract', () => {
  it('searches independent lexical passages, exact retained revisions, vector concepts, and missing-parent coverage', async () => {
    const parsed = new URL(url!);
    if (!/bill[_-]text[_-]test/.test(parsed.pathname))
      throw Error('DEDICATED_BILL_TEXT_TEST_DATABASE_REQUIRED');
    const db = new PrismaClient({ datasources: { db: { url: url! } } });
    try {
      await db.$transaction(
        async (tx) => {
          // Temporary tables shadow canonical names for this connection and disappear at transaction end.
          for (const ddl of [
            `CREATE TEMP TABLE congress_bill(id text,congress int,bill_type text,bill_number text,title text,status text,introduced_date date) ON COMMIT DROP`,
            `CREATE TEMP TABLE congress_bill_action(bill_id text,date date) ON COMMIT DROP`,
            `CREATE TEMP TABLE federal_evidence_revision(id uuid,bill_id text,collection text,version_code text,package_id text,extraction_hash text,content_hash text,source_url text,published_at timestamptz,metadata_jsonb jsonb,raw_content text,fetched_at timestamptz DEFAULT now()) ON COMMIT DROP`,
            `CREATE TEMP TABLE federal_evidence_observation(revision_id uuid,state text,metadata_jsonb jsonb) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill(id text,state text,session_key text,bill_number text,title text,status text,legiscan_progress jsonb,latest_action_date date,legiscan_bill_id int) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill_action(bill_key text,date date,text text) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill_published_record(id uuid,bill_key text,kind text,source_identity text,revision_hash text,event_date text,evidence jsonb,first_observed_at timestamptz) ON COMMIT DROP`,
            `CREATE TEMP TABLE bill_text_extraction(id uuid,source_kind text,revision_id uuid,parser_version text,document_hash text,text_hash text,structure_hash text,extracted_text text,structure_jsonb jsonb,completeness text,warnings_jsonb jsonb,created_at timestamptz) ON COMMIT DROP`,
            `CREATE TEMP TABLE bill_text_passage(extraction_id uuid,chunker_version text,ordinal int,start_offset int,end_offset int,content_text text,metadata_jsonb jsonb DEFAULT '{"semanticAvailable":true}',search_vector tsvector GENERATED ALWAYS AS(to_tsvector('english',content_text)) STORED) ON COMMIT DROP`,
            `CREATE INDEX ON bill_text_passage USING GIN(search_vector)`,
            `CREATE TEMP TABLE context_embeddings(tenant_id uuid,client_id uuid,owner_user_id uuid,source_type text,source_id text,model text,metadata_jsonb jsonb,embedding vector(1024),content_text text,content_hash text) ON COMMIT DROP`,
            `CREATE TEMP TABLE legal_source_receipt(id text,source text,scope jsonb,manifest jsonb,complete boolean,observed_at timestamptz DEFAULT now()) ON COMMIT DROP`,
            `CREATE TEMP TABLE legal_dataset_archive(content_hash text) ON COMMIT DROP`,
          ])
            await tx.$executeRawUnsafe(ddl);
          const ids: Array<{
            billId: string;
            revisionId: string;
            extractionId: string;
            structureHash: string;
          }> = [];
          const boundaryPhrase = 'shelter ' + 'very '.repeat(80) + 'rights';
          const vector = (dimension: number) =>
            Array.from({ length: 1024 }, (_, index) => (index === dimension ? 1 : 0));
          for (const [index, jurisdiction, session, version] of [
            [1, 'FL', '2025', 'Introduced'],
            [2, 'FL', '2025', 'Enrolled'],
            [3, 'TX', '2025', 'Introduced'],
            [4, 'FL', '2026', 'Introduced'],
          ] as const) {
            const billId = `${jurisdiction}-${session}-HB1`,
              revisionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
              extractionId = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
            if (index !== 2)
              await tx.$executeRawUnsafe(
                `INSERT INTO state_bill VALUES($1,$2,$3,'HB1','Housing','introduced','[{"event":1,"date":"2025-10-02"}]','2025-10-02',$4)`,
                billId,
                jurisdiction,
                session,
                index,
              );
            const structure = structureText(
              'SECTION 1. Rights.\nThe right to cost-effective shelter is established for members of the household.\n' +
                'x'.repeat(2850) +
                ' ' +
                boundaryPhrase +
                '\n' +
                'resident '.repeat(800) +
                '\nSECTION 2. Aid.\nHousing assistance pays rent 😀.',
            );
            const structureHash = structure.structureHash;
            await tx.$executeRawUnsafe(
              `INSERT INTO state_bill_published_record VALUES($1::uuid,$2,'document',$3,$4,'2025-10-03',$5::jsonb,now())`,
              revisionId,
              billId,
              `text:${index}`,
              'a'.repeat(64),
              JSON.stringify({
                versionType: version,
                documentKind: 'text',
                providerId: String(index),
                providerHash: String(index),
                contentHash: 'b'.repeat(64),
                contentSnapshotBase64: 'c291cmNl',
                extractionState: 'extracted',
                url: 'https://example.test/document',
              }),
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO bill_text_extraction VALUES($1::uuid,'state',$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,'complete','[]',now())`,
              extractionId,
              revisionId,
              structure.parserVersion,
              'b'.repeat(64),
              structure.textHash,
              structureHash,
              structure.text,
              JSON.stringify(structure),
            );
            let ordinal = 0;
            for (let start = 0; start < structure.text.length; start += 3000) {
              const end = Math.min(start + 3200, structure.text.length);
              expect(structure.text.slice(start, end)).not.toContain(boundaryPhrase);
              await tx.$executeRawUnsafe(
                `INSERT INTO bill_text_passage(extraction_id,chunker_version,ordinal,start_offset,end_offset,content_text) VALUES($1::uuid,$2,$3,$4,$5,$6)`,
                extractionId,
                CHUNKER_VERSION,
                ordinal++,
                start,
                end,
                structure.text.slice(start, end),
              );
            }
            // Only two documents are embedded; lexical search must still return all four.
            if (index <= 2)
              await tx.$executeRawUnsafe(
                `INSERT INTO context_embeddings(tenant_id,source_type,source_id,model,metadata_jsonb,embedding,content_text,content_hash) VALUES(NULL,'state_bill_passage',$1,'test-model',$2::jsonb,$3::vector,$4,$5)`,
                `${CHUNKER_VERSION}:${extractionId}:0`,
                JSON.stringify({
                  billId,
                  revisionId,
                  extractionId,
                  structureHash,
                  textHash: structure.textHash,
                  chunkerVersion: CHUNKER_VERSION,
                  startOffset: 0,
                }),
                JSON.stringify(vector(index - 1)),
                structure.text.slice(0, 3200),
                createHash('sha256').update(structure.text.slice(0, 3200)).digest('hex'),
              );
            ids.push({ billId, revisionId, extractionId, structureHash });
          }
          const provider = {
            metadata: { model: 'test-model', dimensions: 1024 },
            embed: jest.fn().mockResolvedValue(vector(0)),
          } as unknown as EmbeddingProvider;
          const service = new BillTextService(
            {
              withSystem: <T>(callback: (client: Prisma.TransactionClient) => Promise<T>) =>
                callback(tx),
            } as PrismaService,
            provider,
          );
          const exact = await service.search({
            mode: 'exact',
            jurisdictions: ['FL'],
            session: '2025',
            billNumber: 'HB1',
          });
          expect(exact.totalRevisions).toBe(2);
          expect(exact.results.map((r) => r.identity.revisionId)).toEqual(
            expect.arrayContaining(ids.slice(0, 2).map((i) => i.revisionId)),
          );
          const lexical = await service.search({
            mode: 'keyword',
            query: 'rights rent',
            fiscalYear: 2026,
          });
          expect(lexical.totalRevisions).toBe(4); // Lexemes occur in distant passages, before and after vector indexing.
          const phrase = await service.search({
            mode: 'keyword',
            query: '"the right to" "cost-effective"',
          });
          expect(phrase.totalRevisions).toBe(4);
          for (const literal of ['house', 'of the', 'the right to']) {
            expect(
              (await service.search({ mode: 'keyword', query: `"${literal}"` })).totalRevisions,
            ).toBe(4);
          }
          expect(
            (await service.search({ mode: 'keyword', query: `"${boundaryPhrase}"` }))
              .totalRevisions,
          ).toBe(4);
          expect(
            (await service.search({ mode: 'keyword', query: '"cost effective"' })).totalRevisions,
          ).toBe(0);
          expect(
            (await service.search({ mode: 'keyword', query: 'rent', dateBefore: '2025-10-03' }))
              .totalRevisions,
          ).toBe(0);
          const semantic = await service.search({
            mode: 'semantic',
            query: 'help people afford a home',
            jurisdictions: ['FL'],
            session: '2025',
            version: 'Introduced',
          });
          expect(semantic.totalRevisions).toBeNull();
          expect(semantic.candidatePassages).toBe(1);
          expect(semantic.results).toHaveLength(1);
          expect(semantic.results[0]!.identity.revisionId).toBe(ids[0]!.revisionId);
          expect(provider.embed).toHaveBeenCalledWith('help people afford a home');
          const duplicatePassageId = `${CHUNKER_VERSION}:${ids[0]!.extractionId}:1`;
          await tx.$executeRawUnsafe(
            `INSERT INTO context_embeddings SELECT NULL,NULL,NULL,e.source_type,$1,e.model,e.metadata_jsonb,
              e.embedding,p.content_text,encode(sha256(convert_to(p.content_text,'UTF8')),'hex')
              FROM context_embeddings e JOIN bill_text_passage p ON p.extraction_id=$2::uuid AND p.ordinal=1
              WHERE e.source_id=$3`,
            duplicatePassageId,
            ids[0]!.extractionId,
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
          );
          const deduplicated = await service.search({
            mode: 'semantic',
            query: 'housing',
            billId: ids[0]!.billId,
            version: 'Introduced',
          });
          expect(deduplicated.results).toHaveLength(1);
          expect(deduplicated.candidatePassages).toBe(2);
          await tx.$executeRawUnsafe(
            `DELETE FROM context_embeddings WHERE source_id=$1`,
            duplicatePassageId,
          );
          const { structureHash: _hash, ...readIdentity } = ids[0]!;
          const old = await service.read({
            ...readIdentity,
            jurisdiction: 'FL',
            session: '2025',
            section: '2',
          });
          expect(old.available).toBe(true);
          if (old.available) expect(old.text).toContain('rent 😀');
          await expect(
            service.read({ ...readIdentity, jurisdiction: 'TX', session: '2025' }),
          ).rejects.toThrow('BILL_REVISION_NOT_FOUND');
          for (const [invalidDate, dateFrom, dateBefore] of [
            ['2025-10-99', '2025-10-01', '2025-11-01'],
            ['2026-02-30', '2026-02-01', '2026-03-01'],
            ['2026-04-31', '2026-04-01', '2026-05-01'],
          ]) {
            await tx.$executeRawUnsafe(
              `UPDATE state_bill SET legiscan_progress=$2::jsonb,latest_action_date='2026-06-01' WHERE id=$1`,
              ids[0]!.billId,
              JSON.stringify([
                { event: 1, date: invalidDate },
                { event: 2, date: '2026-06-01' },
              ]),
            );
            for (const dateBasis of ['introduced', 'action'] as const) {
              expect(
                (
                  await service.search({
                    mode: 'keyword',
                    query: 'rent',
                    billId: ids[0]!.billId,
                    fiscalYear: 2026,
                    dateBasis,
                    dateFrom,
                    dateBefore,
                  })
                ).totalRevisions,
              ).toBe(0);
            }
            expect(
              (
                await service.search({
                  mode: 'keyword',
                  query: 'rent',
                  billId: ids[0]!.billId,
                  fiscalYear: 2026,
                  dateBasis: 'action',
                  dateFrom: '2026-06-01',
                  dateBefore: '2026-06-02',
                })
              ).totalRevisions,
            ).toBe(2);
          }
          await tx.$executeRawUnsafe(
            `INSERT INTO state_bill_published_record VALUES('00000000-0000-4000-8000-000000000099',$1,'action','invalid-date','invalid','2026-02-30','{}',now())`,
            ids[0]!.billId,
          );
          expect(
            (
              await service.search({
                mode: 'keyword',
                query: 'rent',
                billId: ids[0]!.billId,
                dateBasis: 'action',
                dateFrom: '2026-02-01',
                dateBefore: '2026-03-01',
              })
            ).totalRevisions,
          ).toBe(0);
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_dataset_archive VALUES($1)`,
            'c'.repeat(64),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('synthetic','fy26-state-frozen-inventory',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({
              fiscalYear: 2026,
              jurisdiction: 'FL',
              sessionKey: '2025',
              providerSessionId: 1,
              archiveHash: 'c'.repeat(64),
            }),
            JSON.stringify({
              sourceListComplete: true,
              schemaVersion: 1,
              state: 'FL',
              sessionId: 1,
              archiveHash: 'c'.repeat(64),
              inspectedBills: 2,
              eligibleBills: 2,
              bills: [
                {
                  billKey: ids[0]!.billId,
                  providerBillId: 1,
                  documents: [
                    { kind: 'text', providerId: 1, providerHash: '1', versionType: 'Introduced' },
                  ],
                },
                {
                  billKey: 'FL-2025-HB2',
                  providerBillId: 99,
                  documents: [
                    { kind: 'text', providerId: 99, providerHash: '99', versionType: 'Introduced' },
                  ],
                },
              ],
            }),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_dataset_archive VALUES($1)`,
            'd'.repeat(64),
          );
          const discoveryStates = BILL_JURISDICTIONS.filter((state) => state !== 'US').map(
            (state) => ({
              state,
              status: 'complete',
              sessions:
                state === 'FL'
                  ? [
                      { sessionId: 1, archiveHash: 'c'.repeat(64), expectedBills: 2 },
                      { sessionId: 2, archiveHash: 'e'.repeat(64), expectedBills: 0 },
                    ]
                  : [],
            }),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('discovery','fy26-state-discovery',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({ fiscalYear: 2026, manifestSha256: 'd'.repeat(64) }),
            JSON.stringify({
              schemaVersion: 1,
              fiscalYear: 2026,
              manifestSha256: 'd'.repeat(64),
              states: discoveryStates,
            }),
          );
          const coverage = await service.coverage();
          const fl = coverage.jurisdictions.find((row) => row.jurisdiction === 'FL')!;
          expect(fl.versions[0]).toMatchObject({
            expectedBills: 2,
            metadataBills: 1,
            expectedDocuments: 2,
            downloadedDocuments: 1,
            publisherUrlMissingDocuments: 2,
            sourceUnavailableDocuments: 0,
            embeddedPassages: 1,
            missingParents: 1,
          });
          // Public source family alone is insufficient: every scope and immutable input anchor is checked.
          const rejectTamperedVector = async (
            sourceId: string,
            billId: string,
            jurisdiction: string,
          ) => {
            const [saved] = await tx.$queryRawUnsafe<
              Array<{ content_text: string; content_hash: string; metadata_jsonb: unknown }>
            >(
              `SELECT content_text,content_hash,metadata_jsonb FROM context_embeddings WHERE source_id=$1`,
              sourceId,
            );
            for (const mutation of [
              "tenant_id='00000000-0000-4000-8000-000000009999'",
              "client_id='00000000-0000-4000-8000-000000009999'",
              "owner_user_id='00000000-0000-4000-8000-000000009999'",
              "content_text=content_text||' changed'",
              "content_hash=repeat('f',64)",
              "metadata_jsonb=metadata_jsonb-'revisionId'",
              "metadata_jsonb=metadata_jsonb-'billId'",
              "metadata_jsonb=metadata_jsonb-'chunkerVersion'",
            ]) {
              await tx.$executeRawUnsafe(
                `UPDATE context_embeddings SET ${mutation} WHERE source_id=$1`,
                sourceId,
              );
              expect(
                (
                  await service.search({
                    mode: 'semantic',
                    query: 'housing',
                    billId,
                    version: jurisdiction === 'US' ? 'ih' : 'Introduced',
                  })
                ).results,
              ).toHaveLength(0);
              expect(
                (await service.coverage()).jurisdictions.find(
                  (row) => row.jurisdiction === jurisdiction,
                )!.embeddedPassages,
              ).toBe(0);
              await tx.$executeRawUnsafe(
                `UPDATE context_embeddings SET tenant_id=NULL,client_id=NULL,owner_user_id=NULL,
                content_text=$2,content_hash=$3,metadata_jsonb=$4::jsonb WHERE source_id=$1`,
                sourceId,
                saved!.content_text,
                saved!.content_hash,
                JSON.stringify(saved!.metadata_jsonb),
              );
            }
          };
          await rejectTamperedVector(
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
            ids[0]!.billId,
            'FL',
          );
          expect(fl.status).toBe('unknown');
          expect(fl.missingSessions).toEqual(['2']);
          expect(coverage.jurisdictions.find((row) => row.jurisdiction === 'AK')).toMatchObject({
            status: 'complete_for_frozen_inventory',
            completionPercent: 100,
          });
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_dataset_archive VALUES($1)`,
            'e'.repeat(64),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('empty-session','fy26-state-frozen-inventory',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({
              fiscalYear: 2026,
              jurisdiction: 'FL',
              providerSessionId: 2,
              sessionKey: '2026',
              archiveHash: 'e'.repeat(64),
            }),
            JSON.stringify({
              schemaVersion: 1,
              state: 'FL',
              sessionId: 2,
              sessionKey: '2026',
              archiveHash: 'e'.repeat(64),
              sourceListComplete: true,
              inspectedBills: 0,
              eligibleBills: 0,
              bills: [],
            }),
          );
          const qualified = await service.coverage();
          expect(qualified.jurisdictions.find((row) => row.jurisdiction === 'FL')).toMatchObject({
            status: 'partial',
            expectedDocuments: 2,
            missingSessions: [],
          });
          // An unlisted later archive must not change the frozen denominator.
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) SELECT 'unlisted-later',source,jsonb_set(scope,'{archiveHash}','"unlisted"'),manifest,false FROM legal_source_receipt WHERE id='synthetic'`,
          );
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'FL')!
              .expectedDocuments,
          ).toBe(2);
          const providerVersions = ['ih', 'enr'].map((versionCode, index) => ({
            versionId: String(index + 1).repeat(64),
            type: versionCode,
            date: '2025-10-02',
            formats: [{ type: 'xml', url: `https://example.test/federal-${versionCode}.xml` }],
            packageId: `BILLS-119hr1${versionCode}`,
            collection: 'BILLS',
            versionCode,
            sourceUrl: `https://example.test/federal-${versionCode}.xml`,
          }));
          const federalInventory = {
            schemaVersion: 1,
            kind: 'text',
            providerDocumentId: '119-hr-1',
            versions: [
              ...providerVersions,
              {
                versionId: '3'.repeat(64),
                type: 'Public law',
                date: '2025-10-02',
                formats: [],
                packageId: null,
                collection: 'PLAW',
                versionCode: null,
                sourceUrl: null,
              },
            ],
            reportedCount: 3,
            enumeratedCount: 3,
            providerUpdatedAt: '2026-06-01T00:00:00Z',
          };
          for (const billId of ['119-hr-1', '119-hr-2'])
            await tx.$executeRawUnsafe(
              `INSERT INTO congress_bill VALUES($1,119,'hr',$2,'Synthetic federal bill','introduced','2025-10-02')`,
              billId,
              billId.endsWith('-1') ? '1' : '2',
            );
          for (const [id, billId, manifest] of [
            ['federal-text', '119-hr-1', federalInventory],
            [
              'federal-empty',
              '119-hr-2',
              {
                ...federalInventory,
                providerDocumentId: '119-hr-2',
                versions: [],
                reportedCount: 0,
                enumeratedCount: 0,
              },
            ],
          ] as const)
            await tx.$executeRawUnsafe(
              `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES($1,'fy26-federal-provider-inventory',$2::jsonb,$3::jsonb,true)`,
              id,
              JSON.stringify({ fiscalYear: 2026, congress: 119, billId }),
              JSON.stringify(manifest),
            );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('federal-discovery','fy26-federal-discovery',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({ fiscalYear: 2026, congress: 119 }),
            JSON.stringify({
              schemaVersion: 1,
              billIds: ['119-hr-1', '119-hr-2'],
              requiredInventoryReceiptIds: ['federal-text', 'federal-empty', 'federal-amendment'],
              sourceListComplete: true,
              amendmentEnumerationComplete: true,
              amendmentParentsResolved: true,
              unresolvedAmendments: 0,
              excludedTreatyAmendments: 0,
              excludedNonFYAmendments: 0,
            }),
          );
          const bytesHash = createHash('sha256').update('source').digest('hex');
          for (const suffix of ['100', '101']) {
            const revisionId = `00000000-0000-4000-8000-000000000${suffix}`;
            await tx.$executeRawUnsafe(
              `INSERT INTO federal_evidence_revision(id,bill_id,collection,version_code,package_id,extraction_hash,content_hash,source_url,published_at,metadata_jsonb,raw_content) VALUES($1::uuid,'119-hr-1','BILLS','ih','BILLS-119hr1ih',$2,$3,'https://example.test/federal-ih.xml','2025-10-02','{}','source')`,
              revisionId,
              suffix.repeat(22).slice(0, 64),
              bytesHash,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO federal_evidence_observation VALUES($1::uuid,'present',$2::jsonb)`,
              revisionId,
              JSON.stringify({
                providerDocumentId: '119-hr-1',
                providerVersionId: providerVersions[0]!.versionId,
                sourceInventoryReceiptId: 'federal-text',
              }),
            );
          }
          const missingAmendmentInventory = await service.coverage();
          expect(
            missingAmendmentInventory.jurisdictions.find((row) => row.jurisdiction === 'US'),
          ).toMatchObject({
            inventoryStatus: 'unknown',
            expectedDocuments: 3,
            sourceUnavailableDocuments: 1,
            downloadedDocuments: 0,
          });
          expect(missingAmendmentInventory.federalDiscovery!.missingReceiptIds).toEqual([
            'federal-amendment',
          ]);
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES('federal-amendment','fy26-federal-provider-inventory',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({ fiscalYear: 2026, congress: 119, billId: '119-hr-1' }),
            JSON.stringify({
              ...federalInventory,
              kind: 'amendment',
              providerDocumentId: '119-hamdt-1',
              versions: [],
              reportedCount: 0,
              enumeratedCount: 0,
            }),
          );
          await tx.$executeRawUnsafe(
            `UPDATE federal_evidence_revision SET metadata_jsonb=$1::jsonb WHERE id='00000000-0000-4000-8000-000000000101'`,
            JSON.stringify({
              originalBytesBase64: Buffer.from('source').toString('base64'),
              rawBytesHash: bytesHash,
            }),
          );
          const federalExtractionId = '00000000-0000-4000-8000-000000000201';
          const federalRevisionId = '00000000-0000-4000-8000-000000000101';
          await tx.$executeRawUnsafe(
            `INSERT INTO bill_text_extraction SELECT $1::uuid,'federal',$2::uuid,parser_version,
            document_hash,text_hash,structure_hash,extracted_text,structure_jsonb,completeness,warnings_jsonb,created_at
            FROM bill_text_extraction WHERE id=$3::uuid`,
            federalExtractionId,
            federalRevisionId,
            ids[0]!.extractionId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO bill_text_passage(extraction_id,chunker_version,ordinal,start_offset,end_offset,content_text,metadata_jsonb)
            SELECT $1::uuid,chunker_version,ordinal,start_offset,end_offset,content_text,metadata_jsonb
            FROM bill_text_passage WHERE extraction_id=$2::uuid`,
            federalExtractionId,
            ids[0]!.extractionId,
          );
          const federalPassageId = `${CHUNKER_VERSION}:${federalExtractionId}:0`;
          await tx.$executeRawUnsafe(
            `INSERT INTO context_embeddings SELECT NULL,NULL,NULL,'bill_passage',$1,model,
            metadata_jsonb||jsonb_build_object('billId','119-hr-1','extractionId',$2::text,'revisionId',$3::text),embedding,content_text,content_hash
            FROM context_embeddings WHERE source_id=$4`,
            federalPassageId,
            federalExtractionId,
            federalRevisionId,
            `${CHUNKER_VERSION}:${ids[0]!.extractionId}:0`,
          );
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'US')!
              .embeddedPassages,
          ).toBe(1);
          await rejectTamperedVector(federalPassageId, '119-hr-1', 'US');
          const federal = (await service.coverage()).jurisdictions.find(
            (row) => row.jurisdiction === 'US',
          )!;
          expect(federal).toMatchObject({
            inventoryStatus: 'frozen_discovery_inventory',
            status: 'partial',
            expectedDocuments: 3,
            sourceUnavailableDocuments: 1,
            downloadedDocuments: 1,
          });
          expect(federal.versions.find((row) => row.version === 'ih')).toMatchObject({
            expectedDocuments: 1,
            downloadedDocuments: 1,
          }); // Parser revisions never enlarge the provider denominator.
          expect(
            federal.versions.find((row) => row.version === 'no_published_versions'),
          ).toMatchObject({ expectedDocuments: 0, failedExtractions: 0 });
          // A previously verified immutable receipt can be reused only while provider freshness is unchanged.
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) SELECT 'federal-old',source,scope,manifest,complete FROM legal_source_receipt WHERE id='federal-text'`,
          );
          await tx.$executeRawUnsafe(
            `UPDATE federal_evidence_observation SET metadata_jsonb=jsonb_set(metadata_jsonb,'{sourceInventoryReceiptId}','"federal-old"')`,
          );
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'US')!
              .downloadedDocuments,
          ).toBe(1);
          await tx.$executeRawUnsafe(
            `UPDATE legal_source_receipt SET manifest=jsonb_set(manifest,'{providerUpdatedAt}','"2025-01-01T00:00:00Z"') WHERE id='federal-old'`,
          );
          expect(
            (await service.coverage()).jurisdictions.find((row) => row.jurisdiction === 'US')!
              .downloadedDocuments,
          ).toBe(0);
        },
        { timeout: 60000 },
      );
    } finally {
      await db.$disconnect();
    }
  }, 90000);
});
