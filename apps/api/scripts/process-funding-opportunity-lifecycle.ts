/**
 * Emit deterministic internal alerts for tracked funding opportunities. Dry-run by
 * default; --commit writes.
 *
 * ── What this pass may and may not alert about ───────────────────────────────
 *
 * Alerts go ONLY to rows a human is tracking (`saved`, `pursuing`). That is not a
 * throttle, it is the difference between a notification and noise:
 *
 *
 * The previous implementation gated only `closing_soon` on human tracking, so
 * `deadline_changed`, `amended` and `cancelled_or_closed` fired for every status
 * including dismissed and expired rows.
 *
 * ── Baselines ───────────────────────────────────────────────────────────────
 *
 * A row with no stored fingerprint has never been observed by this pass. It gets
 * a SILENT baseline: snapshots are written, no alerts are emitted, and change
 * detection starts from the next run.
 *
 * Without that rule the first run after deployment alerts on every tracked row in
 * every tenant, because "no previous value" compares unequal to every present
 * value. The old code half-had this by accident — `deadline_changed` required
 * both deadlines to be non-null, which suppressed the first-run alert but ALSO
 * permanently suppressed the two changes that matter most (a deadline being
 * added, and a deadline being withdrawn) — while `cancelled_or_closed`
 * reconstructed `previousActive` from an empty status string as TRUE, so a legacy
 * row whose source was already closed fired a spurious closure alert.
 *
 * ── Coverage ────────────────────────────────────────────────────────────────
 *
 * Every row is processed. The previous implementation took one capped 5,000-row
 * window per tenant and, on hitting the cap, incremented the run's ERROR COUNT
 * and logged a warning — so past 5,000 tracked rows the pass was silently partial
 * and the only symptom was a degraded run status. This walks the whole table by
 * keyset cursor.
 */
import { createHash } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { runWithSyncRun, emptyCounts, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
} from '../src/funding-opportunities/funding-opportunities-flag.guard.js';
import { isTopicClosed } from '../src/funding-opportunities/source-lifecycle.js';
import {
  grantSourceFingerprint,
  isGrantActive,
  isSamActive,
  samSourceFingerprint,
  type GrantLifecycleFacts,
  type SamLifecycleFacts,
} from '../src/funding-opportunities/source-lifecycle.js';

dotenvConfig();

const SOURCE = 'process-funding-opportunity-lifecycle';
/** Keyset page size. Bounded per query, unbounded in total. */
const PAGE_SIZE = 500;
const CLOSING_SOON_DAYS = 14;

/**
 * The only statuses that may receive an alert. See the header — this is the
 * "notification vs noise" line, not a rate limit.
 */
const ALERTABLE_STATUSES: ReadonlySet<string> = new Set(['saved', 'pursuing']);

export type LifecycleEventType =
  | 'deadline_changed'
  | 'amended'
  | 'cancelled_or_closed'
  | 'closing_soon';

export interface LifecycleSnapshot {
  status: string | null;
  deadline: Date | null;
  /** Source-published modification time. Never a local sync clock. */
  updatedAt: Date | null;
  /** `null` = no baseline recorded yet. NOT the same as `false`. */
  active: boolean | null;
  /** `null` = no baseline recorded yet. Presence is what ends the baseline state. */
  fingerprint: string | null;
}

export interface LifecycleEvent {
  type: LifecycleEventType;
  title: string;
  body: string;
  fingerprint: string;
}

export interface LifecycleDecision {
  events: LifecycleEvent[];
  /** True when this observation only established a baseline. Always alert-free. */
  baseline: boolean;
}

function iso(value: Date | null): string {
  return value?.toISOString() ?? 'none';
}
function describeDeadline(value: Date | null): string {
  return value ? value.toISOString() : 'no stated deadline';
}

/**
 * Decide what — if anything — to tell a human about one tracked opportunity.
 *
 * ── Why the FINGERPRINT decides "amended", and the reasons only describe it ──
 *
 * Only four snapshot columns are stored per tracked row (status, deadline,
 * source-modified-at, plus the fingerprint and active flag). So the previous
 * SOURCE FACTS cannot be fully reconstructed — a reconstruction leaves every
 * unstored field null, and comparing null against a real value reports "changed"
 * on every single run. That is the original alert-spam bug wearing a different
 * hat, and it is exactly what an earlier draft of this file did.
 *
 * The fingerprint is the authoritative gate because it is COMPLETE (it hashes
 * every source field) and it is STORED (so the comparison is exact, not
 * reconstructed). `revisionReasons` is best-effort narration derived only from
 * the columns that genuinely are snapshotted; when the fingerprint moved and
 * nothing nameable explains it, the alert says so plainly rather than inventing
 * a field name.
 */
