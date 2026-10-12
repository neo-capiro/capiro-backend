/** @cleanup-smoke noArgsExit=2 */
import { prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
/**
 * Step 32 — extract DoD personnel from press releases (IntelArticle, source='dod').
 *
 *   pnpm --filter @capiro/api extract:press-personnel
 *   tsx scripts/extract-personnel-from-press-releases.ts --hours 24
 *   tsx scripts/extract-personnel-from-press-releases.ts --days 30   # wider backfill
 *
 * Reads recently-synced DoD press releases from IntelArticle (synced by
 * sync-rss-intel.ts as source='dod'), runs an LLM NER pass (Claude via raw fetch to
 * api.anthropic.com — the repo's house pattern; there is no src/llm/ client), then
 * upserts each validated mention via the personnel writer (source='press_release',
 * confidence=0.65). Idempotent: the writer dedups source mentions by observedAt
 * (== article.publishedAt), so re-running the same article adds nothing.
 *
 * NOTE: IntelArticle stores title + summary (no full body — RSS feeds don't provide
 * one), so NER runs over title+summary. Yield is modest by design.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  PressReleasePersonnelExtractorService,
  PRESS_RELEASE_SOURCE,
  PRESS_NER_SYSTEM_PROMPT,
  type PressArticle,
  type LlmMention,
} from '../src/acquisition-personnel/extractors/press-release-personnel-extractor.service.js';
import { AcquisitionPersonnelWriterService } from '../src/acquisition-personnel/acquisition-personnel-writer.service.js';
import { MatchScorerService } from '../src/acquisition-personnel/matching/match-scorer.service.js';

dotenvConfig();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const DOD_SOURCE = 'dod';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Real Claude extractor: raw fetch to Anthropic, parse JSON mentions. */
async function llmExtract(article: PressArticle): Promise<LlmMention[]> {
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
      system: PRESS_NER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: PressReleasePersonnelExtractorService.buildUserPrompt(article) }],
    })),
  });
  const raw = (await res.json()) as { content?: Array<{ text?: string }>; error?: { message?: string } };
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${raw.error?.message ?? 'error'}`);
  const text = (raw.content ?? []).map((b) => b.text ?? '').join('');
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { mentions?: LlmMention[] };
    return parsed.mentions ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const hours = arg('days') ? Number(arg('days')) * 24 : Number(arg('hours') ?? 24);
  const since = new Date(Date.now() - hours * 3600_000);
  const source = 'press_release_ner';

  if (!process.env.DATABASE_URL) {
    console.error('Usage: extract-personnel-from-press-releases [--hours <n> | --days <n>] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const writer = new AcquisitionPersonnelWriterService(prisma, new MatchScorerService(prisma));
  const extractor = new PressReleasePersonnelExtractorService();

  const run = await prisma.syncRun.create({ data: { source, startedAt: new Date(), status: 'running' } });

  let articles = 0;
  let inserted = 0;
  let mentions = 0;
  let errors = 0;

  try {
    const pes = await prisma.programElement.findMany({ select: { peCode: true } });
    const knownPeCodes = new Set<string>(pes.map((p: { peCode: string }) => p.peCode.toUpperCase()));

    const rows = await prisma.intelArticle.findMany({
      where: { source: DOD_SOURCE, publishedAt: { gte: since } },
      orderBy: { publishedAt: 'desc' },
    });
    console.error(`Found ${rows.length} DoD articles since ${since.toISOString()}`);

    for (const r of rows) {
      articles += 1;
      const article: PressArticle = { title: r.title, summary: r.summary, url: r.url, publishedAt: r.publishedAt };
      const people = await extractor.extractFromArticle(article, llmExtract, knownPeCodes);
      for (const p of people) {
        mentions += 1;
        try {
          const result = await writer.upsertPerson(
            {
              fullName: p.fullName,
              organization: p.organization,
              title: p.title,
              role: p.role,
              programOfRecord: p.programOfRecord,
              pePrimary: p.pePrimary,
              peSecondary: p.peSecondary,
              peCodesMentioned: p.pePrimary ? [p.pePrimary, ...p.peSecondary] : p.peSecondary,
            },
            PRESS_RELEASE_SOURCE,
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
    console.log(JSON.stringify({ source, since: since.toISOString(), articles, mentions, inserted, errors }, null, 2));
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
