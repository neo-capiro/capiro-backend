import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ProgramElementMilestone, ProgramElementYear } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProgramElementMetricsService } from './program-element-metrics.service.js';
import { FieldDelta, PeMilestoneInput, PeRecordInput, PeYearInput, type PeYearWriteContext } from './types.js';
import {
  ReconciliationService,
  RECONCILE_FIELDS,
  type FieldReconcileResult,
  type ReconcileField,
} from './reconciliation/reconciliation.service.js';
import { isValidProgramCode } from './jbook/jbook-extract.js';
import { sourceLabel } from './source-priority.js';
import { authorityForSource } from './program-element-field-ownership.js';
import { mergeProgramElementRaw, mergeProgramElementYearRaw } from './program-element-raw-merge.js';
import { ProgramElementChangeOutboxService } from './program-element-change-outbox.service.js';

const MARK_FIELDS = new Set([
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
]);
const FIELD_LABEL: Record<string, string> = {
  request: "President's Request",
  hascMark: 'HASC',
  sascMark: 'SASC',
  hacDMark: 'HAC-D',
  sacDMark: 'SAC-D',
  conference: 'Conference',
  ndaaConference: 'NDAA Conference',
  enacted: 'Enacted',
  reprogrammed: 'Reprogrammed',
  executed: 'Executed',
};

// Every numeric mark a single PE-year row carries. The canonical row is the
// UNION of these across sources (request from the budget, marks from committee
// reports, conference from the JES, enacted from the public law) — so the writer
// MERGES per field rather than overwriting the whole row on each source's write.
const VALUE_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
type ValueField = (typeof VALUE_FIELDS)[number];

interface EmissionPayload {
  changeType:
    | 'pe_mark_added'
    | 'pe_mark_changed'
    | 'pe_value_increased'
    | 'pe_value_decreased'
    | 'pe_milestone_slip';
  severity: 'info' | 'notable' | 'critical';
  title: string;
  description: string;
  data: Prisma.InputJsonValue;
}

interface AffectedTenantContext {
  tenantId: string;
  relatedClientIds: string[];
}

export type YearChangeResult = {
  inserted: boolean;
  changed: boolean;
  delta?: FieldDelta[];
  outboxIds?: string[];
};

const NOOP_METRICS: Pick<ProgramElementMetricsService, 'emitCount' | 'emitSeconds' | 'emitGauge'> =
  {
    emitCount: async () => {
      return;
    },
    emitSeconds: async () => {
      return;
    },
    emitGauge: async () => {
      return;
    },
  };

@Injectable()
export class ProgramElementWriterService {
  private readonly logger = new Logger(ProgramElementWriterService.name);
  private readonly metrics: Pick<
    ProgramElementMetricsService,
    'emitCount' | 'emitSeconds' | 'emitGauge'
  >;
  private readonly reconciliation: ReconciliationService;
  private readonly outbox: ProgramElementChangeOutboxService | null;

  constructor(
    private readonly prisma: PrismaService,
    metrics?: ProgramElementMetricsService,
    reconciliation?: ReconciliationService,
    outbox?: ProgramElementChangeOutboxService,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    // Reconciliation is non-optional behavior; default-construct it so the many
    // script call sites that do `new ProgramElementWriterService(prisma)` keep
    // working without wiring changes.
    this.reconciliation = reconciliation ?? new ReconciliationService(prisma);
    this.outbox = outbox ?? (this.hasRootTransaction() ? new ProgramElementChangeOutboxService(prisma) : null);
  }

