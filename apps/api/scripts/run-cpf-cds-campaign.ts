/**
 * Production-grade CPF/CDS historical + incremental ingestion campaign runner.
 *
 * Discovers official House/Senate index pages, downloads accepted table
 * documents, extracts PDF rows via the offline pymupdf tool (or reads XLSX
 * directly), upserts into canonical community_funding_* tables, and writes a
 * coverage/health report.
 *
 * Bounded, resumable, idempotent:
 *   - unchanged artifact SHA skips (unless --force)
 *   - per chamber/FY filters
 *   - dry-run mode performs discovery+download+extract only
 *
 * Does NOT schedule itself. Wire to whatever existing job runner the ops
 * environment already uses (ECS one-shot, cron, etc.).
 *
 * Examples:
 *   pnpm --filter @capiro/api exec tsx scripts/run-cpf-cds-campaign.ts --fy 2026 --chamber house
 *   pnpm --filter @capiro/api exec tsx scripts/run-cpf-cds-campaign.ts --all-years --dry-run
 *   pnpm --filter @capiro/api exec tsx scripts/run-cpf-cds-campaign.ts --fy 2025 --chamber senate --report out.json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  fetchDiscoveryPage,
  resolveSenateDownloadUrl,
  type DiscoveredSource,
} from '../src/government-data/community-funding/community-funding.discovery.js';
import { CommunityFundingUpsertService } from '../src/government-data/community-funding/community-funding.upsert.service.js';
import {
  parseHousePdfRows,
  parseSenatePdfRows,
} from '../src/government-data/community-funding/community-funding.parser.js';
import { readHouseCpfWorkbook } from '../src/government-data/community-funding/community-funding.xlsx.js';
import type { Chamber, ExtractedFundingRow } from '../src/government-data/community-funding/community-funding.types.js';
import { upsertSourceDocument, sha256OfFile } from '../src/program-element/source-document/source-document-registry.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = path.join(HERE, '__tools__', 'extract_cpf_cds_pdf.py');
const DEFAULT_WORK = path.resolve(process.cwd(), '.cache', 'cpf-cds-campaign');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}
function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function downloadBinary(url: string, dest: string): Promise<{
  finalUrl: string;
  contentType: string;
  bytes: number;
  sha256: string;
}> {
  let current = url;
  // Senate CMS interstitial: /download/slug → HTML with &download=1
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, {
      headers: { 'User-Agent': 'CapiroCpfCdsCampaign/1.0 (+engineering)' },
      redirect: 'follow',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ctype = res.headers.get('content-type') ?? '';
    const finalUrl = res.url;
    if (ctype.includes('text/html') || buf.slice(0, 15).toString('utf8').includes('<html')) {
      const html = buf.toString('utf8');
      const next = resolveSenateDownloadUrl(finalUrl, html);
      if (next && next !== current) {
        current = next;
        continue;
      }
      throw new Error(`HTML response without resolvable download for ${url}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return {
      finalUrl,
      contentType: ctype,
      bytes: buf.length,
      sha256: sha256Bytes(buf),
    };
  }
  throw new Error(`download hop limit for ${url}`);
}

function extractPdf(sourceFile: string, artifactPath: string, chamber: Chamber): {
  rows: number;
  warnings: number;
  pages: number;
  profile: string;
} {
  const profile = 'auto';
  const result = spawnSync(
    process.env.PYTHON ?? 'python',
    [EXTRACTOR, '--profile', profile, sourceFile, artifactPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`extractor failed: ${result.stderr || result.stdout}`);
  }
  const line = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}';
  const summary = JSON.parse(line) as {
    rows: number;
    warnings: number;
    pages: number;
    profile?: string;
  };
  // Prefer chamber-matching profile if auto picked the wrong chamber with similar scores —
  // the Nest parser still enforces column counts, so wrong-chamber artifacts fail closed.
  if (summary.profile && summary.profile.startsWith('house') && chamber === 'senate') {
    // re-run forced senate
    const forced = spawnSync(
      process.env.PYTHON ?? 'python',
      [EXTRACTOR, '--profile', 'senate', sourceFile, artifactPath],
      { encoding: 'utf8' },
    );
    if (forced.status === 0) {
      const s = JSON.parse((forced.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}');
      return { rows: s.rows, warnings: s.warnings, pages: s.pages, profile: 'senate' };
    }
  }
  if (summary.profile === 'senate' && chamber === 'house') {
    const forced = spawnSync(
      process.env.PYTHON ?? 'python',
      [EXTRACTOR, '--profile', 'auto', sourceFile, artifactPath],
      { encoding: 'utf8' },
    );
    // keep auto but if senate won on a house doc, try house + house_location and take better
    let best = summary;
    for (const p of ['house', 'house_location'] as const) {
      const r = spawnSync(
        process.env.PYTHON ?? 'python',
        [EXTRACTOR, '--profile', p, sourceFile, artifactPath + `.${p}.tmp.json`],
        { encoding: 'utf8' },
      );
      if (r.status === 0) {
        const s = JSON.parse((r.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}');
        if ((s.rows ?? 0) > (best.rows ?? 0)) {
          best = s;
          fs.copyFileSync(artifactPath + `.${p}.tmp.json`, artifactPath);
        }
      }
    }
    return {
      rows: best.rows,
      warnings: best.warnings,
      pages: best.pages,
      profile: best.profile ?? 'house',
    };
  }
  return {
    rows: summary.rows,
    warnings: summary.warnings,
    pages: summary.pages,
    profile: summary.profile ?? profile,
  };
}

function sourceKeyFor(chamber: Chamber, fy: number, candidate: DiscoveredSource): string {
  const slug = (candidate.title || path.basename(new URL(candidate.url).pathname))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  return `${chamber}_fy${fy}_${slug || 'table'}`;
}

function guessSubcommittee(title: string | null, url: string): string | null {
  const hay = `${title ?? ''} ${url}`.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/agriculture|ag-fda|ag_/, 'Agriculture'],
    [/commerce|cjs/, 'CJS'],
    [/energy|ewd|eandw/, 'Energy and Water'],
    [/interior/, 'Interior'],
    [/military|milcon|mcva/, 'MilCon-VA'],
    [/transportation|thud/, 'THUD'],
    [/homeland/, 'Homeland Security'],
    [/labor|lhhs/, 'LHHS'],
    [/financial|fsgg/, 'FSGG'],
    [/defense/, 'Defense'],
  ];
  for (const [re, name] of map) if (re.test(hay)) return name;
  return null;
}

interface DocResult {
  chamber: Chamber;
  fy: number;
  title: string | null;
  url: string;
  kind: string;
  format: string;
  status: 'skipped_non_table' | 'downloaded' | 'extracted' | 'ingested' | 'skipped_unchanged' | 'failed';
  parserProfile?: string;
  sourceRows?: number;
  parsed?: number;
  rejected?: number;
  upserted?: number;
  changed?: number;
  rejectionReasons?: Record<string, number>;
  error?: string;
  sha256?: string;
  runId?: string;
}

async function processCandidate(opts: {
  prisma: PrismaClient;
  chamber: Chamber;
  fy: number;
  candidate: DiscoveredSource;
  workDir: string;
  dryRun: boolean;
  force: boolean;
}): Promise<DocResult> {
  const { prisma, chamber, fy, candidate, workDir, dryRun, force } = opts;
  const base: DocResult = {
    chamber,
    fy,
    title: candidate.title,
    url: candidate.url,
    kind: candidate.kind,
    format: candidate.format,
    status: 'downloaded',
  };
  if (candidate.resolution !== 'accepted') {
    return { ...base, status: 'skipped_non_table' };
  }
  if (candidate.kind === 'guidance' || candidate.kind === 'jurisdiction_rules') {
    return { ...base, status: 'skipped_non_table' };
  }

  const key = sourceKeyFor(chamber, fy, candidate);
  const docDir = path.join(workDir, chamber, `fy${fy}`, key);
  fs.mkdirSync(docDir, { recursive: true });
  const ext =
    candidate.format === 'xlsx' ? '.xlsx' : candidate.format === 'pdf' ? '.pdf' : '.bin';
  const sourceFile = path.join(docDir, `source${ext}`);
  const artifactPath = path.join(docDir, 'rows.json');

  try {
    const dl = await downloadBinary(candidate.url, sourceFile);
    // finalize extension from magic
    let finalSource = sourceFile;
    if (fs.readFileSync(sourceFile).slice(0, 4).toString() === '%PDF' && !sourceFile.endsWith('.pdf')) {
      finalSource = sourceFile.replace(/\.bin$/, '.pdf');
      fs.renameSync(sourceFile, finalSource);
    } else if (
      fs.readFileSync(sourceFile).slice(0, 2).toString('binary') === 'PK' &&
      !sourceFile.endsWith('.xlsx')
    ) {
      finalSource = sourceFile.replace(/\.bin$/, '.xlsx');
      fs.renameSync(sourceFile, finalSource);
    }
    base.sha256 = dl.sha256;
    base.status = 'downloaded';

    const prior = await prisma.communityFundingIngestRun.findFirst({
      where: { source: key, artifactSha256: dl.sha256, status: { in: ['ok', 'warn'] } },
    });
    if (prior && !force) {
      return { ...base, status: 'skipped_unchanged', runId: prior.id };
    }

    let parsed;
    let pageCount: number | null = null;
    let documentType: string;
    let extractionMethod: string;
    let parserProfile = 'n/a';

    if (finalSource.toLowerCase().endsWith('.xlsx')) {
      if (chamber !== 'house') throw new Error('XLSX profile is House-only');
      parsed = await readHouseCpfWorkbook(finalSource, fy);
      documentType = 'cpf_consolidated_xlsx';
      extractionMethod = 'structured_import';
      parserProfile = 'house_xlsx';
      base.sourceRows = parsed.sourceRows;
    } else {
      const extractSummary = extractPdf(finalSource, artifactPath, chamber);
      parserProfile = extractSummary.profile;
      pageCount = extractSummary.pages;
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
        profile: Chamber;
        pageCount: number;
        rows: ExtractedFundingRow[];
      };
      // Nest parser profile is house|senate; extractor may report house_location normalized to house.
      const nestProfile = chamber;
      parsed =
        nestProfile === 'house'
          ? parseHousePdfRows(artifact.rows, fy, guessSubcommittee(candidate.title, candidate.url))
          : parseSenatePdfRows(artifact.rows, fy, guessSubcommittee(candidate.title, candidate.url));
      documentType = chamber === 'house' ? 'cpf_table' : 'cds_table';
      extractionMethod = 'deterministic_pdf';
      base.sourceRows = artifact.rows.length;
    }

    const rejectionReasons: Record<string, number> = {};
    for (const r of parsed.rejected) {
      const keyReason = r.reason.split(':')[0] ?? r.reason;
      rejectionReasons[keyReason] = (rejectionReasons[keyReason] ?? 0) + 1;
    }

    base.parserProfile = parserProfile;
    base.parsed = parsed.candidates.length;
    base.rejected = parsed.rejected.length;
    base.rejectionReasons = rejectionReasons;
    base.status = 'extracted';

    if (dryRun) return base;

    const registry = await upsertSourceDocument(prisma as never, {
      sourceKey: key,
      sha256: dl.sha256,
      fiscalYear: fy,
      budgetCycle: chamber === 'house' ? 'cpf_request' : 'cds_request',
      component: null,
      documentType,
      title: `${chamber === 'house' ? 'House CPF' : 'Senate CDS'} FY${fy}${
        guessSubcommittee(candidate.title, candidate.url)
          ? ` ${guessSubcommittee(candidate.title, candidate.url)}`
          : ''
      }`,
      sourceUrl: dl.finalUrl || candidate.url,
      byteSize: fs.statSync(finalSource).size,
      pageCount,
      downloadedAt: new Date(),
      artifactPath: finalSource.toLowerCase().endsWith('.xlsx') ? finalSource : artifactPath,
      extractionMethod,
      extractionToolVersion:
        extractionMethod === 'deterministic_pdf' ? 'pymupdf-positioned-words-v1' : 'exceljs',
      metadata: {
        chamber,
        requestType: chamber === 'house' ? 'cpf' : 'cds',
        subcommittee: guessSubcommittee(candidate.title, candidate.url),
        parserProfile,
        discoveryTitle: candidate.title,
      },
    });

    const outcome = await new CommunityFundingUpsertService(
      prisma as unknown as PrismaService,
    ).upsertMany(parsed.candidates, registry.document.id);

    const run = await prisma.communityFundingIngestRun.create({
      data: {
        source: key,
        chamber,
        fiscalYear: fy,
        subcommittee: guessSubcommittee(candidate.title, candidate.url),
        artifactPath: finalSource,
        artifactSha256: dl.sha256,
        rowsEmitted: parsed.candidates.length,
        upserted: outcome.upserted,
        changed: outcome.changed,
        rejected: parsed.rejected.length,
        status: parsed.rejected.length ? 'warn' : 'ok',
        notes: JSON.stringify({
          warnings: parsed.warnings,
          rejectedSample: parsed.rejected.slice(0, 20),
          rejectionReasons,
          parserProfile,
        }),
      },
    });

    return {
      ...base,
      status: 'ingested',
      upserted: outcome.upserted,
      changed: outcome.changed,
      runId: run.id,
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const workDir = path.resolve(arg('work-dir') ?? DEFAULT_WORK);
  const reportPath = arg('report');
  const dryRun = has('dry-run');
  const force = has('force');
  const allYears = has('all-years');
  const chamberArg = arg('chamber') as Chamber | undefined;
  const fyArg = arg('fy') ? Number(arg('fy')) : undefined;

  const chambers: Chamber[] = chamberArg ? [chamberArg] : ['house', 'senate'];
  const years = allYears
    ? [2022, 2023, 2024, 2025, 2026, 2027]
    : fyArg
      ? [fyArg]
      : [2026];

  fs.mkdirSync(workDir, { recursive: true });
  const prisma = new PrismaClient();
  const results: DocResult[] = [];
  const discovery: Array<Record<string, unknown>> = [];

  try {
    for (const chamber of chambers) {
      for (const fy of years) {
        const page = await fetchDiscoveryPage(chamber, fy);
        discovery.push({
          chamber,
          fy,
          status: page.status,
          statusCode: page.statusCode,
          accepted: page.candidates.filter(c => c.resolution === 'accepted').length,
          rejected: page.candidates.filter(c => c.resolution === 'rejected').length,
          byKind: page.candidates.reduce<Record<string, number>>((acc, c) => {
            acc[c.kind] = (acc[c.kind] ?? 0) + 1;
            return acc;
          }, {}),
          requestUrl: page.requestUrl,
        });
        // Persist discovery crawl when not dry-only-without-db — always persist crawl metadata.
        try {
          await prisma.communityFundingDiscoveryCrawl.create({
            data: {
              adapterId: page.adapterId,
              runKey: page.runKey,
              requestUrl: page.requestUrl,
              statusCode: page.statusCode,
              status: page.status,
              contentSha256: page.contentSha256,
              byteSize: page.byteSize,
              itemsSeen: page.itemsSeen,
              startedAt: page.startedAt,
              finishedAt: page.finishedAt,
              failureReason: page.failureReason,
            },
          });
        } catch {
          // unique runKey replay is fine
        }

        for (const candidate of page.candidates) {
          const doc = await processCandidate({
            prisma,
            chamber,
            fy,
            candidate,
            workDir,
            dryRun,
            force,
          });
          results.push(doc);
          console.log(
            JSON.stringify({
              event: 'doc',
              chamber,
              fy,
              status: doc.status,
              title: doc.title,
              parsed: doc.parsed,
              rejected: doc.rejected,
              error: doc.error,
            }),
          );
        }
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      dryRun,
      workDir,
      discovery,
      totals: {
        docs: results.length,
        ingested: results.filter(r => r.status === 'ingested').length,
        extracted: results.filter(r => r.status === 'extracted').length,
        skippedUnchanged: results.filter(r => r.status === 'skipped_unchanged').length,
        skippedNonTable: results.filter(r => r.status === 'skipped_non_table').length,
        failed: results.filter(r => r.status === 'failed').length,
        parsedRows: results.reduce((n, r) => n + (r.parsed ?? 0), 0),
        rejectedRows: results.reduce((n, r) => n + (r.rejected ?? 0), 0),
      },
      results,
    };

    const out = reportPath ?? path.join(workDir, `report-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ report: out, totals: summary.totals }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
