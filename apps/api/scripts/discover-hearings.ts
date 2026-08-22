/**
 * LegiWatch Live Hearings — canonical hearing discovery job (Phase 3).
 *
 *   pnpm --filter @capiro/api discover:hearings -- --source=congress-gov
 *   pnpm --filter @capiro/api discover:hearings -- --source=senate-schedule --dry-run
 *
 * Registers/refreshes the `committee_source` rows for the selected source, runs
 * its adapter against the real official feed, and reconciles every observed
 * event into the canonical corpus (observation ledger → deterministic identity →
 * projection → additive write + change feed).
 *
 * One job, one source, selected by `--source`, so each gets its own EventBridge
 * rule and its own cadence (see infra/cdk/lib/ingestion-schedule.ts) instead of
 * one giant cron whose failure hides which feed actually broke.
 *
 * `--dry-run` exercises the adapter and the identity/projection logic and prints
 * what WOULD be written, without touching the database. That is the mode used to
 * verify a parser against a live official source from a workstation, since the
 * Aurora cluster is private-subnet and only reachable from ECS.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { CommitteeSourceRepository } from '../src/hearing-discovery/committee-source.repository.js';
import { HearingReconcilerService } from '../src/hearing-discovery/hearing-reconciler.service.js';
import { SourceRegistryService } from '../src/hearing-discovery/source-registry.service.js';
import {
  CONGRESS_BASE,
  CongressGovAdapter,
  currentCongress,
} from '../src/hearing-discovery/adapters/congress-gov.adapter.js';
import { HouseRepositoryAdapter } from '../src/hearing-discovery/adapters/house-repository.adapter.js';
import {
  SENATE_SCHEDULE_URL,
  SenateScheduleAdapter,
} from '../src/hearing-discovery/adapters/senate-schedule.adapter.js';
import { HOUSE_DOCS_BASE } from '../src/hearing-discovery/adapters/house-docs-parse.js';
import { canonicalHearingId } from '../src/hearing-discovery/hearing-identity.js';
import type {
  CommitteeSourceAdapter,
  DiscoveryContext,
  SourceDescriptor,
  SourceEvent,
} from '../src/hearing-discovery/hearing-discovery.types.js';

dotenvConfig();

const ADAPTER_KEYS = ['congress-gov', 'house-repository', 'senate-schedule'] as const;
type AdapterKey = (typeof ADAPTER_KEYS)[number];

/** Canonical official URL per source, mirroring what the registry seeds. */
const DEFAULT_SOURCE_URL: Record<AdapterKey, string> = {
  'congress-gov': `${CONGRESS_BASE}/committee-meeting`,
  'house-repository': `${HOUSE_DOCS_BASE}/ByDay.aspx`,
  'senate-schedule': SENATE_SCHEDULE_URL,
};

interface Flags {
  source: AdapterKey;
  dryRun: boolean;
  daysAhead: number;
  delayMs: number;
  maxPages: number;
  listLimit: number;
  limit: number | null;
  congress: number;
  /** Ignore the SyncRun watermark and rescan the full window. */
  full: boolean;
}