  async upsertProgramElement(
    record: PeRecordInput,
    source: string,
    sourceConfidence: number,
  ): Promise<{ inserted: boolean; pe_code: string }> {
    if (!this.isValidPeCode(record.peCode)) {
      await this.quarantine(record, `Invalid pe_code: ${record.peCode}`, source);
      return { inserted: false, pe_code: record.peCode };
    }

    const peCode = record.peCode;
    const existing = await this.prisma.programElement.findUnique({ where: { peCode } });

    const data: Prisma.ProgramElementUncheckedCreateInput = {
      peCode,
      service: record.service ?? null,
      serviceCode: record.serviceCode ?? null,
      appropriationType: record.appropriationType ?? null,
      budgetActivity: record.budgetActivity ?? null,
      budgetActivityName: record.budgetActivityName ?? null,
      lineNumber: record.lineNumber ?? null,
      title: record.title,
      description: record.description ?? null,
      acatLevel: record.acatLevel ?? null,
      programOfRecord: record.programOfRecord ?? null,
      status: record.status ?? null,
      rDocUrl: record.rDocUrl ?? null,
      pDocUrl: record.pDocUrl ?? null,
      oDocUrl: record.oDocUrl ?? null,
      raw: mergeProgramElementRaw(null, record.raw, source),
      source,
      sourceConfidence,
      firstSeenFy: record.firstSeenFy ?? null,
      lastSyncedAt: new Date(),
    };

    if (!existing) {
      await this.prisma.programElement.create({ data });
      await this.metrics.emitCount('pe_sync.rows_inserted', 1, source);
      return { inserted: true, pe_code: peCode };
    }

    // Title-preservation guard: committee/NDAA-table sources derive the title from
    // PDF table text, which can be truncated (line-wrap, embedded numbers). Never let
    // such a source REPLACE a longer, already-stored title with a shorter/truncated
    // one. Keep the incoming title only when it's an improvement (longer) or the
    // existing one is empty. Authoritative full titles (J-book, etc.) still win
    // because they're longer. Truncated markers ('FOO-', 'F–') are shorter, so they
    // can't clobber a good title.
    const incomingTitle = (record.title ?? '').trim();
    const existingTitle = (existing.title ?? '').trim();
    const keptTitle =
      existingTitle.length > incomingTitle.length ? existingTitle : incomingTitle || existingTitle;

    // Field-MERGE (mirror upsertProgramElementYear): a source that carries only some
    // fields (e.g. a committee/appropriations mark supplies peCode + title, no
    // appropriationType/service/budgetActivity) must NOT null out metadata another
    // source already populated. Keep the incoming value only when it is non-null;
    // otherwise preserve what's stored. This is what lets a procurement mark (PROC)
    // land without wiping the appropriationType/service/lineNumber set by the P-doc load.
    await this.prisma.programElement.update({
      where: { peCode },
      data: {
        service: record.service ?? existing.service,
        serviceCode: record.serviceCode ?? existing.serviceCode,
        appropriationType: record.appropriationType ?? existing.appropriationType,
        budgetActivity: record.budgetActivity ?? existing.budgetActivity,
        budgetActivityName: record.budgetActivityName ?? existing.budgetActivityName,
        lineNumber: record.lineNumber ?? existing.lineNumber,
        description: record.description ?? existing.description,
        acatLevel: record.acatLevel ?? existing.acatLevel,
        programOfRecord: record.programOfRecord ?? existing.programOfRecord,
        status: record.status ?? existing.status,
        rDocUrl: record.rDocUrl ?? existing.rDocUrl,
        pDocUrl: record.pDocUrl ?? existing.pDocUrl,
        oDocUrl: record.oDocUrl ?? existing.oDocUrl,
        raw: mergeProgramElementRaw(existing.raw, record.raw, source),
        source,
        sourceConfidence,
        title: keptTitle,
        firstSeenFy: existing.firstSeenFy ?? data.firstSeenFy,
        lastSyncedAt: new Date(),
      },
    });

    await this.metrics.emitCount('pe_sync.rows_updated', 1, source);
    return { inserted: false, pe_code: peCode };
  }

