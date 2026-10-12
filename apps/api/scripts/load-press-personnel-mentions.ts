/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeName } from '../src/acquisition-personnel/normalization/name-normalizer.js';

/**
 * Conservative loader for staged DoD press/news personnel mentions.
 *
 * Input: tmp/press-personnel/press-personnel-mentions.json (produced by
 *   sync-dod-press-personnel.ts). Each mention: { source, articleUrl,
 *   articleTitle, fullName, title, organization, confidence, contextQuote }.
 *
 * Policy (approved):
 *   - Drop confidence < 0.75 outright (noise tier).
 *   - Reject names that fail normalization (empty/fragment nameKey, title-word
 *     leading token, < 2 real tokens) -> quarantine.
 *   - MATCH-FIRST via writer.upsertPerson: if an existing person matches
 *     (scorer >= 0.92) it only refreshes last_seen_at + adds a news source
 *     citation. No new row.
 *   - CREATE-new ONLY when confidence >= 0.95 AND valid name AND organization
 *     present. Records in [0.75, 0.95) that do NOT match an existing person are
 *     quarantined (never created).
 *   - Every change records the article URL as the source citation (provenance).
 *
 * Pass --dry-run for a read-only evaluation or --commit to write.
 * Pass --threshold-create=0.95 to override the create bar.
 */

interface Mention {
  source: string;
  articleUrl: string;
  articleTitle?: string;
  fullName: string;
  title?: string | null;
  organization?: string | null;
  confidence: number;
  contextQuote?: string | null;
}

const TITLE_WORDS = new Set([
  'under', 'secretary', 'assistant', 'deputy', 'director', 'officer', 'meeting',
  'release', 'policy', 'office', 'command', 'program', 'with', 'and', 'the',
  'delegations', 'minister', 'defence', 'defense', 'military', 'chief', 'head',
  'spokesman', 'spokesperson', 'readout', 'statement', 'remarks',
]);

const MIN_CONFIDENCE = 0.75;

function parseFlags() {
  const usage = 'Usage: tsx scripts/load-press-personnel-mentions.ts [--dry-run|--commit] [--threshold-create=NUMBER] (at least one option)';
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  if (
    argv.length === 0 ||
    argv.some((arg) =>
      arg !== '--dry-run' && arg !== '--commit' && !/^--threshold-create=\d*\.?\d+$/.test(arg),
    ) ||
    (argv.includes('--dry-run') && argv.includes('--commit'))
  ) {
    console.error(usage);
    process.exit(2);
  }
  const commit = argv.includes('--commit');
  let createThreshold = 0.95;
  for (const a of argv) {
    const m = a.match(/^--threshold-create=(\d*\.?\d+)$/);
    if (m) createThreshold = Number.parseFloat(m[1]!);
  }
  return { commit, createThreshold };
}

// A mention name is "valid" if the normalizer yields a real nameKey with a
// plausible person shape and the leading token is not a title/role word.
function isValidPersonName(fullName: string): boolean {
  const raw = (fullName ?? '').trim();
  if (!raw) return false;
  if (/[[\]()/:0-9#!]/.test(raw)) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  const lead = tokens[0]!.toLowerCase().replace(/[.,]/g, '');
  if (TITLE_WORDS.has(lead)) return false;
  // require >=2 capitalized tokens (proper-noun shape)
  const caps = tokens.filter((t) => /^[A-Z]/.test(t)).length;
  if (caps < 2) return false;
  const normalized = normalizeName(raw);
  if (!normalized.nameKey || normalized.nameKey.split(/\s+/).length < 2) return false;
  // reject if any normalized token is a title word
  if (normalized.nameKey.split(/\s+/).some((t) => TITLE_WORDS.has(t.toLowerCase()))) return false;
  return true;
}

function serviceFromSource(source: string): string | null {
  if (source.startsWith('army')) return 'ARMY';
  if (source.startsWith('navy')) return 'NAVY';
  if (source.startsWith('af_') || source.startsWith('af')) return 'AF';
  if (source.startsWith('spaceforce')) return 'SF';
  if (source.startsWith('marines')) return 'USMC';
  if (source.startsWith('darpa')) return 'DARPA';
  if (source.startsWith('dla') || source.startsWith('dtra') || source.startsWith('mda') || source.startsWith('dod') || source.startsWith('defense')) return 'DW';
  return null;
}

async function main() {
  const { commit, createThreshold } = parseFlags();
  dotenvConfig();
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { MatchScorerService } = await import('../src/acquisition-personnel/matching/match-scorer.service.js');
  const { AcquisitionPersonnelWriterService } = await import('../src/acquisition-personnel/acquisition-personnel-writer.service.js');
  const filePath = path.resolve('tmp/press-personnel/press-personnel-mentions.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { generatedAt?: string; mentions: Mention[] };
  const mentions = raw.mentions ?? [];
  const observedAt = raw.generatedAt ? new Date(raw.generatedAt) : new Date();

  const stats = {
    total: mentions.length,
    dropped_low_conf: 0,
    rejected_invalid_name: 0,
    matched_refreshed: 0,
    created_new: 0,
    quarantined_no_match: 0,
    errors: 0,
  };

  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const matcher = new MatchScorerService(prisma);
  const writer = new AcquisitionPersonnelWriterService(prisma, matcher);

  try {
    for (const m of mentions) {
      const conf = Number(m.confidence) || 0;
      if (conf < MIN_CONFIDENCE) { stats.dropped_low_conf++; continue; }
      if (!isValidPersonName(m.fullName)) {
        stats.rejected_invalid_name++;
        if (commit) await writer.quarantine(m, 'invalid/fragment name from press mention', m.source);
        continue;
      }

      const source = `dod_press_${serviceFromSource(m.source) ?? 'dw'}`.toLowerCase();
      const sourceUrl = m.articleUrl;
      const snippet = (m.contextQuote ?? '').slice(0, 1000) || null;

      // Find existing match first (match-and-refresh path).
      const matches = await matcher.findMatches({
        fullName: m.fullName,
        organization: m.organization ?? undefined,
        title: m.title ?? undefined,
      });
      const top = matches[0];

      if (top && top.score >= 0.92) {
        if (commit) await writer.addSourceMention(top.personId, source, sourceUrl, snippet ?? undefined, observedAt, conf);
        stats.matched_refreshed++;
        continue;
      }

      // No strong match -> only CREATE when high-confidence + org present.
      if (conf >= createThreshold && (m.organization ?? '').trim()) {
        if (commit) {
          try {
            await writer.upsertPerson(
              {
                fullName: m.fullName,
                organization: m.organization ?? null,
                title: m.title ?? null,
                service: serviceFromSource(m.source) ?? undefined,
                publicProfileUrl: sourceUrl,
              } as never,
              source,
              sourceUrl,
              snippet ?? undefined,
              observedAt,
              conf,
            );
          } catch {
            stats.errors++;
            continue;
          }
        }
        stats.created_new++;
        continue;
      }

      // [0.75, createThreshold) with no match -> quarantine, never create.
      stats.quarantined_no_match++;
      if (commit) await writer.quarantine(m, `press mention below create threshold (${conf}) with no match`, m.source);
    }

    console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', createThreshold, stats }, null, 2));
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((e) => { console.error('[load-press-personnel] fatal', e?.stack || e); process.exit(1); });