export function deriveLifecycleEvents(input: {
  title: string;
  source?: string;
  humanDecision?: string | null;
  workflowStatus: string;
  previous: LifecycleSnapshot;
  current: LifecycleSnapshot;
  /**
   * Nameable, source-backed reasons drawn ONLY from snapshotted fields. May be
   * empty while the source genuinely changed — see the header.
   */
  revisionReasons: string[];
  now: Date;
}): LifecycleDecision {
  const { title, workflowStatus, previous, current, revisionReasons, now } = input;

  // ── Baseline: first observation of this row. Snapshots are written by the
  // caller; nothing is announced. Keyed on the FINGERPRINT rather than on any
  // individual snapshot column, because the fingerprint is the one field that is
  // null if and only if this pass has never seen the row.
  if (previous.fingerprint == null) return { events: [], baseline: true };

  // ── Alertability. Checked before any event is constructed so that a
  // non-alertable row costs nothing and cannot leak an alert through a branch
  // added later.
  const terminal = ['dismissed', 'won', 'lost', 'expired'].includes(workflowStatus);
  const tracked =
    ALERTABLE_STATUSES.has(workflowStatus) ||
    input.humanDecision === 'monitor' ||
    input.humanDecision === 'pursue';
  if (terminal || input.humanDecision === 'pass' || !tracked)
    return { events: [], baseline: false };

  const events: LifecycleEvent[] = [];

  // Deadline change, INCLUDING date → null and null → date.
  //
  // The old predicate was `previous.deadline && current.deadline && times
  // differ`, which silently ignored both of those transitions. A withdrawn
  // deadline ("responses accepted continuously" replacing a fixed date) and a
  // newly-published one are the two changes most likely to alter what a bid team
  // does this week.
  const forecast = input.source === 'agency_forecast';
  const previousDeadline = forecast ? null : (previous.deadline?.getTime() ?? null);
  const currentDeadline = forecast ? null : (current.deadline?.getTime() ?? null);
  if (previousDeadline !== currentDeadline) {
    events.push({
      type: 'deadline_changed',
      title: `Deadline changed: ${title}`,
      body:
        `The response deadline changed from ${describeDeadline(previous.deadline)} to ` +
        `${describeDeadline(current.deadline)}.`,
      fingerprint: `${iso(previous.deadline)}:${iso(current.deadline)}`,
    });
  }

  // Closure. `previous.active === true` explicitly, not truthiness: `null` means
  // no baseline, and the baseline guard above has already returned for that case,
  // but writing it as an identity keeps the intent unambiguous.
  const closed = previous.active === true && current.active === false;
  if (closed) {
    events.push({
      type: 'cancelled_or_closed',
      title: `${forecast ? 'Forecast inactive' : 'Opportunity closed'}: ${title}`,
      body: `The source now reports this opportunity as ${current.status ?? 'closed or inactive'}.`,
      fingerprint: `${current.status ?? 'inactive'}:${iso(current.deadline)}`,
    });
  }

  // ── Amendment.
  //
  // Gated on the fingerprint, which is complete and stored. Emitted when the
  // source moved AND either something nameable explains it, or NO other event
  // does — so a pure content rewrite is always reported, while "the deadline
  // moved" is not also announced a second time as a bare "this was updated".
  const sourceChanged = previous.fingerprint !== current.fingerprint;
  const alreadyExplained = previousDeadline !== currentDeadline || closed;
  if (sourceChanged && (revisionReasons.length > 0 || !alreadyExplained)) {
    events.push({
      type: 'amended',
      title: `${forecast ? 'Agency forecast updated' : 'Opportunity updated'}: ${title}`,
      body: forecast
        ? 'The agency updated its purchasing plan. Review the current scope, contact details and estimated timing; these estimates are not response deadlines.'
        : revisionReasons.length
          ? `The source published a change: ${revisionReasons.join(' ')} Review the source notice for the full amendment.`
          : 'The source record changed since Capiro last evaluated this opportunity. The changed field is not one Capiro snapshots, so review the source notice for the amendment.',
      // Keyed on the new fingerprint, so a SECOND, different amendment alerts
      // again while a re-run over the same amendment does not. Using the reasons
      // here instead would collapse two distinct amendments that happen to
      // produce the same narration.
      fingerprint: current.fingerprint ?? 'unknown',
    });
  }

  if (!forecast && current.active === true && current.deadline) {
    const remaining = current.deadline.getTime() - now.getTime();
    const max = CLOSING_SOON_DAYS * 86_400_000;
    if (remaining >= 0 && remaining <= max) {
      const days = Math.ceil(remaining / 86_400_000);
      events.push({
        type: 'closing_soon',
        title: `Closing soon: ${title}`,
        body: `${days} day${days === 1 ? '' : 's'} remain before the response deadline.`,
        // Day-granular so one deadline produces at most one closing-soon alert.
        fingerprint: current.deadline.toISOString().slice(0, 10),
      });
    }
  }

  return { events, baseline: false };
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(argv: string[], name: string): string | null {
  const eq = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

async function withBypass<T>(
  prisma: PrismaClient,
  fn: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as PrismaClient;
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

async function tenantIds(prisma: PrismaClient, explicit: string | null): Promise<string[]> {
  if (explicit) return [explicit];
  const rows = await withBypass(
    prisma,
    (tx) =>
      tx.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT tenant_id FROM intel_feature_flag
      WHERE feature = ${FUNDING_OPPORTUNITIES_FEATURE} AND enabled = true
    `,
  );
  return [...new Set(rows.map((row) => row.tenant_id))];
}

const WORKFLOW_SELECT = {
  id: true,
  tenantId: true,
  clientId: true,
  source: true,
  grantOpportunityId: true,
  samOpportunityId: true,
  sourceRecordKey: true,
  workflowStatus: true,
  userCreated: true,
  humanDecision: true,
  sourceStatusSnapshot: true,
  responseDeadlineSnapshot: true,
  sourceUpdatedAtSnapshot: true,
  sourceFingerprint: true,
  sourceActiveSnapshot: true,
} as const;

const GRANT_SELECT = {
  id: true,
  title: true,
  status: true,
  closeDate: true,
  openDate: true,
  lastUpdatedAt: true,
  revision: true,
  amendmentCount: true,
  agency: true,
  awardCeiling: true,
  awardFloor: true,
  estimatedFunding: true,
  expectedAwards: true,
  responseDateDesc: true,
  cfdaNumbers: true,
  eligibility: true,
} as const;

const SAM_SELECT = {
  id: true,
  title: true,
  noticeType: true,
  baseType: true,
  active: true,
  responseDeadline: true,
  archiveDate: true,
  postedDate: true,
  setAside: true,
  setAsideCode: true,
  naicsCode: true,
  pscCode: true,
  agency: true,
  office: true,
  solicitationNumber: true,
  description: true,
} as const;

type GrantRow = { id: string; title: string } & GrantLifecycleFacts;
type SamRow = { id: string; title: string } & SamLifecycleFacts;

/** Stable source fields only: local sync clocks never create amendments. */
const FORECAST_SELECT = {
  tangoForecastId: true,
  title: true,
  description: true,
  agency: true,
  departmentName: true,
  organizationAgencyName: true,
  officeName: true,
  naicsCode: true,
  pscCode: true,
  setAside: true,
  contractVehicle: true,
  placeOfPerformance: true,
  anticipatedAwardDate: true,
  estimatedPeriod: true,
  fiscalYear: true,
  primaryContactName: true,
  primaryContactEmail: true,
  primaryContactPhone: true,
  primaryContactTitle: true,
  sourceUrl: true,
  sourceSystem: true,
  status: true,
  isActive: true,
  providerModifiedAt: true,
} satisfies Prisma.TangoProcurementForecastSelect;
const DIBBS_SELECT = {
  tangoDibbsId: true,
  solicitation: true,
  nomenclature: true,
  documentType: true,
  nsn: true,
  partNumber: true,
  quantity: true,
  unitOfIssue: true,
  setAside: true,
  statusCode: true,
  buyerCode: true,
  issuedDate: true,
  closesDate: true,
  isOpen: true,
  documentUrl: true,
  techDocsUrl: true,
} satisfies Prisma.TangoDibbsSolicitationSelect;
const SBIR_SELECT = {
  tangoSbirId: true,
  title: true,
  topicNumber: true,
  agency: true,
  year: true,
  solicitationNumber: true,
  releaseDate: true,
  openDate: true,
  closeDate: true,
  activity: true,
  solicitationStatus: true,
  topicUrl: true,
  officialSolicitationUrl: true,
} satisfies Prisma.TangoSbirTopicSelect;

function sourceFingerprint(row: object): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/** Flags apply before pagination and notification creation, including CLI scope. */
async function lifecycleSources(prisma: PrismaClient, tenantId: string): Promise<string[]> {
  const rows = await withBypass(
    prisma,
    (tx) => tx.$queryRaw<Array<{ feature: string }>>`
    SELECT feature FROM intel_feature_flag WHERE tenant_id = ${tenantId}::uuid AND enabled = true
      AND feature IN (${FUNDING_OPPORTUNITIES_FEATURE}, ${FUNDING_OPPORTUNITIES_FORECASTS_FEATURE}, ${'funding_opportunities_sbir'})
  `,
  );
  const flags = new Set(rows.map((row) => row.feature));
  if (!flags.has(FUNDING_OPPORTUNITIES_FEATURE)) return [];
  return [
    'grants_gov',
    'sam_gov',
    'dibbs',
    ...(flags.has(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE) ? ['agency_forecast'] : []),
    ...(flags.has('funding_opportunities_sbir') ? ['sbir_sttr'] : []),
  ];
}

function grantFacts(row: GrantRow): GrantLifecycleFacts {
  return {
    status: row.status,
    closeDate: row.closeDate,
    openDate: row.openDate ?? null,
    lastUpdatedAt: row.lastUpdatedAt,
    revision: row.revision ?? null,
    amendmentCount: row.amendmentCount ?? null,
    title: row.title,
    agency: row.agency ?? null,
    awardCeiling: row.awardCeiling ?? null,
    awardFloor: row.awardFloor ?? null,
    estimatedFunding: row.estimatedFunding ?? null,
    expectedAwards: row.expectedAwards ?? null,
    responseDateDesc: row.responseDateDesc ?? null,
    cfdaNumbers: row.cfdaNumbers ?? [],
    eligibility: row.eligibility ?? [],
  };
}

function samFacts(row: SamRow): SamLifecycleFacts {
  return {
    noticeType: row.noticeType,
    baseType: row.baseType ?? null,
    active: row.active,
    responseDeadline: row.responseDeadline,
    archiveDate: row.archiveDate,
    postedDate: row.postedDate ?? null,
    setAside: row.setAside ?? null,
    setAsideCode: row.setAsideCode ?? null,
    naicsCode: row.naicsCode ?? null,
    pscCode: row.pscCode ?? null,
    title: row.title,
    agency: row.agency ?? null,
    office: row.office ?? null,
    solicitationNumber: row.solicitationNumber ?? null,
    description: row.description ?? null,
  };
}

/**
 * Nameable reasons for an amendment, drawn ONLY from the columns this table
 * actually snapshots.
 *
 * This deliberately does NOT call `grantRevisionEvidence` /
 * `samRevisionEvidence`. Those compare two COMPLETE fact sets, and only four
 * fields are stored per tracked row — so feeding them a reconstruction leaves
 * `revision`, `awardCeiling`, `naicsCode`, `description` and the rest null on the
 * "previous" side, and a null-vs-real comparison reports a change on every run
 * forever. That is the original alert-spam defect in a new form, and an earlier
 * draft of this file had it. The complete-pair functions remain the right API for
 * callers that hold both sides (see source-lifecycle.spec.ts); this is not one.
 *
 * Whether an amendment happened at all is decided by the fingerprint, which is
 * complete and stored. These strings only describe it.
 */
function snapshotRevisionReasons(input: {
  previousStatus: string | null;
  currentStatus: string | null;
  previousSourceUpdatedAt: Date | null;
  currentSourceUpdatedAt: Date | null;
  /** True when a closure event is already being emitted for this status move. */
  closureReported: boolean;
}): string[] {
  const reasons: string[] = [];
  if (
    input.previousSourceUpdatedAt &&
    input.currentSourceUpdatedAt &&
    input.currentSourceUpdatedAt.getTime() > input.previousSourceUpdatedAt.getTime()
  ) {
    reasons.push(
      `The source reports a modification on ${input.currentSourceUpdatedAt.toISOString().slice(0, 10)}.`,
    );
  }
  // A status move is only narrated here when the closure event is NOT also being
  // emitted — otherwise the same fact is stated twice in two alerts.
  if (!input.closureReported && (input.previousStatus ?? null) !== (input.currentStatus ?? null)) {
    reasons.push(
      `Status changed from ${input.previousStatus ?? 'none'} to ${input.currentStatus ?? 'none'}.`,
    );
  }
  return reasons;
}

export interface LifecycleResult extends RunCounts {
  evaluated: number;
  alerts: number;
  /** Rows that received a silent first-observation baseline this run. */
  baselined: number;
}

export async function processLifecycle(
  prisma: PrismaClient,
  options: { tenantIds: string[]; commit: boolean; now?: Date },
): Promise<LifecycleResult> {
  const counts = emptyCounts();
  const now = options.now ?? new Date();
  let evaluated = 0;
  let alerts = 0;
  let baselined = 0;

  for (const tenantId of options.tenantIds) {
    const sources = await lifecycleSources(prisma, tenantId);
    if (!sources.length) continue;
    // ── Keyset walk. No cap: `id > cursor ORDER BY id` with a bounded page size
    // visits every row exactly once, and the (tenant_id, id) index added in
    // 20260810040000 serves it.
    let cursor: string | null = null;
    for (;;) {
      const rows = await withBypass(prisma, (tx) =>
        tx.clientFundingOpportunity.findMany({
          where: {
            tenantId,
            source: { in: sources },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: WORKFLOW_SELECT,
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
        }),
      );
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;

      const grantIds = rows.flatMap((row) =>
        row.grantOpportunityId ? [row.grantOpportunityId] : [],
      );
      const samIds = rows.flatMap((row) => (row.samOpportunityId ? [row.samOpportunityId] : []));
      const keys = (source: string) =>
        rows.flatMap((row) =>
          row.source === source && row.sourceRecordKey ? [row.sourceRecordKey] : [],
        );
      const forecastIds = keys('agency_forecast'),
        dibbsIds = keys('dibbs'),
        sbirIds = keys('sbir_sttr');
      const [grants, sam, forecasts, dibbs, sbir] = await Promise.all([
        grantIds.length
          ? prisma.federalGrant.findMany({
              where: { id: { in: grantIds } },
              select: GRANT_SELECT,
            })
          : [],
        samIds.length
          ? prisma.samOpportunity.findMany({
              where: { id: { in: samIds } },
              select: SAM_SELECT,
            })
          : [],
        forecastIds.length
          ? prisma.tangoProcurementForecast.findMany({
              where: { tangoForecastId: { in: forecastIds } },
              select: FORECAST_SELECT,
            })
          : [],
        dibbsIds.length
          ? prisma.tangoDibbsSolicitation.findMany({
              where: { tangoDibbsId: { in: dibbsIds } },
              select: DIBBS_SELECT,
            })
          : [],
        sbirIds.length
          ? prisma.tangoSbirTopic.findMany({
              where: { tangoSbirId: { in: sbirIds } },
              select: SBIR_SELECT,
            })
          : [],
      ]);
      const grantById = new Map(grants.map((row) => [row.id, row as unknown as GrantRow]));
      const samById = new Map(sam.map((row) => [row.id, row as unknown as SamRow]));

      const forecastById = new Map(forecasts.map((row) => [row.tangoForecastId, row]));
      const dibbsById = new Map(dibbs.map((row) => [row.tangoDibbsId, row]));
      const sbirById = new Map(sbir.map((row) => [row.tangoSbirId, row]));

      for (const row of rows) {
        evaluated += 1;
        try {
          const grant = row.grantOpportunityId ? grantById.get(row.grantOpportunityId) : null;
          const contract = row.samOpportunityId ? samById.get(row.samOpportunityId) : null;
          const forecast =
            row.source === 'agency_forecast' ? forecastById.get(row.sourceRecordKey ?? '') : null;
          const dibbsRecord =
            row.source === 'dibbs' ? dibbsById.get(row.sourceRecordKey ?? '') : null;
          const topic = row.source === 'sbir_sttr' ? sbirById.get(row.sourceRecordKey ?? '') : null;
          if (!grant && !contract && !forecast && !dibbsRecord && !topic) {
            // The source record is gone. Counted as an error rather than expired:
            // a vanished catalog row is a data problem to investigate, and
            // silently retiring a pursuit on the strength of it would be worse.
            counts.errors += 1;
            continue;
          }

          const title =
            grant?.title ??
            contract?.title ??
            forecast?.title ??
            dibbsRecord?.nomenclature ??
            dibbsRecord?.solicitation ??
            topic?.title ??
            topic?.topicNumber ??
            'SBIR/STTR topic';
          let current!: LifecycleSnapshot;

          if (grant) {
            const facts = grantFacts(grant);
            current = {
              status: facts.status,
              deadline: facts.closeDate,
              updatedAt: facts.lastUpdatedAt,
              active: isGrantActive(facts, now),
              fingerprint: grantSourceFingerprint(facts),
            };
          } else if (contract) {
            const facts = samFacts(contract);
            current = {
              status: facts.active ? 'active' : 'archived',
              deadline: facts.responseDeadline,
              // SAM publishes no modification timestamp. Deliberately null: the
              // only alternative was `updatedAt`/`lastSyncedAt`, i.e. our own
              // clock, which is what produced an amendment alert per sync.
              updatedAt: null,
              active: isSamActive(facts, now),
              fingerprint: samSourceFingerprint(facts),
            };
          }

          if (forecast) {
            const { providerModifiedAt, ...facts } = forecast;
            current = {
              status: forecast.status,
              deadline: null,
              updatedAt: providerModifiedAt,
              active: forecast.isActive,
              fingerprint: sourceFingerprint(facts),
            };
          } else if (dibbsRecord) {
            const pastClose =
              dibbsRecord.closesDate != null &&
              dibbsRecord.closesDate.toISOString().slice(0, 10) < now.toISOString().slice(0, 10);
            current = {
              status: dibbsRecord.statusCode,
              deadline: dibbsRecord.closesDate,
              updatedAt: null,
              active: dibbsRecord.isOpen === false || pastClose ? false : true,
              fingerprint: sourceFingerprint(dibbsRecord),
            };
          } else if (topic) {
            current = {
              status: topic.solicitationStatus,
              deadline: topic.closeDate,
              updatedAt: null,
              active: !isTopicClosed({
                solicitationStatus: topic.solicitationStatus,
                closeDate: topic.closeDate?.toISOString().slice(0, 10) ?? null,
                asOf: now,
              }),
              fingerprint: sourceFingerprint(topic),
            };
          }

          const previous: LifecycleSnapshot = {
            status: row.sourceStatusSnapshot,
            deadline: row.responseDeadlineSnapshot,
            updatedAt: row.sourceUpdatedAtSnapshot,
            active: row.sourceActiveSnapshot,
            fingerprint: row.sourceFingerprint,
          };

          const revisionReasons = snapshotRevisionReasons({
            previousStatus: previous.status,
            currentStatus: current.status,
            previousSourceUpdatedAt: previous.updatedAt,
            currentSourceUpdatedAt: current.updatedAt,
            closureReported: previous.active === true && current.active === false,
          });

          const decision = deriveLifecycleEvents({
            title,
            source: row.source,
            humanDecision: row.humanDecision,
            workflowStatus: row.workflowStatus,
            previous,
            current,
            revisionReasons,
            now,
          });
          if (decision.baseline) baselined += 1;

          const snapshotData = {
            sourceStatusSnapshot: current.status,
            responseDeadlineSnapshot: current.deadline,
            sourceUpdatedAtSnapshot: current.updatedAt,
            sourceFingerprint: current.fingerprint,
            sourceActiveSnapshot: current.active,
          };

          if (options.commit) {
            await withBypass(prisma, async (tx) => {
              for (const event of decision.events) {
                const sourceId = `${row.id}:${event.type}:${event.fingerprint}`;
                const exists = await tx.clioProactiveAlert.findFirst({
                  where: {
                    tenantId,
                    sourceType: 'funding_opportunity',
                    sourceId,
                  },
                  select: { id: true },
                });
                if (exists) continue;
                await tx.clioProactiveAlert.create({
                  data: {
                    tenantId,
                    clientId: row.clientId,
                    alertType: 'funding_opportunity',
                    title: event.title,
                    body: event.body,
                    priority: event.type === 'closing_soon' ? 'high' : 'normal',
                    sourceType: 'funding_opportunity',
                    sourceId,
                    metadata: {
                      workflowId: row.id,
                      source: row.source,
                      eventType: event.type,
                    } as Prisma.InputJsonValue,
                  },
                });
                alerts += 1;
                // Audit in the SAME transaction as the alert. An alert a user can
                // see with no record of what produced it is unauditable, and the
                // two must not be able to disagree.
                await tx.auditLog.create({
                  data: {
                    tenantId,
                    actorUserId: null,
                    actorRole: 'system',
                    action: `funding_opportunity.lifecycle.${event.type}`,
                    entityType: 'client_funding_opportunity',
                    entityId: row.id,
                    before: {
                      status: previous.status,
                      deadline: previous.deadline?.toISOString() ?? null,
                      active: previous.active,
                    } as Prisma.InputJsonValue,
                    after: {
                      status: current.status,
                      deadline: current.deadline?.toISOString() ?? null,
                      active: current.active,
                      reasons: revisionReasons,
                    } as Prisma.InputJsonValue,
                    requestId: SOURCE,
                  },
                });
              }

              await tx.clientFundingOpportunity.update({
                where: { id: row.id, tenantId, clientId: row.clientId },
                data: snapshotData,
              });
            });
          } else {
            // Dry run still consults the alert table, so the reported count is
            // what a commit would ACTUALLY create rather than the number of
            // events derived. Reads only.
            for (const event of decision.events) {
              const sourceId = `${row.id}:${event.type}:${event.fingerprint}`;
              const exists = await withBypass(prisma, (tx) =>
                tx.clioProactiveAlert.findFirst({
                  where: {
                    tenantId,
                    sourceType: 'funding_opportunity',
                    sourceId,
                  },
                  select: { id: true },
                }),
              );
              if (!exists) alerts += 1;
            }
          }

          counts.updated += 1;
        } catch (error) {
          counts.errors += 1;
          console.warn(`[${SOURCE}] failed workflow ${row.id}: ${(error as Error).message}`);
        }
      }

      if (rows.length < PAGE_SIZE) break;
    }
  }

  return { ...counts, evaluated, alerts, baselined };
}

async function main(): Promise<void> {
  const commit = flag(process.argv, 'commit');
  const explicitTenant = value(process.argv, 'tenant');
  const prisma = new PrismaClient();
  try {
    const ids = await tenantIds(prisma, explicitTenant);
    // Report inside the closure: evaluated/alerts/baselined belong to
    // this script's result type, not to the bare RunCounts that runWithSyncRun
    // resolves to, and on the skipIfRunning path the helper never runs this
    // body at all.
    const execute = async (): Promise<RunCounts> => {
      const result = await processLifecycle(prisma, { tenantIds: ids, commit });
      console.log(
        `[${SOURCE}] ${commit ? 'COMMITTED' : 'DRY RUN'} tenants=${ids.length} evaluated=${result.evaluated} ` +
          `alerts=${commit ? result.alerts : `${result.alerts} would create`} ` +
          `baselined=${result.baselined} errors=${result.errors}`,
      );
      if (result.baselined > 0) {
        console.log(
          `[${SOURCE}] ${result.baselined} row(s) received a first-observation baseline; ` +
            `change detection for those starts on the next run.`,
        );
      }
      return result;
    };
    // No SyncRun row in dry-run mode: a ledger entry is a record that the rail
    // RAN, and a dry run did not.
    if (commit) {
      await runWithSyncRun(prisma as never, SOURCE, execute);
    } else {
      await execute();
    }
  } finally {
    await prisma.$disconnect();
  }
}

const direct = /process-funding-opportunity-lifecycle(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (direct) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exit(1);
  });
}

export { main };