  async upsertProgramElementYear(
    record: PeYearInput,
    source: string,
    context?: PeYearWriteContext,
  ): Promise<YearChangeResult> {
    if (!this.isValidPeCode(record.peCode)) {
      await this.quarantine(record, `Invalid pe_code: ${record.peCode}`, source);
      return { inserted: false, changed: false };
    }

    const resolvedContext: PeYearWriteContext = {
      ...context,
      authority: context?.authority ?? authorityForSource(source),
    };

    const rootTransaction = this.hasRootTransaction();
    const result = rootTransaction
      ? await (this.prisma as unknown as PrismaService).$transaction(
          (tx: Prisma.TransactionClient) =>
            this.writeProgramElementYear(tx, record, source, resolvedContext),
          { maxWait: 10_000, timeout: 120_000 },
        )
      : await this.writeProgramElementYear(
          this.prisma as unknown as Prisma.TransactionClient,
          record,
          source,
          resolvedContext,
        );

    if (result.inserted) await this.metrics.emitCount('pe_sync.rows_inserted', 1, source);
    else if (result.changed) await this.metrics.emitCount('pe_sync.rows_updated', 1, source);

    if (rootTransaction && result.outboxIds?.length) {
      await this.processOutboxIds(result.outboxIds);
    }
    return result;
  }

  async processOutboxIds(ids: readonly string[]): Promise<void> {
    if (!this.outbox) return;
    for (const id of [...new Set(ids)]) {
      const status = await this.outbox.processById(id);
      if (status === 'failed') {
        this.logger.warn(`Canonical write committed but Program Element outbox ${id} remains failed/pending`);
      }
    }
  }

  private hasRootTransaction(): boolean {
    return typeof (this.prisma as unknown as { $transaction?: unknown }).$transaction === 'function';
  }

  private async writeProgramElementYear(
    tx: Prisma.TransactionClient,
    record: PeYearInput,
    source: string,
    context: PeYearWriteContext,
  ): Promise<YearChangeResult> {
    // Row locks do not exist before the first insert. A transaction-scoped advisory
    // lock serializes both create and update races for one PE/FY without widening
    // the lock to unrelated budget lines.
    const lockKey = `${record.peCode}:${record.fy}`;
        // $executeRaw: pg_advisory_xact_lock returns void; $queryRaw fails to deserialize void.
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const existing = await tx.programElementYear.findUnique({
      where: { peCode_fy: { peCode: record.peCode, fy: record.fy } },
    });
    const incoming = this.normalizeYearInput(record);
    const currentValues: Partial<Record<ReconcileField, number | null>> = {};
    const incomingValues: Partial<Record<ReconcileField, number | null>> = {};
    for (const field of RECONCILE_FIELDS) {
      currentValues[field] = existing ? this.toNumber(existing[field]) : null;
      incomingValues[field] = this.toNumber(incoming[field]);
    }

    const reconciled = await this.reconciliation.reconcile(
      {
        peCode: record.peCode,
        fy: record.fy,
        source,
        authority: context.authority,
        values: incomingValues,
        currentValues,
        context,
      },
      tx,
    );
    const merged = this.buildMergedYear(existing, incoming, source, reconciled);

    let delta: FieldDelta[];
    let inserted = false;
    if (!existing) {
      await tx.programElementYear.create({
        data: {
          ...merged,
          peCode: record.peCode,
          fy: record.fy,
          lastSyncedAt: new Date(),
        },
      });
      inserted = true;
      delta = this.computeYearDeltaFromNull(merged);
    } else {
      delta = this.computeYearDelta(existing, merged);
      if (delta.length > 0) {
        await tx.programElementYear.update({
          where: { peCode_fy: { peCode: record.peCode, fy: record.fy } },
          data: { ...merged, lastSyncedAt: new Date() },
        });
      }
    }

    await this.reconciliation.applyWinnerFlags(
      { peCode: record.peCode, fy: record.fy, results: reconciled },
      tx,
    );

    const canonicalDelta = delta.filter((entry) => VALUE_FIELDS.includes(entry.field as ValueField));
    const outboxIds: string[] = [];
    // Initial catalog hydration must not notify users. A later mark added to an
    // existing request row still emits because `existing` is present.
    if (existing) {
      for (const entry of canonicalDelta) {
        const field = entry.field as ValueField;
        const winner = reconciled.find((result) => result.fieldName === field && result.shouldWin);
        if (!winner) continue;
        const oldActual = this.toNumber(entry.oldValue);
        const newValue = this.toNumber(entry.newValue);
        if (newValue === null) continue;
        const oldForEmission = oldActual ?? (MARK_FIELDS.has(field) ? 0 : null);
        if (oldForEmission === null || oldForEmission === newValue) continue;
        const emission = this.buildYearEmission(
          record.peCode,
          record.fy,
          field,
          oldForEmission,
          newValue,
        );
        const dedupeKey = [
          'pe-year',
          record.peCode,
          record.fy,
          field,
          oldActual === null ? 'null' : String(oldActual),
          String(newValue),
          winner.observationKey,
        ].join(':');
        const outbox = await tx.programElementChangeOutbox.upsert({
          where: { dedupeKey },
          create: {
            dedupeKey,
            peCode: record.peCode,
            eventType: emission.changeType,
            payload: this.toJsonValue({
              peCode: record.peCode,
              fy: record.fy,
              field,
              oldValue: oldActual,
              newValue,
              dataCorrection: context.dataCorrection ?? false,
              suppressAlerts: context.dataCorrection ?? false,
              winningObservationKey: winner.observationKey,
              emission,
            }),
          },
          update: {},
          select: { id: true },
        });
        outboxIds.push(outbox.id);
      }
    }

    const changed = canonicalDelta.length > 0;
    return {
      inserted,
      changed,
      ...(canonicalDelta.length > 0 ? { delta: canonicalDelta } : {}),
      ...(outboxIds.length > 0 ? { outboxIds } : {}),
    };
  }

