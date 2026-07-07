/**
 * watch-budget-docs — detect new/changed defense-budget source documents
 * (PE Watch auto-update plan, Phase 1; docs/plans/2026-07-06-pe-watch-auto-update-plan.md).
 *
 *   watch-budget-docs                     # DRY RUN: print detections, write nothing
 *   watch-budget-docs --commit            # record detections + send the alert email
 *   watch-budget-docs --commit --baseline # first run: record current inventory, NO email
 *   flags: --skip-email, --skip-revisions
 *
 * Sources polled (per plan §5.1 decisions + money-graph §7.3g routing):
 *   - comptroller.war.gov Budget-Materials index + per-FY pages (direct fetch OK)
 *   - Congress.gov committee-reports listings for HASC/SASC + House/Senate
 *     Appropriations (defense-relevance title filter on the approps committees)
 *   - secnav / saffm index pages (browser UA; failure = degraded source, not a
 *     task failure — saffm blocks bots; detections there are fetchable:false)
 *   - asafm is intentionally NOT polled (WAF/IP-blocked from AWS egress — see
 *     scripts/__config__/comptroller-document-urls.yaml)
 *
 * Detection state = IntelligenceChange rows (source='budget_doc_watch'), keyed
 * by data.dedupeKey — re-runs are no-ops for known documents. Documents already
 * ingested into the source_document registry are treated as known via their
 * sourceUrl. Registry live heads with a comptroller sourceUrl are additionally
 * sha256-checked for silent republications (errata) — a changed sha emits a
 * REVISED detection (byte-size HEAD short-circuit avoids re-downloading).
 *
 * Commit runs wrap in runWithSyncRun('watch-budget-docs') for the ingestion
 * dashboard + INGESTION_METRIC + the one-instance guard. Alert email goes via
 * SESv2 (same rail as tracker alerts) to WATCH_BUDGET_DOCS_EMAIL_TO.
 */
import { createHash } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  classifyComptrollerLink,
  classifyServiceLink,
  dedupeKeyForReport,
  dedupeKeyForUrl,
  diffNew,
  extractLinks,
  isDefenseRelevantReportTitle,
  loaderHintFor,
  renderDetectionEmail,
  type DetectedDoc,
  type RevisedDoc,
} from '../src/program-element/budget-doc-watch/budget-doc-watch.js';
import { lastSuccessfulWatermark, runWithSyncRun, emptyCounts } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const SYNC_SOURCE = 'watch-budget-docs';
const WATCH_UA = 'Mozilla/5.0 (capiro-budget-doc-watch)';
// Service FM sites gate on browser-looking UAs (same posture as sync-hearings
// for docs.house.gov). Index-page reads only — per the counsel-pending decision
// we do NOT fetch their PDFs.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CONGRESS_BASE = 'https://api.congress.gov/v3';
const COMPTROLLER_INDEX = 'https://comptroller.war.gov/Budget-Materials/';
const DELAY_MS = 200;

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SourceStatus {
  source: string;
  ok: boolean;
  detail?: string;
}

