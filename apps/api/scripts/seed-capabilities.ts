/**
 * seed-capabilities (BL-0): upserts the curated capability taxonomy (§1.6) and
 * runs the deterministic keyword matcher over program_element title +
 * description to produce capability_budget_line_match rows.
 *
 * MATCHING RULES (auditable, never fuzzy):
 *  - Each capability carries a curated keyword list. A keyword hits when it
 *    appears case-insensitively in the line's title or description.
 *  - matchedOn records exactly what hit where ('title:"electronic warfare"'),
 *    so the finder can always answer "why is this line recommended?".
 *  - Title hits are confidence=high, description-only hits confidence=med.
 *  - No hit = no row. Capabilities are grown by editing the seed artifact,
 *    reviewed in the PR — never by unreviewed inference.
 *
 * Regenerable: --commit replaces this verb's derivedBy cohort per capability.
 * Capabilities themselves are upserted by slug (stable across runs).
 *
 *   seed-capabilities --artifact scripts/__data__/corrected_json/capabilities_seed.json [--commit]
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const DERIVED_BY = 'seed-capabilities@v1';

interface SeedCapability {
  slug: string;
  name: string;
  aliases: string[];
  taxonomyPath: string;
  keywords: string[];
}
interface Artifact {
  source?: string;
  capabilities?: SeedCapability[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Case-insensitive containment with a sane boundary: the keyword must not sit
 * inside a longer word (e.g. 'cyber' must not match 'cybernetics' is FINE to
 * match, but 'ew' must not match 'new'). Keywords shorter than 4 chars require
 * hard word boundaries; longer ones use plain containment (they're specific). */
function keywordHit(haystack: string, keyword: string): boolean {
  const h = haystack.toLowerCase();
  const k = keyword.toLowerCase();
  if (k.length >= 4) return h.includes(k);
  const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(haystack);
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error('Usage: seed-capabilities --artifact <capabilities_seed.json> [--commit]');
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const caps = artifact.capabilities ?? [];
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const lines = await prisma.programElement.findMany({
      where: { retiredAt: null },
      select: { peCode: true, title: true, description: true },
    });

    const perCap: Array<{
      cap: SeedCapability;
      matches: Array<{ peCode: string; confidence: string; matchedOn: string }>;
    }> = [];
    for (const cap of caps) {
      const matches: Array<{ peCode: string; confidence: string; matchedOn: string }> = [];
      for (const l of lines) {
        let matchedOn: string | null = null;
        let confidence = 'med';
        for (const k of cap.keywords) {
          if (keywordHit(l.title, k)) {
            matchedOn = `title:"${k}"`;
            confidence = 'high';
            break;
          }
        }
        if (!matchedOn && l.description) {
          for (const k of cap.keywords) {
            if (keywordHit(l.description, k)) {
              matchedOn = `description:"${k}"`;
              confidence = 'med';
              break;
            }
          }
        }
        if (matchedOn) matches.push({ peCode: l.peCode, confidence, matchedOn });
      }
      perCap.push({ cap, matches });
    }

    console.log(
      JSON.stringify(
        {
          verb: DERIVED_BY,
          commit,
          source: artifact.source,
          capabilities: caps.length,
          lines: lines.length,
          perCapability: perCap.map((p) => ({
            slug: p.cap.slug,
            matches: p.matches.length,
            byConfidence: p.matches.reduce<Record<string, number>>((a, m) => {
              a[m.confidence] = (a[m.confidence] ?? 0) + 1;
              return a;
            }, {}),
            samples: p.matches.slice(0, 3).map((m) => `${m.peCode} (${m.matchedOn})`),
          })),
        },
        null,
        2,
      ),
    );

    if (!commit) {
      console.log('DRY RUN — re-run with --commit to write.');
      return;
    }

    for (const { cap, matches } of perCap) {
      const record = await prisma.capability.upsert({
        where: { slug: cap.slug },
        create: {
          slug: cap.slug,
          name: cap.name,
          aliases: cap.aliases,
          taxonomyPath: cap.taxonomyPath,
        },
        update: { name: cap.name, aliases: cap.aliases, taxonomyPath: cap.taxonomyPath },
      });
      await prisma.$transaction(async (tx) => {
        await tx.capabilityBudgetLineMatch.deleteMany({
          where: { capabilityId: record.id, derivedBy: DERIVED_BY },
        });
        for (let i = 0; i < matches.length; i += 1000) {
          await tx.capabilityBudgetLineMatch.createMany({
            data: matches.slice(i, i + 1000).map((m) => ({
              capabilityId: record.id,
              peCode: m.peCode,
              confidence: m.confidence,
              matchedOn: m.matchedOn,
              status: 'accepted',
              derivedBy: DERIVED_BY,
            })),
            skipDuplicates: true,
          });
        }
      });
    }
    console.log(JSON.stringify({ written: perCap.reduce((s, p) => s + p.matches.length, 0) }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