  async upsertProgramElementMilestone(
    record: PeMilestoneInput,
    source: string,
  ): Promise<{ inserted: boolean }> {
    if (!this.isValidPeCode(record.peCode)) {
      await this.quarantine(record, `Invalid pe_code: ${record.peCode}`, source);
      return { inserted: false };
    }

    const existing = await this.prisma.programElementMilestone.findUnique({
      where: {
        peCode_milestoneType: {
          peCode: record.peCode,
          milestoneType: record.milestoneType,
        },
      },
    });

    const data: Prisma.ProgramElementMilestoneUncheckedCreateInput = {
      peCode: record.peCode,
      milestoneType: record.milestoneType,
      plannedDate: this.toDate(record.plannedDate),
      actualDate: this.toDate(record.actualDate),
      status: record.status ?? null,
      source,
      notes: record.notes ?? null,
      lastSyncedAt: new Date(),
    };

    if (!existing) {
      await this.prisma.programElementMilestone.create({ data });
      await this.metrics.emitCount('pe_sync.rows_inserted', 1, source);
      return { inserted: true };
    }

    await this.prisma.programElementMilestone.update({
      where: {
        peCode_milestoneType: {
          peCode: record.peCode,
          milestoneType: record.milestoneType,
        },
      },
      data,
    });

    await this.metrics.emitCount('pe_sync.rows_updated', 1, source);
    await this.emitMilestoneSlipChange(record.peCode, existing, data);
    return { inserted: false };
  }

  async quarantine(rawRecord: unknown, reason: string, source: string): Promise<void> {
    await this.prisma.programElementQuarantine.create({
      data: {
        rawRecord: this.toJsonValue(rawRecord),
        reason,
        source,
      },
    });
    await this.metrics.emitCount('pe_sync.rows_quarantined', 1, source);
    this.logger.warn(`Program element quarantined: ${reason} (${source})`);
  }

