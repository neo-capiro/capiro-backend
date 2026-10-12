import { config as dotenvConfig } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';

dotenvConfig();

export type LineageEvidence = {
  sourceDocumentId: string | null;
  file: string;
  locator: string;
  excerpt: string;
};

export type LineageCandidate = {
  fromCode: string;
  toCode: string;
  relType: 'predecessor_successor' | 'same_program';
  status: 'candidate';
  transitionFyFrom: number | null;
  transitionFyTo: number | null;
  evidence: LineageEvidence[];
};

export type LineageFixture = { reason?: string; relationships: LineageCandidate[] };

export function validateLineageFixture(value: unknown): LineageFixture {
  if (!value || typeof value !== 'object' || !Array.isArray((value as LineageFixture).relationships)) {
    throw new Error('Fixture must be an object with a relationships array');
  }
  const fixture = value as LineageFixture;
  for (const [index, row] of fixture.relationships.entries()) {
    if (!row || typeof row !== 'object') throw new Error(`relationships[${index}] must be an object`);
    if (!row.fromCode || !row.toCode) throw new Error(`relationships[${index}] requires fromCode/toCode`);
    if (!['predecessor_successor', 'same_program'].includes(row.relType)) {
      throw new Error(`relationships[${index}] has unsupported relType`);
    }
    if (row.status !== 'candidate') throw new Error(`relationships[${index}] must remain candidate`);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      throw new Error(`relationships[${index}] requires source evidence`);
    }
    for (const evidence of row.evidence) {
      if (!evidence.file || !evidence.locator || !evidence.excerpt) {
        throw new Error(`relationships[${index}] has incomplete evidence`);
      }
    }
  }
  if (fixture.relationships.length === 0 && !fixture.reason) {
    throw new Error('An empty fixture must explain why no relationship is supported');
  }
  return fixture;
}

export function loadLineageFixture(path = resolve('scripts/__data__/lineage/dcgs-020400intl.candidates.json')) {
  return validateLineageFixture(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/seed-budget-line-lineage.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const fixture = loadLineageFixture();
  const commit = process.argv.includes('--commit');
  console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', plannedUpserts: fixture.relationships }, null, 2));
  if (!commit || fixture.relationships.length === 0) return;

  const prisma = new PrismaClient();
  try {
    for (const row of fixture.relationships) {
      const evidenceJson = JSON.parse(JSON.stringify(row.evidence)) as Prisma.InputJsonValue;
      await prisma.budgetLineRelationship.upsert({
        where: { fromPeCode_toPeCode_relType: {
          fromPeCode: row.fromCode.toUpperCase(), toPeCode: row.toCode.toUpperCase(), relType: row.relType,
        } },
        create: {
          fromPeCode: row.fromCode.toUpperCase(), toPeCode: row.toCode.toUpperCase(), relType: row.relType,
          confidence: 'low', status: 'candidate', evidence: row.evidence.map((item) => item.excerpt).join('\n'),
          evidenceJson, transitionFyFrom: row.transitionFyFrom, transitionFyTo: row.transitionFyTo,
          derivedBy: 'seed-budget-line-lineage',
        },
        update: {
          status: 'candidate', evidence: row.evidence.map((item) => item.excerpt).join('\n'), evidenceJson,
          transitionFyFrom: row.transitionFyFrom, transitionFyTo: row.transitionFyTo,
          derivedBy: 'seed-budget-line-lineage',
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
