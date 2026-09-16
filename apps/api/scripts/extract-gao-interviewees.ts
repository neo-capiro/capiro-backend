import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
/**
 * Step 34B — extract DoD personnel named in recent GAO reports.
 *
 *   pnpm --filter @capiro/api extract:gao-interviewees
 *   tsx scripts/extract-gao-interviewees.ts --months 12
 *
 * Reads gao_report rows in the last N months (default 12) on DoD topics, runs an LLM
 * pass (Claude via raw fetch to api.anthropic.com — the repo's house pattern; there is
 * no src/llm/ client), and upserts each named person via the personnel writer
 * (source='gao_interviewee', confidence=0.55).
 *
 * NOTE: gao_report has no full-text column and the repo has no Textract integration, so
 * the LLM runs over title + summary + topics + agencies (same precedent as Step 32's
 * title+summary NER; yield is modest by design). Full-PDF extraction via Textract is a
 * documented future seam (GaoReportInput.fullText) — not wired here.
 *
 * Idempotent: the writer dedups source mentions by observedAt (== report.publishDate).
 * Cadence: weekly (EventBridge).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  GaoPersonnelExtractorService,
  GAO_INTERVIEWEE_SOURCE,
  GAO_NER_SYSTEM_PROMPT,
  type GaoReportInput,
  type GaoLlmPerson,
} from '../src/acquisition-personnel/extractors/gao-personnel-extractor.service.js';
import { AcquisitionPersonnelWriterService } from '../src/acquisition-personnel/acquisition-personnel-writer.service.js';
import { MatchScorerService } from '../src/acquisition-personnel/matching/match-scorer.service.js';

dotenvConfig();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

// DoD-topic / agency keywords used to scope which GAO reports we process.
const DOD_KEYWORDS = [
  'defense',
  'army',
  'navy',
  'air force',
  'marine corps',
  'space force',
  'dod',
  'weapon',
  'acquisition',
  'missile',
  'darpa',
  'military',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isDodReport(topics: string[], agencies: string[], title: string): boolean {
  const hay = [...topics, ...agencies, title].join(' ').toLowerCase();
  return DOD_KEYWORDS.some((k) => hay.includes(k));
}

/** Real Claude extractor: raw fetch to Anthropic, parse JSON persons. */
async function llmExtract(report: GaoReportInput): Promise<GaoLlmPerson[]> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(prepareAnthropicRequest({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: GAO_NER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: GaoPersonnelExtractorService.buildUserPrompt(report) }],
    })),
  });
  const raw = (await res.json()) as { content?: Array<{ text?: string }>; error?: { message?: string } };
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${raw.error?.message ?? 'error'}`);
  const text = (raw.content ?? []).map((b) => b.text ?? '').join('');
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { persons?: GaoLlmPerson[] };
    return parsed.persons ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const months = Number(arg('months') ?? 12);
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const source = 'gao_interviewee';

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const writer = new AcquisitionPersonnelWriterService(prisma, new MatchScorerService(prisma));
  const extractor = new GaoPersonnelExtractorService();

  const run = await prisma.syncRun.create({ data: { source, startedAt: new Date(), status: 'running' } });

  let reports = 0;
  let persons = 0;
  let inserted = 0;
  let errors = 0;

  try {
    const rows = await prisma.gaoReport.findMany({
      where: { publishDate: { gte: since } },
      orderBy: { publishDate: 'desc' },
    });
    const dodRows = rows.filter((r) => isDodReport(r.topics, r.agencies, r.title));
    console.error(`Found ${rows.length} GAO reports since ${since.toISOString().slice(0, 10)}; ${dodRows.length} DoD-topic`);

    for (const r of dodRows) {
      reports += 1;
      // publishDate is nullable in schema; skip reports without one (no idempotency key).
      if (!r.publishDate) continue;
      const report: GaoReportInput = {
        id: r.id,
        title: r.title,
        summary: r.summary,
        url: r.url,
        publishDate: r.publishDate,
        topics: r.topics,
        agencies: r.agencies,
      };
      const people = await extractor.extractFromReport(report, llmExtract);
      for (const p of people) {
        persons += 1;
        try {
          const result = await writer.upsertPerson(
            { fullName: p.fullName, title: p.title, organization: p.organization ?? undefined },
            GAO_INTERVIEWEE_SOURCE,
            p.sourceUrl,
            p.snippet,
            p.observedAt,
            p.confidence,
          );
          if (result.inserted) inserted += 1;
        } catch (err) {
          errors += 1;
          console.error(`upsert failed for ${p.fullName}: ${String(err)}`);
        }
      }
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'success', rowsInserted: inserted, errorCount: errors },
    });
    console.log(
      JSON.stringify({ source, since: since.toISOString().slice(0, 10), reports, persons, inserted, errors }, null, 2),
    );
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'error', errorCount: errors + 1, errorMessage: String(err) },
    });
    throw err;
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
