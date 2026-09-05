/**
 * GSA FRPP public dataset ingestion runner (Release 4).
 *
 *   pnpm --filter @capiro/api sync:gsa-frpp -- \
 *     --file "FRPP_public_dataset_FY24.xlsx" \
 *     --fy 2024 \
 *     --source-url "https://inventory.data.gov/.../frpp_public_dataset_fy24.xlsx" \
 *     [--commit]
 *
 * DRY RUN BY DEFAULT: validates the whole workbook, records the source run with
 * rows_written=0, and writes ZERO fact rows. Only `--commit` persists facts.
 * Bounded manual entrypoint only — there is deliberately NO recurring schedule
 * for this rail (mission §5). Idempotent on replay: identical documents are
 * skipped via the per-row source hash; a re-run writes only new hashes.
 *
 * Memory posture: the workbook is read with the ExcelJS STREAMING reader (the
 * FY24 authoritative file is ~145 MB / 307,919 rows × 117 columns and aborts
 * ExcelJS's buffered readFile with RangeError: Invalid string length). Rows are
 * parsed one at a time via parseFrppRow into the parse context, which is then
 * handed to the chunked idempotent ingest service.
 *
 * Prisma here runs standalone (scripts/ convention) — module Nest DI is not
 * available in this context, so the ingest service class is instantiated with
 * a thin PrismaClient wrapper.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import {
  createFrppParseContext,
  parseFrppRow,
  finalizeFrppParse,
} from '../src/district-nexus/priority-intelligence/priority-intelligence-gsa-frpp-parser.js';
import { GsaRealPropertyIngestService } from '../src/district-nexus/priority-intelligence/priority-intelligence-gsa-ingest.service.js';
import { DistrictNexusChangeWriter } from '../src/district-nexus/priority-intelligence/priority-intelligence-changes.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** SHA-256 of a file without loading it whole into memory. */
function sha256FileStreaming(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function main() {
  const filePath = arg('file');
  const fy = Number(arg('fy'));
  const sourceUrl = arg('source-url') ?? null;
  const commit = process.argv.includes('--commit');
  if (!filePath || !Number.isInteger(fy)) {
    throw new Error(
      'usage: sync-gsa-frpp --file <xlsx> --fy <year> [--source-url <url>] [--commit]',
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const sha256 = await sha256FileStreaming(filePath);

  // ── Stream-parse the FIRST worksheet (FY24 verified: single sheet) ──────────
  const ctx = createFrppParseContext();
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
  });
  let sheetCount = 0;
  let rowNumber = 0;
  await new Promise<void>((resolve, reject) => {
    workbookReader.on(
      'worksheet',
      (worksheetReader: {
        on: (event: string, cb: (row: { values?: unknown[] }) => void) => void;
      }) => {
        sheetCount += 1;
        if (sheetCount > 1) return; // parse the first sheet only
        worksheetReader.on('row', (row) => {
          rowNumber += 1;
          parseFrppRow(ctx, rowNumber, (row.values ?? []) as unknown[], fy);
        });
      },
    );
    workbookReader.on('error', reject);
    workbookReader.on('end', () => resolve());
    workbookReader.read();
  });
  finalizeFrppParse(ctx, fy);

  if (sheetCount === 0) throw new Error('workbook has no worksheets');

  const prisma = new PrismaClient();
  try {
    // Release 4 change rail: the ingest service detects GSA changes against the
    // persisted FY snapshot and writes district_nexus_change rows — additions
    // atomically with their chunk, material changes/removals after commit.
    // Dry runs (no --commit) write ZERO facts and ZERO ledger rows.
    const changeWriter = new DistrictNexusChangeWriter(prisma as never);
    const service = new GsaRealPropertyIngestService(prisma as never, changeWriter);
    const result = await service.ingest({
      sourceDataset: 'frpp_public_detailed',
      fiscalYear: fy,
      sourceDocumentSha256: sha256,
      sourceUrl,
      dryRun: !commit,
      rows: ctx.rows,
      warnings: ctx.warnings,
      metadata: {
        rejections: ctx.rejections.slice(0, 20),
        rejectionCount: ctx.rejections.length,
        missingRequiredColumns: ctx.missing,
        worksheetCount: sheetCount,
      },
    });

    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          dryRun: result.dryRun,
          status: result.status,
          rowsSeen: result.rowsSeen,
          rowsWritten: result.rowsWritten,
          rowsSkippedDuplicate: result.rowsSkippedDuplicate,
          changesDetected: result.changes?.detected ?? null,
          changesWritten: result.changes?.written ?? null,
          changesDuplicates: result.changes?.duplicates ?? null,
          parsedRejected: ctx.rejections.length,
          warnings: ctx.warnings,
          sourceDocumentSha256: sha256,
          missingRequiredColumns: ctx.missing,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
