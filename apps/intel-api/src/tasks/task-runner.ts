/**
 * intel-api one-off `task <verb>` runner (Phase 1).
 *
 * Invoked by the container entrypoint's `task)` arm:
 *   node dist/tasks/task-runner.js <verb> [args...]
 * against the verb-runner task-def family (`capiro-dev-intel-api-enableflag`,
 * container `intel-api-enableflag`) via a `containerOverrides` command. It does
 * NOT boot the Nest HTTP server; it constructs a short-lived Prisma client,
 * runs one verb, and disconnects. Mirrors the inline `enable-feature` verb's
 * lifecycle (lazy connect, `$disconnect()` in `finally`, non-zero exit on error).
 *
 * Verb dispatch (`runVerb`, `verifySourcedata`, `isKnownVerb`) is exported and
 * dependency-injected so it is unit-testable without a DB or Bedrock.
 *
 * Phase 1 verb: `verify-sourcedata <billId>` — the core-enabler gate (plan §4
 * S6): read a real bill, embed it, and cosine-rank against context_embeddings.
 */

import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { EMBEDDING_MODEL, embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';
import { ConfigService } from '@nestjs/config';
import { WatchlistSyncService } from '../watchlist/watchlist-sync.service.js';
import { BillChangeDetectorService } from '../tracker/bill-change-detector.service.js';
import { FeatureFlagService } from '../feature-flags/feature-flag.service.js';
import { IntelAlertService } from '../intel-alert/intel-alert.service.js';
import { IntelEmailService } from '../intel-alert/intel-email.service.js';

/** Build the shadow-guarded alert service for one-off delivery verbs. */
function buildAlertService(prisma: PrismaService): IntelAlertService {
  return new IntelAlertService(prisma, new FeatureFlagService(prisma, new ConfigService()), new IntelEmailService());
}

/** Candidate cosine floor for bill semantic search (ported: EMBED_CANDIDATE_FLOOR). */
export const EMBED_CANDIDATE_FLOOR = 0.3;

export const KNOWN_VERBS = [
  'verify-sourcedata', //          Phase 1 gate
  'sync-watchlists-from-legacy', // Phase 2: legacy → unified watchlist (§5.4)
  'backfill-tracked-bills', //      Phase 2: tracked_bill → intel_tracked_bill
  'backfill-alert-prefs', //        Phase 2: alert_preference → intel_alert_preference
  'disable-feature', //             Phase 2: feature-flag OFF path (§5.0.1)
  'detect-bill-changes', //         Phase 3: shadow change detection → intel_alert (no delivery)
  'emit-bill-alerts', //            Phase 4: fan out NEW intel_alert (SHADOW: suppress+log, no send)
  'flush-digests', //               Phase 4: drain digest queue (SHADOW: no send)
  'shadow-selftest', //             Phase 4: live proof of the shadow suppress path
] as const;
export type Verb = (typeof KNOWN_VERBS)[number];

export function isKnownVerb(v: string): v is Verb {
  return (KNOWN_VERBS as readonly string[]).includes(v);
}

/** Injected dependencies — real in main(), fakes in tests. */
export interface VerbDeps {
  prisma: PrismaService;
  repo: Pick<SourceDataRepository, 'getBillById' | 'semanticBillScores'>;
  embed: (text: string) => Promise<number[]>;
  log: (msg: string) => void;
}

/**
 * `verify-sourcedata <billId>`: proves the two Phase-1 enablers end to end —
 * (1) cross-DB read of a real congress_bill, (2) Titan query embedding, and
 * (3) cosine ranking against the GLOBAL bill embeddings under the capiro_app
 * RLS role. Emits the pass signals asserted by plan §4.4; throws (→ non-zero
 * exit) on any failure or an empty result set.
 */
export async function verifySourcedata(billId: string, deps: VerbDeps): Promise<void> {
  if (!billId) throw new Error('verify-sourcedata requires a <billId> argument (e.g. 119-hr-1)');

  const bill = await deps.repo.getBillById(billId);
  if (!bill) throw new Error(`BILL_NOT_FOUND id=${billId}`);
  deps.log(`BILL_OK id=${bill.id} title="${bill.title ?? ''}"`);

  const queryText = normalize(
    [bill.title, bill.policyArea, (bill.subjects ?? []).join(', ')]
      .filter((p): p is string => Boolean(p && p.length))
      .join('\n'),
  );
  const vec = await deps.embed(queryText);
  deps.log(`EMBED_OK dim=${vec.length} model=${EMBEDDING_MODEL}`);

  const scores = await deps.repo.semanticBillScores(
    vectorLiteral(vec),
    EMBEDDING_MODEL,
    EMBED_CANDIDATE_FLOOR,
  );
  deps.log('SEMANTIC_TOP:');
  for (const s of scores.slice(0, 10)) {
    deps.log(`  ${s.sourceId}\t${s.score.toFixed(4)}`);
  }
  if (scores.length === 0) {
    throw new Error('SEMANTIC_EMPTY (0 rows >= floor) — no bill embeddings matched');
  }
}

/** Route a verb to its handler. Throws on an unknown verb (→ non-zero exit). */
export async function runVerb(verb: string, args: string[], deps: VerbDeps): Promise<void> {
  switch (verb) {
    case 'verify-sourcedata':
      return verifySourcedata(args[0] ?? '', deps);
    case 'sync-watchlists-from-legacy': {
      const r = await new WatchlistSyncService(deps.prisma).syncWatchlists(args[0]);
      deps.log(`SYNC_DONE clients=${r.clients} changed=${r.changed} skipped=${r.skipped} swept=${r.swept}`);
      return;
    }
    case 'backfill-tracked-bills': {
      const r = await new WatchlistSyncService(deps.prisma).backfillTrackedBills(args[0]);
      deps.log(`BACKFILL_TRACKED_BILLS count=${r.count}`);
      return;
    }
    case 'backfill-alert-prefs': {
      const r = await new WatchlistSyncService(deps.prisma).backfillAlertPrefs(args[0]);
      deps.log(`BACKFILL_ALERT_PREFS count=${r.count}`);
      return;
    }
    case 'disable-feature': {
      if (!args[0] || !args[1]) throw new Error('disable-feature requires <flag> <tenantSlugOrId>');
      const r = await new WatchlistSyncService(deps.prisma).setFeatureFlag(args[0], args[1], false);
      deps.log(`FEATURE_DISABLED feature=${r.feature} tenant=${r.tenantId}`);
      return;
    }
    case 'detect-bill-changes': {
      const svc = new BillChangeDetectorService(deps.prisma, new SourceDataRepository(deps.prisma));
      const r = await svc.runDetectionCycle();
      deps.log(
        `DETECT_DONE scanned=${r.scanned} baseline=${r.baseline} changed=${r.changed} ` +
          `alerts=${r.alertsWritten} skippedDedup=${r.skippedDedup} byType=${JSON.stringify(r.byType)}`,
      );
      return;
    }
    case 'emit-bill-alerts': {
      const r = await buildAlertService(deps.prisma).emitNewBillAlerts();
      deps.log(`EMIT_DONE alerts=${r.alerts} suppressed=${r.suppressed} sent=${r.sent}`);
      return;
    }
    case 'flush-digests': {
      const cadence = args[0] === 'weekly' ? 'weekly' : 'daily';
      const r = await buildAlertService(deps.prisma).flushDigests(cadence);
      deps.log(`FLUSH_DONE cadence=${cadence} flushed=${r.flushed} sent=${r.sent}`);
      return;
    }
    case 'shadow-selftest': {
      if (!args[0] || !args[1]) throw new Error('shadow-selftest requires <tenantSlugOrId> <clientId>');
      const tenantId = await new WatchlistSyncService(deps.prisma).resolveTenantId(args[0]);
      if (!tenantId) throw new Error(`NO_TENANT_FOR ${args[0]}`);
      const r = await buildAlertService(deps.prisma).shadowSelftest(tenantId, args[1]);
      deps.log(`SHADOW_SELFTEST suppressed=${r.suppressed} sent=${r.sent}`);
      return;
    }
    default:
      throw new Error(`Unknown task verb: ${verb} (known: ${KNOWN_VERBS.join(', ')})`);
  }
}

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
  if (!verb) {
    console.error(`task <verb> [args]  (known: ${KNOWN_VERBS.join(', ')})`);
    process.exit(1);
  }

  const prisma = new PrismaService();
  const repo = new SourceDataRepository(prisma);
  try {
    await runVerb(verb, args, { prisma, repo, embed: embedText, log: (m) => console.log(m) });
  } catch (e) {
    console.error(`TASK_ERR verb=${verb}: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Auto-run only when executed directly as the container entrypoint target —
// NOT when imported by unit tests (jest is the entry, so require.main !== module).
if (require.main === module) {
  void main();
}
