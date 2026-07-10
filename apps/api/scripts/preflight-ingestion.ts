/**
 * Pre-flight check for the ingestion pipeline. Reports which external API keys
 * are present vs missing, classified by whether the dependent sync HARD-requires
 * the key (the script throws without it) or merely degrades (keyless/rate-limited).
 *
 *   tsx scripts/preflight-ingestion.ts            # human report, exit 1 if a REQUIRED key is missing
 *   tsx scripts/preflight-ingestion.ts --json     # machine-readable
 *   tsx scripts/preflight-ingestion.ts --warn-only # never exit non-zero
 *
 * Run this BEFORE a backfill (scripts/backfill-all.ts) or before creating the
 * EventBridge schedules, so a missing key fails fast instead of mid-run.
 *
 * Key classifications are derived from the actual scripts (verified 2026-06-01):
 *   REQUIRED (script throws): FEC_API_KEY, OPENSTATES_API_KEY, SAM_GOV_API_KEY,
 *     OPENAI_API_KEY (generate-briefings).
 *   RECOMMENDED (degrades/rate-limited without it): CONGRESS_API_KEY,
 *     REGULATIONS_GOV_API_KEY, LDA_API_KEY, FIRECRAWL_API_KEY (PE url discovery),
 *     ANTHROPIC_API_KEY (clio/briefings fallback).
 *   Embeddings use the ECS task role for Bedrock — no key (EMBEDDINGS_MODEL optional).
 */
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  checkBudgetReconciliation,
  type ControlTotals,
} from '../src/program-element/reconciliation/budget-reconciliation.js';

interface KeyCheck {
  env: string;
  level: 'required' | 'recommended';
  usedBy: string;
  note: string;
}

const KEYS: KeyCheck[] = [
  {
    env: 'FEC_API_KEY',
    level: 'required',
    usedBy: 'sync-fec, sync-fec-pac',
    note: 'script throws without it',
  },
  {
    env: 'OPENSTATES_API_KEY',
    level: 'required',
    usedBy: 'sync-openstates',
    note: 'script throws without it',
  },
  {
    env: 'LEGISCAN_API_KEY',
    level: 'required',
    usedBy: 'backfill-legiscan-datasets, sync-legiscan-masterlist, sync-legiscan-bills',
    note: 'script throws without it',
  },
  {
    env: 'SAM_GOV_API_KEY',
    level: 'required',
    usedBy: 'sync-sam-personnel',
    note: 'script throws without it',
  },
  {
    env: 'OPENAI_API_KEY',
    level: 'required',
    usedBy: 'generate-briefings',
    note: 'briefings abort without it',
  },
  {
    env: 'CONGRESS_API_KEY',
    level: 'recommended',
    usedBy: 'sync-congress',
    note: 'keyless = heavy rate limiting',
  },
  {
    env: 'REGULATIONS_GOV_API_KEY',
    level: 'recommended',
    usedBy: 'sync-regulations',
    note: 'warns + likely throttled without it',
  },
  {
    env: 'LDA_API_KEY',
    level: 'recommended',
    usedBy: 'sync-lda',
    note: 'adds auth header if present; higher limits',
  },
  {
    env: 'FIRECRAWL_API_KEY',
    level: 'recommended',
    usedBy: 'PE .mil URL discovery (jbooks/orgcharts)',
    note: 'WAF unlock for finding source URLs',
  },
  {
    env: 'ANTHROPIC_API_KEY',
    level: 'recommended',
    usedBy: 'clio, briefings fallback',
    note: 'LLM features degrade without it',
  },
];

const { values } = parseArgs({
  options: {
    json: { type: 'boolean' },
    'warn-only': { type: 'boolean' },
    'skip-data': { type: 'boolean' },
  },
});

function present(env: string): boolean {
  const v = process.env[env];
  return typeof v === 'string' && v.trim().length > 0;
}

const CONTROL_TOTALS_PATH = path.resolve('scripts/__data__/control_totals.json');

interface DataIntegrity {
  ran: boolean;
  ok: boolean;
  reason?: string;
  failed?: number;
  skipped?: number;
  failingGroups?: Array<{
    fy: number;
    cycle: string;
    component: string;
    field: string;
    extracted: number;
    control: number | null;
  }>;
}

