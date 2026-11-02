import { PrismaClient, type Prisma } from '@prisma/client';
import { structureText } from '../ingestion/bill-document-structure.js';
import { CHUNKER_VERSION } from '../ingestion/bill-text-passages.js';
import { BillTextService } from './bill-text.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';

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
            `CREATE TEMP TABLE federal_evidence_revision(id uuid,bill_id text,collection text,version_code text,package_id text,extraction_hash text,content_hash text,source_url text,published_at timestamptz,metadata_jsonb jsonb,raw_content text) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill(id text,state text,session_key text,bill_number text,title text,status text,legiscan_progress jsonb,latest_action_date date,legiscan_bill_id int) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill_action(bill_key text,date date,text text) ON COMMIT DROP`,
            `CREATE TEMP TABLE state_bill_published_record(id uuid,bill_key text,kind text,source_identity text,revision_hash text,event_date text,evidence jsonb,first_observed_at timestamptz) ON COMMIT DROP`,
            `CREATE TEMP TABLE bill_text_extraction(id uuid,source_kind text,revision_id uuid,parser_version text,document_hash text,text_hash text,structure_hash text,extracted_text text,structure_jsonb jsonb,completeness text,warnings_jsonb jsonb,created_at timestamptz) ON COMMIT DROP`,
            `CREATE TEMP TABLE bill_text_passage(extraction_id uuid,chunker_version text,ordinal int,start_offset int,end_offset int,content_text text,metadata_jsonb jsonb DEFAULT '{"semanticAvailable":true}',search_vector tsvector GENERATED ALWAYS AS(to_tsvector('english',content_text)) STORED) ON COMMIT DROP`,
            `CREATE INDEX ON bill_text_passage USING GIN(search_vector)`,
            `CREATE TEMP TABLE context_embeddings(tenant_id uuid,source_type text,source_id text,model text,metadata_jsonb jsonb,embedding vector(1024)) ON COMMIT DROP`,
            `CREATE TEMP TABLE legal_source_receipt(id text,source text,scope jsonb,manifest jsonb,complete boolean) ON COMMIT DROP`,
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
              'SECTION 1. Rights.\nThe right to cost-effective shelter is established.\n' +
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
                `INSERT INTO context_embeddings VALUES(NULL,'state_bill_passage',$1,'test-model',$2::jsonb,$3::vector)`,
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
          expect(semantic.totalRevisions).toBe(1);
          expect(semantic.results[0]!.identity.revisionId).toBe(ids[0]!.revisionId);
          expect(provider.embed).toHaveBeenCalledWith('help people afford a home');
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
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_dataset_archive VALUES($1)`,
            'c'.repeat(64),
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO legal_source_receipt VALUES('synthetic','fy26-state-frozen-inventory',$1::jsonb,$2::jsonb,true)`,
            JSON.stringify({
              fiscalYear: 2026,
              jurisdiction: 'FL',
              sessionKey: '2025',
              archiveHash: 'c'.repeat(64),
            }),
            JSON.stringify({
              sourceListComplete: true,
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
          const coverage = await service.coverage();
          const fl = coverage.jurisdictions.find((row) => row.jurisdiction === 'FL')!;
          expect(fl.versions[0]).toMatchObject({
            expectedBills: 2,
            metadataBills: 1,
            expectedDocuments: 2,
            downloadedDocuments: 1,
            missingParents: 1,
          });
          expect(fl.status).toBe('partial');
        },
        { timeout: 60000 },
      );
    } finally {
      await db.$disconnect();
    }
  }, 90000);
});