  async refreshProgramElementDetailMaterializedView(source = 'all'): Promise<void> {
    const startedAt = Date.now();
    try {
      // capiro_app is not the MV owner and cannot run REFRESH directly; call the
      // SECURITY DEFINER function (owned by master) which performs the refresh
      // with owner privileges. See migration 20260602160000_pe_detail_mv_refresh_fn.
      await this.prisma.$executeRawUnsafe('SELECT refresh_program_element_detail_mv()');
      await this.metrics.emitSeconds(
        'pe_sync.duration_seconds',
        (Date.now() - startedAt) / 1000,
        source,
      );
      await this.metrics.emitCount('pe_sync.error_count', 0, source);
    } catch (error: unknown) {
      await this.metrics.emitCount('pe_sync.error_count', 1, source);
      throw error;
    }
  }

  async emitRunSummary(
    source: string,
    startedAt: Date,
    inserted: number,
    updated: number,
    quarantined: number,
  ): Promise<void> {
    await this.metrics.emitCount('pe_sync.rows_inserted', inserted, source);
    await this.metrics.emitCount('pe_sync.rows_updated', updated, source);
    await this.metrics.emitCount('pe_sync.rows_quarantined', quarantined, source);
    await this.metrics.emitSeconds(
      'pe_sync.duration_seconds',
      (Date.now() - startedAt.getTime()) / 1000,
      source,
    );
    await this.metrics.emitCount('pe_sync.error_count', 0, source);
  }

  async emitRunError(source: string): Promise<void> {
    await this.metrics.emitCount('pe_sync.error_count', 1, source);
  }

  async emitInventoryMetrics(source = 'all'): Promise<void> {
    const [rowsInDb, quarantineCount] = await Promise.all([
      this.prisma.programElement.count(),
      this.prisma.programElementQuarantine.count(),
    ]);

    await this.metrics.emitGauge('pe_sync.rows_in_db', rowsInDb, source);
    await this.metrics.emitGauge('pe_sync.quarantine_count', quarantineCount, source);
  }

  async getHealthSummary() {
    const [rowsInDb, quarantineCount, sources] = await Promise.all([
      this.prisma.programElement.count(),
      this.prisma.programElementQuarantine.count(),
      this.prisma.programElementYearSourceValue.findMany({
        select: { source: true, recordedAt: true },
        distinct: ['source'],
        orderBy: { recordedAt: 'desc' },
      }),
    ]);

    const lastSyncAtBySource = Object.fromEntries(
      sources.map((row) => [row.source, row.recordedAt.toISOString()]),
    );

    const now = Date.now();
    const staleThresholdMs = 48 * 60 * 60 * 1000;
    const hasStaleSource = sources.some((row) => now - row.recordedAt.getTime() > staleThresholdMs);

    let status: 'ok' | 'degraded' | 'error' = 'ok';
    if (quarantineCount > 100) {
      status = 'error';
    } else if (hasStaleSource) {
      status = 'degraded';
    }

    return {
      status,
      last_sync_at_by_source: lastSyncAtBySource,
      rows_in_db: rowsInDb,
      quarantine_count: quarantineCount,
    };
  }

  // Accepts RDT&E PE codes AND procurement BLINs (appropriation_type distinguishes
  // them downstream); the shared gate must let both land in program_element.
  private isValidPeCode(peCode: string): boolean {
    return isValidProgramCode(peCode);
  }

  private normalizeYearInput(
    record: PeYearInput,
  ): Omit<Prisma.ProgramElementYearUncheckedCreateInput, 'id' | 'peCode' | 'fy' | 'lastSyncedAt'> {
    return {
      request: this.toDecimal(record.request),
      hascMark: this.toDecimal(record.hascMark),
      sascMark: this.toDecimal(record.sascMark),
      hacDMark: this.toDecimal(record.hacDMark),
      sacDMark: this.toDecimal(record.sacDMark),
      conference: this.toDecimal(record.conference),
      ndaaConference: this.toDecimal(record.ndaaConference),
      enacted: this.toDecimal(record.enacted),
      reprogrammed: this.toDecimal(record.reprogrammed),
      executed: this.toDecimal(record.executed),
      notes: record.notes ?? null,
      rDocSection: record.rDocSection ?? null,
      raw: this.toJsonValue(record.raw),
    };
  }