/**
 * Budget extraction-totals check (Step 0.2). Advisory + graceful: runs only when a DB and a
 * committed control_totals.json are present, and treats infra problems (DB unreachable, schema
 * not migrated) as SKIP — never blocks on infrastructure. A genuine totals divergence (a broken
 * PE load) returns ok=false, which fails the pre-flight unless --warn-only.
 */
async function runDataIntegrity(): Promise<DataIntegrity> {
  if (values['skip-data']) return { ran: false, ok: true, reason: 'skipped via --skip-data' };
  if (!present('DATABASE_URL'))
    return { ran: false, ok: true, reason: 'no DATABASE_URL (data check skipped)' };
  if (!fs.existsSync(CONTROL_TOTALS_PATH)) {
    return { ran: false, ok: true, reason: 'no control_totals.json (data check skipped)' };
  }
  let prisma: PrismaClient | undefined;
  try {
    const control = JSON.parse(fs.readFileSync(CONTROL_TOTALS_PATH, 'utf-8')) as ControlTotals;
    prisma = new PrismaClient();
    await prisma.$connect();
    const res = await checkBudgetReconciliation(prisma as never, control);
    return {
      ran: true,
      ok: res.ok,
      failed: res.failed,
      skipped: res.skipped,
      failingGroups: res.results
        .filter((r) => r.status === 'FAIL')
        .map((r) => ({
          fy: r.fiscalYear,
          cycle: r.budgetCycle,
          component: r.component,
          field: r.field,
          extracted: r.extractedMillions,
          control: r.controlMillions,
        })),
    };
  } catch (err) {
    return {
      ran: false,
      ok: true,
      reason: `data check skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const results = KEYS.map((k) => ({ ...k, present: present(k.env) }));
  const missingRequired = results.filter((r) => r.level === 'required' && !r.present);
  const missingRecommended = results.filter((r) => r.level === 'recommended' && !r.present);
  const data = await runDataIntegrity();

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ok: missingRequired.length === 0 && data.ok,
          missingRequired: missingRequired.map((r) => r.env),
          missingRecommended: missingRecommended.map((r) => r.env),
          results,
          dataIntegrity: data,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('=== Ingestion pre-flight: external API keys ===\n');
    for (const r of results) {
      const mark = r.present ? 'OK  ' : r.level === 'required' ? 'MISS' : 'warn';
      console.log(`[${mark}] ${r.env.padEnd(24)} (${r.level})  ${r.usedBy}`);
      if (!r.present) console.log(`        -> ${r.note}`);
    }
    console.log('');
    if (missingRequired.length > 0) {
      console.log(
        `FAIL: ${missingRequired.length} REQUIRED key(s) missing: ${missingRequired.map((r) => r.env).join(', ')}`,
      );
      console.log(
        'Create each as a secret (capiro/dev/<name>, no leading slash) and wire into the task env.',
      );
    } else {
      console.log('PASS: all required keys present.');
    }
    if (missingRecommended.length > 0) {
      console.log(
        `Note: ${missingRecommended.length} recommended key(s) missing (degraded, not fatal): ${missingRecommended.map((r) => r.env).join(', ')}`,
      );
    }

    console.log('\n=== Data integrity: budget reconciliation ===');
    if (!data.ran) {
      console.log(`[skip] ${data.reason}`);
    } else if (data.ok) {
      console.log(
        `[OK  ] budget totals reconcile (${data.skipped ?? 0} group(s) skipped, no control total).`,
      );
    } else {
      console.log(`[FAIL] ${data.failed} budget group(s) diverge from control totals:`);
      for (const g of data.failingGroups ?? []) {
        console.log(
          `        FY${g.fy} ${g.cycle}/${g.component} ${g.field}: extracted ${g.extracted} vs control ${g.control}`,
        );
      }
      console.log('        -> a PE load is broken; run verify:budget-reconciliation for detail.');
    }
  }

  const hardFail = missingRequired.length > 0 || (data.ran && !data.ok);
  if (!values['warn-only'] && hardFail) {
    process.exit(1);
  }
}

void main();