async function fetchText(url: string, ua: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': ua } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Comptroller: index + per-FY pages. Returns docs incl. fy_index links themselves. */
async function scanComptroller(statuses: SourceStatus[]): Promise<DetectedDoc[]> {
  const docs: DetectedDoc[] = [];
  const fyPages = new Set<string>();
  try {
    const html = await fetchText(COMPTROLLER_INDEX, WATCH_UA);
    for (const link of extractLinks(html, COMPTROLLER_INDEX)) {
      const c = classifyComptrollerLink(link.href, link.text);
      if (!c) continue;
      if (c.docType === 'fy_index') fyPages.add(link.href);
      docs.push({
        dedupeKey: dedupeKeyForUrl(link.href),
        url: link.href,
        title: link.text || link.href.split('/').pop() || link.href,
        publisher: 'comptroller',
        docType: c.docType,
        fiscalYear: c.fiscalYear,
        fetchable: true,
        loaderHint: loaderHintFor(c.docType, 'comptroller'),
      });
    }
    statuses.push({ source: 'comptroller-index', ok: true });
  } catch (e) {
    statuses.push({ source: 'comptroller-index', ok: false, detail: (e as Error).message });
    return docs;
  }

  for (const page of fyPages) {
    await sleep(DELAY_MS);
    try {
      const html = await fetchText(page, WATCH_UA);
      for (const link of extractLinks(html, page)) {
        const c = classifyComptrollerLink(link.href, link.text);
        if (!c || c.docType === 'fy_index') continue;
        docs.push({
          dedupeKey: dedupeKeyForUrl(link.href),
          url: link.href,
          title: link.text || link.href.split('/').pop() || link.href,
          publisher: 'comptroller',
          docType: c.docType,
          fiscalYear: c.fiscalYear,
          fetchable: true,
          loaderHint: loaderHintFor(c.docType, 'comptroller'),
        });
      }
      statuses.push({ source: `comptroller-fy-page:${page}`, ok: true });
    } catch (e) {
      statuses.push({ source: `comptroller-fy-page:${page}`, ok: false, detail: (e as Error).message });
    }
  }
  return docs;
}

/** Service FM index pages: link-inventory diff only; PDFs marked per-publisher fetchability. */
async function scanServiceIndexes(statuses: SourceStatus[]): Promise<DetectedDoc[]> {
  const docs: DetectedDoc[] = [];
  const sources: Array<{ publisher: string; url: string; fetchable: boolean }> = [
    {
      publisher: 'secnav',
      url: 'https://www.secnav.navy.mil/fmc/fmb/Pages/Fiscal-Year-Budget.aspx',
      fetchable: false, // counsel-pending on automated PDF pulls; index-diff only
    },
    {
      publisher: 'saffm',
      url: 'https://www.saffm.hq.af.mil/FM-Resources/Budget/',
      fetchable: false, // publisher blocks non-browser clients
    },
  ];
  for (const s of sources) {
    await sleep(DELAY_MS);
    try {
      const html = await fetchText(s.url, BROWSER_UA);
      for (const link of extractLinks(html, s.url)) {
        const c = classifyServiceLink(link.href);
        if (!c) continue;
        docs.push({
          dedupeKey: dedupeKeyForUrl(link.href),
          url: link.href,
          title: link.text || link.href.split('/').pop() || link.href,
          publisher: s.publisher,
          docType: c.docType,
          fiscalYear: c.fiscalYear,
          fetchable: s.fetchable,
          loaderHint: loaderHintFor(c.docType, s.publisher),
        });
      }
      statuses.push({ source: `service-index:${s.publisher}`, ok: true });
    } catch (e) {
      // Expected for bot-blocking publishers — degrade, never fail the task.
      statuses.push({ source: `service-index:${s.publisher}`, ok: false, detail: (e as Error).message });
    }
  }
  return docs;
}

interface CongressReportItem {
  citation?: string;
  congress?: number;
  chamber?: string;
  type?: string;
  number?: number;
  part?: number;
  updateDate?: string;
}

/** HASC/SASC + approps committee report listings since the watermark. */
async function scanCommitteeReports(since: Date, statuses: SourceStatus[]): Promise<DetectedDoc[]> {
  const docs: DetectedDoc[] = [];
  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) {
    statuses.push({ source: 'congress-reports', ok: false, detail: 'CONGRESS_API_KEY not set' });
    return docs;
  }
  const committees: Array<{ chamber: string; code: string; filterTitles: boolean }> = [
    { chamber: 'house', code: 'hsas00', filterTitles: false },
    { chamber: 'senate', code: 'ssas00', filterTitles: false },
    { chamber: 'house', code: 'hsap00', filterTitles: true },
    { chamber: 'senate', code: 'ssap00', filterTitles: true },
  ];
  const fromDateTime = `${since.toISOString().slice(0, 19)}Z`;

  for (const c of committees) {
    await sleep(DELAY_MS);
    try {
      const url = `${CONGRESS_BASE}/committee/${c.chamber}/${c.code}/reports?fromDateTime=${encodeURIComponent(fromDateTime)}&limit=250&format=json&api_key=${apiKey}`;
      const res = await fetch(url, { headers: { 'User-Agent': WATCH_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { reports?: CongressReportItem[] };
      for (const r of body.reports ?? []) {
        if (!r.citation) continue;
        let title = r.citation;
        if (c.filterTitles) {
          // Full approps committees file many non-defense reports; pull the
          // detail title and keep only defense-relevant ones.
          await sleep(DELAY_MS);
          const detailTitle = await fetchReportTitle(r, apiKey);
          if (detailTitle) title = detailTitle;
          if (!detailTitle || !isDefenseRelevantReportTitle(detailTitle)) continue;
        }
        const publicUrl = buildPublicReportUrl(r);
        docs.push({
          dedupeKey: dedupeKeyForReport(r.citation + (r.part ? `-part-${r.part}` : '')),
          url: publicUrl,
          title: `${r.citation} — ${title}`,
          publisher: 'congress.gov',
          docType: 'committee_report',
          fiscalYear: null,
          fetchable: true,
          loaderHint: loaderHintFor('committee_report', 'congress.gov'),
        });
      }
      statuses.push({ source: `congress-reports:${c.code}`, ok: true });
    } catch (e) {
      statuses.push({ source: `congress-reports:${c.code}`, ok: false, detail: (e as Error).message });
    }
  }
  return docs;
}

async function fetchReportTitle(r: CongressReportItem, apiKey: string): Promise<string | null> {
  if (!r.congress || !r.type || !r.number) return null;
  try {
    const url = `${CONGRESS_BASE}/committee-report/${r.congress}/${r.type.toLowerCase()}/${r.number}?format=json&api_key=${apiKey}`;
    const res = await fetch(url, { headers: { 'User-Agent': WATCH_UA } });
    if (!res.ok) return null;
    const body = (await res.json()) as { committeeReports?: Array<{ title?: string }> };
    return body.committeeReports?.[0]?.title ?? null;
  } catch {
    return null;
  }
}

/** Public congress.gov URL (never store api.congress.gov URLs — house rule from sync-hearings). */
function buildPublicReportUrl(r: CongressReportItem): string {
  if (!r.congress || !r.type || !r.number) return 'https://www.congress.gov/committee-reports';
  const kind = r.type.toLowerCase().startsWith('s') ? 'senate-report' : 'house-report';
  return `https://www.congress.gov/congressional-report/${r.congress}th-congress/${kind}/${r.number}`;
}

/** sha-check registry live heads on comptroller for silent republications. */
async function scanRevisions(
  prisma: PrismaClient,
  statuses: SourceStatus[],
): Promise<RevisedDoc[]> {
  const revised: RevisedDoc[] = [];
  const heads = await prisma.sourceDocument.findMany({
    where: {
      supersededByDocumentId: null,
      sha256: { not: null },
      sourceUrl: { startsWith: 'https://comptroller.war.gov/' },
    },
    select: { sourceKey: true, sourceUrl: true, sha256: true, byteSize: true, documentType: true },
  });
  for (const head of heads) {
    await sleep(DELAY_MS);
    try {
      // Byte-size short-circuit: only download when the size changed or HEAD fails.
      if (head.byteSize) {
        try {
          const headRes = await fetch(head.sourceUrl, {
            method: 'HEAD',
            headers: { 'User-Agent': WATCH_UA },
          });
          const len = Number(headRes.headers.get('content-length') ?? NaN);
          if (headRes.ok && Number.isFinite(len) && len === head.byteSize) continue;
        } catch {
          /* fall through to GET */
        }
      }
      const res = await fetch(head.sourceUrl, { headers: { 'User-Agent': WATCH_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const sha = createHash('sha256').update(buf).digest('hex');
      if (sha !== head.sha256) {
        revised.push({
          dedupeKey: `rev:${dedupeKeyForUrl(head.sourceUrl)}:${sha}`,
          sourceKey: head.sourceKey,
          url: head.sourceUrl,
          priorSha256: head.sha256 ?? '',
          newSha256: sha,
          loaderHint: loaderHintFor(
            head.documentType === 'r1' ? 'r1' : head.documentType === 'p1' ? 'p1' : 'jbook_detail',
            'comptroller',
          ),
        });
      }
      statuses.push({ source: `revision-check:${head.sourceKey}`, ok: true });
    } catch (e) {
      statuses.push({ source: `revision-check:${head.sourceKey}`, ok: false, detail: (e as Error).message });
    }
  }
  return revised;
}

async function loadKnownKeys(prisma: PrismaClient): Promise<Set<string>> {
  const known = new Set<string>();
  const changes = await prisma.intelligenceChange.findMany({
    where: { source: 'budget_doc_watch' },
    select: { dedupeKey: true, data: true },
  });
  for (const c of changes) {
    const key = c.dedupeKey ?? (c.data as { dedupeKey?: string } | null)?.dedupeKey;
    if (key) known.add(key);
  }
  const registry = await prisma.sourceDocument.findMany({ select: { sourceUrl: true } });
  for (const r of registry) {
    if (r.sourceUrl.startsWith('http')) known.add(dedupeKeyForUrl(r.sourceUrl));
  }
  return known;
}

/** Insert one detection row; duplicate dedupeKey (P2002) = already recorded, skip. */
async function createDetection(
  prisma: PrismaClient,
  data: Prisma.IntelligenceChangeCreateInput,
): Promise<boolean> {
  try {
    await prisma.intelligenceChange.create({ data });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return false;
    throw e;
  }
}

async function recordDetections(
  prisma: PrismaClient,
  newDocs: DetectedDoc[],
  revised: RevisedDoc[],
  baseline: boolean,
): Promise<number> {
  let written = 0;
  for (const d of newDocs) {
    const created = await createDetection(prisma, {
      dedupeKey: `budget-doc:${d.dedupeKey}`,
      source: 'budget_doc_watch',
      changeType: baseline ? 'baseline_document' : 'new_document',
      severity: baseline ? 'info' : d.docType === 'fy_index' ? 'critical' : 'notable',
      title: baseline ? `Baseline budget doc: ${d.title}` : `New budget document: ${d.title}`,
      description: `${d.url}\n${d.loaderHint}${d.fetchable ? '' : '\nMANUAL BROWSER DOWNLOAD REQUIRED (publisher blocks bots)'}`,
      relatedPeCodes: [],
      consumed: baseline,
      data: {
        dedupeKey: d.dedupeKey,
        url: d.url,
        docType: d.docType,
        fiscalYear: d.fiscalYear,
        publisher: d.publisher,
        fetchable: d.fetchable,
        loaderHint: d.loaderHint,
        baseline,
      } as Prisma.InputJsonValue,
    });
    if (created) written += 1;
  }
  for (const r of revised) {
    const created = await createDetection(prisma, {
      dedupeKey: `budget-doc:${r.dedupeKey}`,
      source: 'budget_doc_watch',
      changeType: 'revised_document',
      severity: 'notable',
      title: `Revised budget document: ${r.sourceKey}`,
      description: `${r.url}\nsha256 ${r.priorSha256} -> ${r.newSha256}\n${r.loaderHint}`,
      relatedPeCodes: [],
      data: {
        dedupeKey: r.dedupeKey,
        url: r.url,
        sourceKey: r.sourceKey,
        priorSha256: r.priorSha256,
        newSha256: r.newSha256,
      } as Prisma.InputJsonValue,
    });
    if (created) written += 1;
  }
  return written;
}

async function sendAlertEmail(newDocs: DetectedDoc[], revised: RevisedDoc[]): Promise<boolean> {
  const to = process.env.WATCH_BUDGET_DOCS_EMAIL_TO ?? 'neo@capiro.ai';
  const from = process.env.TRACKER_ALERT_EMAIL_FROM ?? 'alerts@capiro.ai';
  const region = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';
  const { subject, text, html } = renderDetectionEmail(newDocs, revised);
  try {
    const ses = new SESv2Client({ region });
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: html, Charset: 'UTF-8' },
              Text: { Data: text, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
    console.log(`[watch-budget-docs] alert email sent to ${to}`);
    return true;
  } catch (e) {
    // Email is best-effort: the IntelligenceChange rows are the durable record.
    console.error(`[watch-budget-docs] alert email FAILED: ${(e as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const baseline = flag('baseline');
  const skipEmail = flag('skip-email');
  const skipRevisions = flag('skip-revisions');
  if (baseline && !commit) {
    console.error('--baseline requires --commit');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const run = async (): Promise<{ inserted: number; updated: number; skipped: number; errors: number }> => {
      const statuses: SourceStatus[] = [];
      const watermark = await lastSuccessfulWatermark(prisma, SYNC_SOURCE);
      // 3-day overlap on the watermark; 45-day floor for first runs.
      const since = watermark
        ? new Date(watermark.getTime() - 3 * 24 * 3600 * 1000)
        : new Date(Date.now() - 45 * 24 * 3600 * 1000);

      const known = await loadKnownKeys(prisma);
      const [comptroller, services, reports] = [
        await scanComptroller(statuses),
        await scanServiceIndexes(statuses),
        await scanCommitteeReports(since, statuses),
      ];
      const revised = skipRevisions || baseline ? [] : await scanRevisions(prisma, statuses);

      const current = [...comptroller, ...services, ...reports];
      const fresh = diffNew(current, known);

      const degraded = statuses.filter((s) => !s.ok);
      console.log(
        JSON.stringify(
          {
            mode: commit ? (baseline ? 'BASELINE' : 'COMMIT') : 'DRY_RUN',
            since: since.toISOString(),
            scanned: current.length,
            known: known.size,
            new_detections: fresh.map((d) => ({
              key: d.dedupeKey,
              docType: d.docType,
              fy: d.fiscalYear,
              url: d.url,
              fetchable: d.fetchable,
            })),
            revised: revised.map((r) => ({ sourceKey: r.sourceKey, newSha256: r.newSha256 })),
            degraded_sources: degraded,
          },
          null,
          2,
        ),
      );

      if (!commit) {
        console.log('DRY RUN — re-run with --commit to record detections.');
        return { ...emptyCounts(), skipped: fresh.length };
      }

      const written = await recordDetections(prisma, fresh, revised, baseline);
      if (!baseline && !skipEmail && (fresh.length > 0 || revised.length > 0)) {
        await sendAlertEmail(fresh, revised);
      }
      // Degraded sources (saffm bot-block, transient .gov hiccups) are logged
      // above but intentionally NOT counted as errors: they must not trip the
      // task-failure alert every night.
      return { inserted: written, updated: 0, skipped: 0, errors: 0 };
    };

    if (commit) {
      await runWithSyncRun(prisma, SYNC_SOURCE, run);
    } else {
      await run();
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((e) => {
  console.error('[watch-budget-docs] fatal', (e as Error)?.stack ?? e);
  process.exit(1);
});
