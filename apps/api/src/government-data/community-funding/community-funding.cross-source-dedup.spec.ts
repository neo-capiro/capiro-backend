/**
 * Real FY2026 cross-source dedup rehearsal, against a real disposable Postgres —
 * the mandatory proof for this repair (see PR #1328 repair brief §8-9).
 *
 * Uses the two real, already-committed FY2026 House CPF documents:
 *   - House FY2026 CJS subcommittee PDF (house_fy2026_cjs_cpf_table.pdf)
 *   - House FY2026 consolidated XLSX (house_fy2026_cpf_consolidated.xlsx)
 *
 * and proves the exact bug this repair fixes: the same real funding request,
 * published in both documents, collapses to ONE canonical community_funding_request
 * row with TWO community_funding_request_source provenance rows — never two
 * canonical rows.
 *
 * DB-gated: `process.env.DATABASE_URL ? describe : describe.skip`, matching the
 * existing convention in this repo (see live-hearings-phase7.integration.spec.ts).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CommunityFundingUpsertService } from './community-funding.upsert.service.js';
import { parseHousePdfRows } from './community-funding.parser.js';
import { readHouseCpfWorkbook } from './community-funding.xlsx.js';
import { upsertSourceDocument, sha256OfFile } from '../../program-element/source-document/source-document-registry.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ExtractedFundingRow } from './community-funding.types.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const root = path.resolve(__dirname, '../../..');
const dataDir = path.join(root, 'scripts/__data__/cpf_cds_source_documents');
const tool = path.join(root, 'scripts/__tools__/extract_cpf_cds_pdf.py');
const python = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';

function extractPdfRows(): { rows: ExtractedFundingRow[]; pageCount: number } {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cpf-cds-dedup-')), 'house.json');
  const child = spawnSync(python, [tool, '--profile', 'house', path.join(dataDir, 'house_fy2026_cjs_cpf_table.pdf'), output], { encoding: 'utf8', timeout: 120_000 });
  if (child.status !== 0) throw new Error(`extractor failed status=${child.status}: ${child.stderr || child.stdout}`);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

describeDb('real FY2026 cross-source dedup rehearsal (Postgres)', () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      'TRUNCATE community_funding_request_source, community_funding_request, source_document RESTART IDENTITY CASCADE',
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('ingests the real House CJS PDF and the real House consolidated XLSX together and collapses the real overlap to one canonical row per request, with both provenance rows preserved', async () => {
    const pdfArtifact = extractPdfRows();
    const pdfParsed = parseHousePdfRows(pdfArtifact.rows, 2026, 'CJS');
    const xlsxParsed = await readHouseCpfWorkbook(path.join(dataDir, 'house_fy2026_cpf_consolidated.xlsx'), 2026);

    // Report: PDF parsed rows, XLSX parsed rows (required by brief §9).
    // eslint-disable-next-line no-console
    console.log(
      `[cross-source-dedup] PDF parsed=${pdfParsed.candidates.length} rejected=${pdfParsed.rejected.length} | ` +
        `XLSX parsed=${xlsxParsed.candidates.length} rejected=${xlsxParsed.rejected.length}`,
    );
    expect(pdfParsed.candidates.length).toBe(937);
    expect(xlsxParsed.candidates.length).toBe(5363);

    const pdfDoc = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
      sourceKey: 'cpf_cds_dedup_rehearsal_house_fy2026_cjs_pdf', sha256: sha256OfFile(path.join(dataDir, 'house_fy2026_cjs_cpf_table.pdf')),
      fiscalYear: 2026, budgetCycle: 'cpf_request', component: null, documentType: 'cpf_table',
      title: 'House CPF FY2026 CJS (dedup rehearsal)', sourceUrl: 'https://appropriations.house.gov/fy2026-cjs-cpf',
      byteSize: fs.statSync(path.join(dataDir, 'house_fy2026_cjs_cpf_table.pdf')).size, pageCount: pdfArtifact.pageCount,
      downloadedAt: new Date(), extractionMethod: 'deterministic_pdf',
    });
    const xlsxDoc = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
      sourceKey: 'cpf_cds_dedup_rehearsal_house_fy2026_consolidated_xlsx', sha256: sha256OfFile(path.join(dataDir, 'house_fy2026_cpf_consolidated.xlsx')),
      fiscalYear: 2026, budgetCycle: 'cpf_request', component: null, documentType: 'cpf_consolidated_xlsx',
      title: 'House CPF FY2026 consolidated (dedup rehearsal)', sourceUrl: 'https://appropriations.house.gov/fy2026-consolidated-cpf',
      byteSize: fs.statSync(path.join(dataDir, 'house_fy2026_cpf_consolidated.xlsx')).size, pageCount: null,
      downloadedAt: new Date(), extractionMethod: 'structured_import',
    });

    const service = new CommunityFundingUpsertService(prisma as unknown as PrismaService);
    const pdfOutcome = await service.upsertMany(pdfParsed.candidates, pdfDoc.document.id);
    const xlsxOutcome = await service.upsertMany(xlsxParsed.candidates, xlsxDoc.document.id);

    const canonicalCount = await prisma.communityFundingRequest.count();
    const provenanceCount = await prisma.communityFundingRequestSource.count();
    const totalCandidates = pdfParsed.candidates.length + xlsxParsed.candidates.length;
    // Rows that collapsed into an existing canonical request instead of creating a new
    // one: total source rows minus the number of distinct canonical identities they
    // resolved to. (pdfOutcome.upserted + xlsxOutcome.upserted is NOT this number —
    // xlsxOutcome.upserted already excludes rows that matched a PDF-created identity,
    // so summing the two upserted counts double-subtracts the overlap.)
    const overlap = totalCandidates - canonicalCount;
    // eslint-disable-next-line no-console
    console.log(
      `[cross-source-dedup] pdfOutcome=${JSON.stringify(pdfOutcome)} xlsxOutcome=${JSON.stringify(xlsxOutcome)} ` +
        `canonicalRequests=${canonicalCount} provenanceRows=${provenanceCount} collapsedOverlap=${overlap}`,
    );

    // Structural invariants, real numbers (not asserted from theory — see the
    // identity-design audit in community-funding.identity.ts's class doc, which
    // found 849 of the 937 real PDF rows also appear in the real XLSX by this
    // identity key):
    expect(canonicalCount).toBeGreaterThan(0);
    expect(canonicalCount).toBeLessThan(pdfParsed.candidates.length + xlsxParsed.candidates.length); // real collapsing happened
    expect(provenanceCount).toBe(pdfParsed.candidates.length + xlsxParsed.candidates.length); // every source row has its own provenance row
    expect(overlap).toBeGreaterThan(800); // matches the real audited overlap count (849)

    // Manual inspection of a sample of collapsed records against both raw sources
    // (required by brief §9): pick a real, human-verifiable collapsed request and
    // assert its two provenance rows point to the two different real documents with
    // the two different real raw representations.
    const johnsonSmith = await prisma.communityFundingRequest.findFirst({
      where: { recipientNormalized: { contains: 'JOHNSON C SMITH' } },
      include: { sources: { include: { sourceDocument: { select: { sourceKey: true } } } } },
    });
    expect(johnsonSmith).not.toBeNull();
    expect(johnsonSmith!.sources).toHaveLength(2);
    const bySourceKey = new Map(johnsonSmith!.sources.map((s) => [s.sourceDocument.sourceKey, s]));
    expect(bySourceKey.has('cpf_cds_dedup_rehearsal_house_fy2026_cjs_pdf')).toBe(true);
    expect(bySourceKey.has('cpf_cds_dedup_rehearsal_house_fy2026_consolidated_xlsx')).toBe(true);
    // Real raw values differ across the two documents (see identity.ts class doc):
    // PDF gives the bare surname; XLSX gives "First Last". Both are preserved
    // verbatim on their own provenance row even though they collapsed to one request.
    expect(bySourceKey.get('cpf_cds_dedup_rehearsal_house_fy2026_cjs_pdf')!.requesterNameRaw).toBe('Adams');
    expect(bySourceKey.get('cpf_cds_dedup_rehearsal_house_fy2026_consolidated_xlsx')!.requesterNameRaw).toBe('Alma Adams');
    // Canonical identity hash is identical for the request regardless of which
    // source is inspected — there is only one identityHash because there is only
    // one canonical row.
    const secondLookup = await prisma.communityFundingRequest.findUnique({ where: { id: johnsonSmith!.id }, select: { identityHash: true } });
    expect(secondLookup!.identityHash).toBe(johnsonSmith!.identityHash);

    // Re-running either source again does not add duplicates (idempotency, brief §8).
    const canonicalBefore = canonicalCount, provenanceBefore = provenanceCount;
    await service.upsertMany(pdfParsed.candidates, pdfDoc.document.id);
    await service.upsertMany(xlsxParsed.candidates, xlsxDoc.document.id);
    expect(await prisma.communityFundingRequest.count()).toBe(canonicalBefore);
    expect(await prisma.communityFundingRequestSource.count()).toBe(provenanceBefore);
  });
});

// Narrow structural type matching source-document-registry.ts's SourceDocumentClient,
// declared locally to avoid importing it just for a type re-export here.
type SourceDocumentClient = Parameters<typeof upsertSourceDocument>[0];