  private buildMergedYear(
    existing: ProgramElementYear | null,
    incoming: Omit<
      Prisma.ProgramElementYearUncheckedCreateInput,
      'id' | 'peCode' | 'fy' | 'lastSyncedAt'
    >,
    source: string,
    reconciled: readonly FieldReconcileResult[],
  ): Omit<Prisma.ProgramElementYearUncheckedCreateInput, 'id' | 'peCode' | 'fy' | 'lastSyncedAt'> {
    const existingRaw = this.asRecord(existing?.raw);
    const fieldSources = this.asStringMap(existingRaw.fieldSources);
    const sourceAttribution = this.asStringMap(existingRaw.sourceAttribution);
    const datesAdded = this.asStringMap(existingRaw.datesAdded);
    const today = new Date().toISOString().slice(0, 10);
    const decisions = new Map(reconciled.map((result) => [result.fieldName, result] as const));

    const values: Partial<Record<ValueField, Prisma.Decimal | null>> = {};
    for (const field of VALUE_FIELDS) {
      const inc = (incoming[field] ?? null) as Prisma.Decimal | null;
      const cur = (existing?.[field] ?? null) as Prisma.Decimal | null;
      if (inc === null) {
        values[field] = cur;
        continue;
      }
      const decision = decisions.get(field);
      if (!decision?.shouldWin) {
        values[field] = cur;
        continue;
      }
      values[field] = inc;
      if (cur === null || !this.decEqual(cur, inc)) datesAdded[field] = today;
      fieldSources[field] = source;
      sourceAttribution[field] = sourceLabel(source);
    }

    const incNotes =
      typeof incoming.notes === 'string' && incoming.notes.trim() ? incoming.notes : null;
    const incRDoc =
      typeof incoming.rDocSection === 'string' && incoming.rDocSection.trim()
        ? incoming.rDocSection
        : null;

    return {
      request: values.request ?? null,
      hascMark: values.hascMark ?? null,
      sascMark: values.sascMark ?? null,
      hacDMark: values.hacDMark ?? null,
      sacDMark: values.sacDMark ?? null,
      conference: values.conference ?? null,
      ndaaConference: values.ndaaConference ?? null,
      enacted: values.enacted ?? null,
      reprogrammed: values.reprogrammed ?? null,
      executed: values.executed ?? null,
      notes: incNotes ?? existing?.notes ?? null,
      rDocSection: incRDoc ?? existing?.rDocSection ?? null,
      raw: mergeProgramElementYearRaw(
        existing?.raw,
        incoming.raw,
        source,
        fieldSources,
        sourceAttribution,
        datesAdded,
      ),
    };
  }

  private computeYearDeltaFromNull(
    incoming: Omit<
      Prisma.ProgramElementYearUncheckedCreateInput,
      'id' | 'peCode' | 'fy' | 'lastSyncedAt'
    >,
  ): FieldDelta[] {
    const delta: FieldDelta[] = [];
    for (const field of VALUE_FIELDS) {
      const value = incoming[field];
      if (value !== null && value !== undefined) {
        delta.push({ field, oldValue: null, newValue: this.normalizeComparableValue(value) });
      }
    }
    return delta;
  }

  private decEqual(a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean {
    if (a === null || b === null) return a === b;
    return a.toString() === b.toString();
  }

  /** Shallow-clone a JSON value into a plain object (or {} when it isn't one). */
  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }

  /** Coerce a JSON value into a string→string map, dropping non-string entries. */
  private asStringMap(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  private computeYearDelta(
    existing: ProgramElementYear,
    incoming: Omit<
      Prisma.ProgramElementYearUncheckedCreateInput,
      'id' | 'peCode' | 'fy' | 'lastSyncedAt'
    >,
  ): FieldDelta[] {
    const fields: Array<
      keyof Omit<
        Prisma.ProgramElementYearUncheckedCreateInput,
        'id' | 'peCode' | 'fy' | 'lastSyncedAt'
      >
    > = [
      'request',
      'hascMark',
      'sascMark',
      'hacDMark',
      'sacDMark',
      'conference',
      'ndaaConference',
      'enacted',
      'reprogrammed',
      'executed',
      'notes',
      'rDocSection',
      'raw',
    ];

    const delta: FieldDelta[] = [];

    for (const field of fields) {
      const newValue = incoming[field];
      const oldValue = (existing as Record<string, unknown>)[field as string];
      const normalizedOld = this.normalizeComparableValue(oldValue);
      const normalizedNew = this.normalizeComparableValue(newValue);
      if (!this.valuesEqual(normalizedOld, normalizedNew)) {
        delta.push({ field, oldValue: normalizedOld, newValue: normalizedNew });
      }
    }

    return delta;
  }

  private async emitMilestoneSlipChange(
    peCode: string,
    existing: ProgramElementMilestone,
    incoming: Prisma.ProgramElementMilestoneUncheckedCreateInput,
  ): Promise<void> {
    const plannedDate = (incoming.plannedDate ?? existing.plannedDate) as Date | null;
    const oldActual = existing.actualDate;
    const newActual = (incoming.actualDate ?? null) as Date | null;

    if (!plannedDate || !newActual) return;
    if (newActual <= plannedDate) return;
    if (oldActual && oldActual > plannedDate) return;

    const affected = await this.getAffectedTenants(peCode);
    if (affected.length === 0) return;

    const deltaDays = Math.ceil(
      (newActual.getTime() - plannedDate.getTime()) / (24 * 60 * 60 * 1000),
    );
    const emission: EmissionPayload = {
      changeType: 'pe_milestone_slip',
      severity: 'notable',
      title: `${existing.milestoneType} slipped for PE ${peCode} by ${deltaDays} days`,
      description: `${existing.milestoneType} moved later than planned for FY oversight tracking.`,
      data: this.toJsonValue({
        milestoneType: existing.milestoneType,
        plannedDate: plannedDate.toISOString().slice(0, 10),
        oldValue: oldActual ? oldActual.toISOString().slice(0, 10) : null,
        newValue: newActual.toISOString().slice(0, 10),
        deltaDays,
      }),
    };

    await this.emitForTenants(peCode, affected, emission);
  }

  private buildYearEmission(
    peCode: string,
    fy: number,
    field: string,
    oldValue: number,
    newValue: number,
  ): EmissionPayload {
    const deltaAbs = newValue - oldValue;
    const deltaPct = oldValue === 0 ? 0 : (deltaAbs / Math.abs(oldValue)) * 100;
    const severity = this.classifySeverity(Math.abs(deltaPct));
    const changeType = this.classifyChangeType(field, oldValue, newValue);
    const fieldLabel = FIELD_LABEL[field] ?? field;

    const title = this.buildYearTitle({ peCode, field, fieldLabel, oldValue, newValue, deltaAbs });

    return {
      changeType,
      severity,
      title,
      description: `${fieldLabel} changed in FY${String(fy).slice(2)} for PE ${peCode}.`,
      data: this.toJsonValue({
        fy,
        field,
        oldValue,
        newValue,
        deltaPct,
      }),
    };
  }

  private buildYearTitle(input: {
    peCode: string;
    field: string;
    fieldLabel: string;
    oldValue: number;
    newValue: number;
    deltaAbs: number;
  }): string {
    const { peCode, field, fieldLabel, newValue, deltaAbs } = input;
    // Marks are stored in millions of dollars (the canonical unit across ingestion,
    // fixtures, and the UI), so the value IS the figure in $M — no scaling.
    const newValueM = newValue;
    const deltaM = deltaAbs;

    if (field !== 'request') {
      return `${fieldLabel} marked PE ${peCode} at $${newValueM.toFixed(0)}M (${deltaM >= 0 ? '+' : ''}${deltaM.toFixed(0)}M over request)`;
    }

    return `President's Request for PE ${peCode} updated to $${newValueM.toFixed(0)}M (${deltaM >= 0 ? '+' : ''}${deltaM.toFixed(0)}M)`;
  }

  private classifyChangeType(
    field: string,
    oldValue: number,
    newValue: number,
  ): 'pe_mark_added' | 'pe_mark_changed' | 'pe_value_increased' | 'pe_value_decreased' {
    if (MARK_FIELDS.has(field)) {
      if (oldValue === 0 && newValue !== 0) return 'pe_mark_added';
      return 'pe_mark_changed';
    }
    return newValue > oldValue ? 'pe_value_increased' : 'pe_value_decreased';
  }

  private classifySeverity(deltaPctAbs: number): 'info' | 'notable' | 'critical' {
    if (deltaPctAbs > 25) return 'critical';
    if (deltaPctAbs > 10) return 'notable';
    return 'info';
  }

  private async getAffectedTenants(peCode: string): Promise<AffectedTenantContext[]> {
    // Cross-tenant BY DESIGN: a budget delta on a PE affects every tenant that
    // watches it or whose client capability names it, so both enumerations must
    // bypass RLS (system path). client_capabilities has been RLS-FORCED since the
    // tenancy migration and program_element_watch is RLS-FORCED as of the Phase C
    // tenant-isolation migration; the non-super app role (capiro_app is NOT
    // BYPASSRLS) reads zero rows from either without the bypass, and for the watch
    // leg that silently drops every watch-only tenant from alert routing. One
    // transaction keeps the fan-out at a single pooled connection.
    const { watches, capabilities } = await this.prisma.withSystem(async (tx) => {
      const watchRows = await tx.programElementWatch.findMany({
        where: { peCode },
        select: { tenantId: true },
      });
      const capabilityRows = await tx.clientCapability.findMany({
        where: { peNumber: peCode },
        select: { tenantId: true, clientId: true },
      });
      return { watches: watchRows, capabilities: capabilityRows };
    });

    const byTenant = new Map<string, Set<string>>();

    for (const watch of watches) {
      if (!byTenant.has(watch.tenantId)) byTenant.set(watch.tenantId, new Set());
    }

    for (const cap of capabilities) {
      const set = byTenant.get(cap.tenantId) ?? new Set<string>();
      set.add(cap.clientId);
      byTenant.set(cap.tenantId, set);
    }

    return Array.from(byTenant.entries()).map(([tenantId, clientIds]) => ({
      tenantId,
      relatedClientIds: Array.from(clientIds),
    }));
  }

  private async emitForTenants(
    peCode: string,
    affected: AffectedTenantContext[],
    payload: EmissionPayload,
  ): Promise<void> {
    await Promise.all(
      affected.map(({ tenantId, relatedClientIds }) =>
        this.prisma.intelligenceChange
          .create({
            data: {
              source: 'program_element',
              changeType: payload.changeType,
              severity: payload.severity,
              title: payload.title,
              description: payload.description,
              relatedClientIds,
              relatedIssues: [],
              relatedPeCodes: [peCode],
              data: payload.data,
            },
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to emit program-element change for tenant ${tenantId}: ${message}`,
            );
          }),
      ),
    );
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Prisma.Decimal) return value.toNumber();
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private normalizeComparableValue(value: unknown): unknown {
    if (value instanceof Prisma.Decimal) return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'undefined') return null;
    return value;
  }

  private toDecimal(value: string | number | null | undefined): Prisma.Decimal | null {
    if (value === null || value === undefined || value === '') return null;
    return new Prisma.Decimal(value);
  }

  private toDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    return value instanceof Date ? value : new Date(value);
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    if (value === undefined || value === null) return {};
    if (this.isJsonValue(value)) {
      return value;
    }
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private isJsonValue(value: unknown): value is Prisma.InputJsonValue {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return true;
    }

    if (Array.isArray(value)) {
      return value.every((item) => this.isJsonValue(item));
    }

    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).every((item) =>
        this.isJsonValue(item),
      );
    }

    return false;
  }
}