function parseFlags(argv: string[]): Flags {
  const map = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m && m[1]) map.set(m[1], m[2] ?? 'true');
  }
  const source = (map.get('source') ?? 'congress-gov') as AdapterKey;
  if (!ADAPTER_KEYS.includes(source)) {
    throw new Error(`--source must be one of: ${ADAPTER_KEYS.join(', ')} (got "${source}")`);
  }
  const num = (key: string, fallback: number): number => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} must be a non-negative number`);
    return n;
  };
  return {
    source,
    dryRun: map.get('dry-run') === 'true',
    daysAhead: num('days-ahead', Number(process.env.HEARING_DISCOVERY_DAYS_AHEAD ?? 21)),
    delayMs: num('delay-ms', Number(process.env.HEARING_DISCOVERY_DELAY_MS ?? 150)),
    maxPages: num('max-pages', Number(process.env.HEARING_DISCOVERY_MAX_PAGES ?? 8)),
    listLimit: num('list-limit', Number(process.env.HEARING_DISCOVERY_LIST_LIMIT ?? 250)),
    limit: map.has('limit') ? num('limit', 0) : null,
    congress: num('congress', currentCongress()),
    full: map.get('full') === 'true',
  };
}

/** Build the adapter for a source key, wired to our own committee registry. */
async function buildAdapter(
  key: AdapterKey,
  registry: SourceRegistryService,
  flags: Flags,
): Promise<CommitteeSourceAdapter> {
  if (key === 'congress-gov') {
    const resolveCommitteeName = await registry.committeeNameResolver();
    return new CongressGovAdapter({
      apiKey: process.env.CONGRESS_API_KEY ?? '',
      congresses: [flags.congress],
      maxPages: flags.maxPages,
      listLimit: flags.listLimit,
      resolveCommitteeName,
    });
  }
  if (key === 'house-repository') {
    const resolveSystemCodeByName = await registry.systemCodeByNameResolver('house');
    return new HouseRepositoryAdapter({ congress: flags.congress, resolveSystemCodeByName });
  }
  const resolveCommitteeName = await registry.committeeNameResolver();
  return new SenateScheduleAdapter({ congress: flags.congress, resolveCommitteeName });
}

function summarize(events: SourceEvent[], adapterKey: string): void {
  const withTime = events.filter((e) => e.startsAt != null).length;
  const withCommittee = events.filter((e) => e.committeeSystemCode != null).length;
  const withStream = events.filter((e) => (e.streamCandidates ?? []).length > 0).length;
  const priv = events.filter((e) => e.visibility === 'private').length;
  console.log(
    `[discover-hearings] ${adapterKey}: ${events.length} events | ${withTime} timed | ` +
      `${withCommittee} with system code | ${withStream} with advertised stream | ${priv} closed-session`,
  );
  for (const e of events.slice(0, 10)) {
    console.log(
      `  · ${canonicalHearingId(e, adapterKey)}  ${e.calendarDate?.toISOString().slice(0, 10) ?? '?'} ` +
        `${e.displayTime ?? '(no time)'}  [${e.committeeSystemCode ?? 'no-code'}] ` +
        `${(e.title ?? '(untitled)').slice(0, 78)}`,
    );
  }
  if (events.length > 10) console.log(`  … ${events.length - 10} more`);
}

/**
 * DB-free live verification. Runs the real adapter against the real official
 * source and prints what it found plus the canonical id each event WOULD take.
 * Deliberately constructs no PrismaClient at all: the Aurora cluster is
 * private-subnet (ECS-only), so this is the only mode that can prove a parser
 * against a live feed from a workstation. The committee-name resolver is absent
 * here, so committee display names come from the feed rather than our registry —
 * that difference is printed rather than hidden.
 */
async function runDryRun(flags: Flags): Promise<void> {
  const nullRegistry = {
    committeeNameResolver: async () => () => null,
    systemCodeByNameResolver: async () => () => null,
  } as unknown as SourceRegistryService;
  const adapter = await buildAdapter(flags.source, nullRegistry, flags);
  const source: SourceDescriptor = {
    id: 'dry-run',
    committeeSystemCode: null,
    chamber:
      flags.source === 'senate-schedule'
        ? 'senate'
        : flags.source === 'house-repository'
          ? 'house'
          : 'joint',
    sourceType:
      flags.source === 'congress-gov'
        ? 'CONGRESS_GOV'
        : flags.source === 'house-repository'
          ? 'HOUSE_REPOSITORY'
          : 'SENATE_SCHEDULE',
    // The real official URL, not a placeholder: adapters legitimately prefer
    // `source.sourceUrl` over their built-in default, so a stub value here
    // would make the dry run fetch nothing (found exactly that way).
    sourceUrl: DEFAULT_SOURCE_URL[flags.source],
    adapterKey: adapter.adapterKey,
    priority: 10,
    parserVersion: adapter.parserVersion,
  };
  const ctx: DiscoveryContext = {
    since: null,
    daysAhead: flags.daysAhead,
    delayMs: flags.delayMs,
    log: (msg) => console.log(msg),
  };
  if (adapter.healthCheck) {
    const health = await adapter.healthCheck(source, ctx);
    console.log(
      `[discover-hearings] healthCheck ok=${health.ok} status=${health.status ?? '-'} ` +
        `durationMs=${health.durationMs ?? '-'} observed=${health.observedEvents ?? '-'} ` +
        `error=${health.error ?? 'none'}`,
    );
  }
  let events = await adapter.discoverEvents(source, ctx);
  if (flags.limit != null) events = events.slice(0, flags.limit);
  summarize(events, adapter.adapterKey);
  console.log('[discover-hearings] DRY RUN — no database connection was opened');
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const started = Date.now();
  if (flags.dryRun) {
    console.log(
      `[discover-hearings] source=${flags.source} congress=${flags.congress} ` +
        `daysAhead=${flags.daysAhead} DRY-RUN (no DB)`,
    );
    await runDryRun(flags);
    console.log(`[discover-hearings] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return;
  }
  const prisma = new PrismaClient();
  console.log(
    `[discover-hearings] source=${flags.source} congress=${flags.congress} ` +
      `daysAhead=${flags.daysAhead}`,
  );

  try {
    await runWithSyncRun(
      prisma as never,
      `discover-hearings-${flags.source}`,
      async ({ since }) => {
        const registry = new SourceRegistryService(prisma);
        const sourceRepo = new CommitteeSourceRepository(prisma);
        const adapter = await buildAdapter(flags.source, registry, flags);

        // Central sources are chamber-wide and idempotent to (re-)register.
        const central = await registry.ensureCentralSources(flags.congress);
        const source =
          central.find((s) => s.adapterKey === flags.source) ??
          (await sourceRepo.listEnabled({ adapterKey: flags.source }))[0];
        if (!source) throw new Error(`no committee_source registered for ${flags.source}`);

        const ctx: DiscoveryContext = {
          since: flags.full ? null : since,
          daysAhead: flags.daysAhead,
          delayMs: flags.delayMs,
          log: (msg) => console.log(msg),
        };

        const now = new Date();
        await sourceRepo.markChecked(source.id, now);
        let events: SourceEvent[];
        try {
          events = await adapter.discoverEvents(source, ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Record the failure against the source BEFORE rethrowing, so the
          // coverage dashboard shows a failing feed even when the job dies.
          await sourceRepo.recordOutcome(source.id, { ok: false, error: message }, now);
          throw err;
        }
        if (flags.limit != null) events = events.slice(0, flags.limit);
        summarize(events, adapter.adapterKey);

        await sourceRepo.recordOutcome(
          source.id,
          { ok: true, observedEvents: events.length },
          now,
          adapter.parserVersion,
        );

        const reconciler = new HearingReconcilerService(prisma);
        const { totals } = await reconciler.reconcileBatch(source, events, now, (m) =>
          console.log(m),
        );
        console.log(
          `[discover-hearings] reconciled: created=${totals.hearingsCreated} ` +
            `updated=${totals.hearingsUpdated} observations=+${totals.observationsCreated}/` +
            `~${totals.observationsChanged} siteUpdates=${totals.siteUpdates} ` +
            `streamCandidates=${totals.streamCandidates} errors=${totals.errors} ` +
            `matches=${JSON.stringify(totals.matches)}`,
        );
        return {
          inserted: totals.hearingsCreated,
          updated: totals.hearingsUpdated,
          skipped: totals.events - totals.hearingsCreated - totals.hearingsUpdated,
          errors: totals.errors,
        };
      },
      // One instance per source: a slow run plus the next 10-minute tick must
      // not double-scan the same feed.
      { skipIfRunning: true },
    );
  } finally {
    await prisma.$disconnect();
  }
  console.log(`[discover-hearings] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[discover-hearings] FAILED', err);
    process.exit(1);
  });
}
