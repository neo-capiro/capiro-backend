/**
 * report-pe-attribution-gaps.ts — C2.5 SELECT-only attribution gap analysis.
 *
 * Reports:
 *   1. Observations with NULL source_document_id grouped by source/field/age-bucket
 *      (are they attachable to an existing defense_budget_source_document by
 *      sourceKey match, or orphan class?).
 *   2. program_element_year rows flagged sourceAttributionMissing (enacted + request)
 *      — do observations exist for those pe/fy/field with a source_document_id we
 *      can promote into the canonical row's raw.sourceAttribution?
 *
 *   tsx scripts/report-pe-attribution-gaps.ts   # SELECT only, no writes ever
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    // 1. Null source_document observations by source/field
    const nullBySourceField = await prisma.$queryRaw<
      Array<{ source: string; fieldName: string; n: number; oldest: Date; newest: Date }>
    >`
      SELECT source, field_name AS "fieldName", COUNT(*)::int AS n,
             MIN(recorded_at) AS oldest, MAX(recorded_at) AS newest
      FROM program_element_year_source_value
      WHERE source_document_id IS NULL
      GROUP BY source, field_name
      ORDER BY n DESC
      LIMIT 40
    `;

    // 2. Can those sources be matched to registered source documents (by sourceKey)?
    const docs = await prisma.sourceDocument.findMany({
      select: { id: true, sourceKey: true, budgetCycle: true, documentType: true, fiscalYear: true, sha256: true },
    });
    const docBySourceKey = new Map(docs.map((d) => [d.sourceKey, d]));

    const attachable: Record<string, { n: number; docId: string | null }> = {};
    let orphanCount = 0;
    const totals = new Map<string, number>();
    for (const row of nullBySourceField) {
      const base = row.source.replace(/_fy\d+$/i, '');
      const doc = docBySourceKey.get(row.source) ?? docBySourceKey.get(base);
      totals.set(row.source, (totals.get(row.source) ?? 0) + row.n);
      if (doc) {
        attachable[row.source] = { n: (attachable[row.source]?.n ?? 0) + row.n, docId: doc.id };
      } else {
        orphanCount += row.n;
      }
    }

    // 3. Canonical rows with missing enacted attribution — observation candidates
    const enactedGaps = await prisma.$queryRaw<
      Array<{ peCode: string; fy: number; candidateSource: string | null; candidateDocId: string | null }>
    >`
      SELECT y.pe_code AS "peCode", y.fy,
             (SELECT sv.source FROM program_element_year_source_value sv
               WHERE sv.pe_code = y.pe_code AND sv.fy = y.fy AND sv.field_name = 'enacted'
                 AND sv.source_document_id IS NOT NULL
               ORDER BY sv.is_winner DESC, sv.recorded_at ASC LIMIT 1) AS "candidateSource",
             (SELECT sv.source_document_id FROM program_element_year_source_value sv
               WHERE sv.pe_code = y.pe_code AND sv.fy = y.fy AND sv.field_name = 'enacted'
                 AND sv.source_document_id IS NOT NULL
               ORDER BY sv.is_winner DESC, sv.recorded_at ASC LIMIT 1) AS "candidateDocId"
      FROM program_element_year y
      WHERE y.enacted IS NOT NULL
        AND (y.raw_jsonb->'sourceAttribution'->>'enacted') IS NULL
      LIMIT 5000
    `;
    const withCandidate = enactedGaps.filter((r) => r.candidateDocId !== null).length;

    // 4. Registered documents by sourceKey (for attach targeting)
    const docList = docs.map((d) => ({
      sourceKey: d.sourceKey, budgetCycle: d.budgetCycle, documentType: d.documentType,
      fiscalYear: d.fiscalYear, sha256Prefix: d.sha256 ? d.sha256.slice(0, 12) : null,
    }));

    console.log(JSON.stringify({
      mode: 'SELECT-ONLY',
      nullSourceDocumentObservations: {
        total: nullBySourceField.reduce((a, r) => a + r.n, 0),
        bySource: Object.fromEntries(Array.from(totals.entries()).sort((a, b) => b[1] - a[1])),
        bySourceField: nullBySourceField.map((r) => ({
          source: r.source, fieldName: r.fieldName, n: r.n,
          oldest: r.oldest, newest: r.newest,
        })),
        attachableByRegisteredDoc: Object.fromEntries(
          Object.entries(attachable).sort((a, b) => b[1].n - a[1].n),
        ),
        orphanNoRegisteredDoc: orphanCount,
      },
      enactedAttributionGaps: {
        sampledRows: enactedGaps.length,
        withObservationCandidate: withCandidate,
        withoutCandidate: enactedGaps.length - withCandidate,
        samples: enactedGaps.slice(0, 10),
      },
      registeredDocuments: docList,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[report-pe-attribution-gaps] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
