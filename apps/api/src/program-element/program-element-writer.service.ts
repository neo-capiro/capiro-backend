import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ProgramElementMilestone, ProgramElementYear } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProgramElementMetricsService } from './program-element-metrics.service.js';
import { FieldDelta, PeMilestoneInput, PeRecordInput, PeYearInput } from './types.js';
import { ReconciliationService, RECONCILE_FIELDS, type ReconcileField } from './reconciliation/reconciliation.service.js';
import { isValidProgramCode } from './jbook/jbook-extract.js';
import { sourceLabel, sourceRank } from './source-priority.js';

const MARK_FIELDS = new Set(['hascMark', 'sascMark', 'hacDMark', 'sacDMark', 'conference', 'enacted']);
const FIELD_LABEL: Record<string, string> = {
  request: "President's Request",
  hascMark: 'HASC',
  sascMark: 'SASC',
  hacDMark: 'HAC-D',
  sacDMark: 'SAC-D',
  conference: 'Conference',
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
  'enacted',
  'reprogrammed',
  'executed',
] as const;
type ValueField = (typeof VALUE_FIELDS)[number];

interface EmissionPayload {
  changeType: 'pe_mark_added' | 'pe_mark_changed' | 'pe_value_increased' | 'pe_value_decreased' | 'pe_milestone_slip';
  severity: 'info' | 'notable' | 'critical';
  title: string;
  description: string;
  data: Prisma.InputJsonValue;
}

interface AffectedTenantContext {
  tenantId: string;
  relatedClientIds: string[];
}

type YearChangeResult = {
  inserted: boolean;
  changed: boolean;
  delta?: FieldDelta[];
};

const NOOP_METRICS: Pick<
  ProgramElementMetricsService,
  'emitCount' | 'emitSeconds' | 'emitGauge'
> = {
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
  private readonly metrics: Pick<ProgramElementMetricsService, 'emitCount' | 'emitSeconds' | 'emitGauge'>;
  private readonly reconciliation: ReconciliationService;

  constructor(
    private readonly prisma: PrismaService,
    metrics?: ProgramElementMetricsService,
    reconciliation?: ReconciliationService,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    // Reconciliation is non-optional behavior; default-construct it so the many
    // script call sites that do `new ProgramElementWriterService(prisma)` keep
    // working without wiring changes.
    this.reconciliation = reconciliation ?? new ReconciliationService(prisma);
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
      raw: this.toJsonValue(record.raw),
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
        raw: this.toJsonValue(record.raw),
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

  async upsertProgramElementYear(record: PeYearInput, source: string): Promise<YearChangeResult> {
    if (!this.isValidPeCode(record.peCode)) {
      await this.quarantine(record, `Invalid pe_code: ${record.peCode}`, source);
      return { inserted: false, changed: false };
    }

    const existing = await this.prisma.programElementYear.findUnique({
      where: { peCode_fy: { peCode: record.peCode, fy: record.fy } },
    });

    const incoming = this.normalizeYearInput(record);

    // Cross-source reconciliation (Step 29): log per-source values + queue
    // over-threshold conflicts on every observed write, before canonical changes.
    await this.runReconciliation(record, source);

    // MERGE this source's fields into the existing row instead of overwriting it.
    // Each ingestion source carries only its own field(s) — request from the
    // budget, one mark from a committee report, conference from the JES, enacted
    // from the public law. A whole-row overwrite (the old behavior) nulled out
    // every field the OTHER sources had populated, so only the last writer's field
    // survived — the root cause of "all program elements show no funding". The
    // merge keeps every populated field and lets source-priority break per-field
    // conflicts.
    const merged = this.buildMergedYear(existing, incoming, source);

    if (!existing) {
      await this.prisma.programElementYear.create({
        data: {
          ...merged,
          peCode: record.peCode,
          fy: record.fy,
          lastSyncedAt: new Date(),
        },
      });
      await this.metrics.emitCount('pe_sync.rows_inserted', 1, source);
      await this.logSourceValue(record, source, true);
      return { inserted: true, changed: true };
    }

    const delta = this.computeYearDelta(existing, merged);
    if (delta.length === 0) {
      await this.logSourceValue(record, source, true);
      return { inserted: false, changed: false };
    }

    await this.prisma.programElementYear.update({
      where: { peCode_fy: { peCode: record.peCode, fy: record.fy } },
      data: {
        ...merged,
        lastSyncedAt: new Date(),
      },
    });

    await this.metrics.emitCount('pe_sync.rows_updated', 1, source);
    await this.logSourceValue(record, source, true);
    await this.emitYearDeltaChange(record.peCode, record.fy, delta);
    return { inserted: false, changed: true, delta };
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
      await this.metrics.emitSeconds('pe_sync.duration_seconds', (Date.now() - startedAt) / 1000, source);
      await this.metrics.emitCount('pe_sync.error_count', 0, source);
    } catch (error: unknown) {
      await this.metrics.emitCount('pe_sync.error_count', 1, source);
      throw error;
    }
  }

  async emitRunSummary(source: string, startedAt: Date, inserted: number, updated: number, quarantined: number): Promise<void> {
    await this.metrics.emitCount('pe_sync.rows_inserted', inserted, source);
    await this.metrics.emitCount('pe_sync.rows_updated', updated, source);
    await this.metrics.emitCount('pe_sync.rows_quarantined', quarantined, source);
    await this.metrics.emitSeconds('pe_sync.duration_seconds', (Date.now() - startedAt.getTime()) / 1000, source);
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

  /**
   * Source-priority rank — lower index = higher priority. Delegates to the shared
   * prefix-aware resolver so suffixed tags (`hasc_report_fy27`, `p_doc_navy_fy27`)
   * map to their base priority. The old literal `indexOf` never matched a suffixed
   * tag, so every real source tied at the bottom and priority was silently inert.
   */
  private getSourceRank(source: string): number {
    return sourceRank(source);
  }

  /**
   * Run cross-source reconciliation (Step 29 §4.1) for the numeric fields this
   * write actually set. Logs per-source values and queues review entries for
   * over-threshold conflicts. Never throws into the write path.
   */
  private async runReconciliation(record: PeYearInput, source: string): Promise<void> {
    const values: Partial<Record<ReconcileField, number | null>> = {};
    for (const field of RECONCILE_FIELDS) {
      const raw = (record as unknown as Record<string, unknown>)[field];
      const num = this.toNumber(raw);
      if (num !== null) values[field] = num;
    }
    if (Object.keys(values).length === 0) return;
    try {
      // Use the base source key (strip _fy<NN>) for priority-aligned comparison.
      const baseSource = source.replace(/_fy\d+$/i, '');
      await this.reconciliation.reconcile({ peCode: record.peCode, fy: record.fy, source: baseSource, values });
    } catch (err) {
      this.logger.warn(`Reconciliation failed for ${record.peCode} FY${record.fy}: ${String(err)}`);
    }
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
      enacted: this.toDecimal(record.enacted),
      reprogrammed: this.toDecimal(record.reprogrammed),
      executed: this.toDecimal(record.executed),
      notes: record.notes ?? null,
      rDocSection: record.rDocSection ?? null,
      raw: this.toJsonValue(record.raw),
    };
  }

  /**
   * Merge an incoming source's normalized fields over the existing canonical row.
   * Per value field: take the incoming value only when it is non-null AND its
   * source is at least as high-priority as whatever last set the field (tracked in
   * raw.fieldSources); otherwise keep the existing value. A null incoming field
   * NEVER clobbers an existing value. Records per-field provenance
   * (raw.sourceAttribution for display + raw.datesAdded), stamping the date only
   * when a value actually changes so idempotent re-runs stay no-ops. Returns the
   * row payload for both create and update (caller adds peCode/fy/lastSyncedAt).
   */
  private buildMergedYear(
    existing: ProgramElementYear | null,
    incoming: Omit<Prisma.ProgramElementYearUncheckedCreateInput, 'id' | 'peCode' | 'fy' | 'lastSyncedAt'>,
    source: string,
  ): Omit<Prisma.ProgramElementYearUncheckedCreateInput, 'id' | 'peCode' | 'fy' | 'lastSyncedAt'> {
    const incomingRank = this.getSourceRank(source);
    const existingRaw = this.asRecord(existing?.raw);
    const fieldSources = this.asStringMap(existingRaw.fieldSources);
    const sourceAttribution = this.asStringMap(existingRaw.sourceAttribution);
    const datesAdded = this.asStringMap(existingRaw.datesAdded);
    const today = new Date().toISOString().slice(0, 10);

    const values: Partial<Record<ValueField, Prisma.Decimal | null>> = {};
    for (const field of VALUE_FIELDS) {
      const inc = (incoming[field] ?? null) as Prisma.Decimal | null;
      const cur = (existing?.[field] ?? null) as Prisma.Decimal | null;

      if (inc === null) {
        values[field] = cur; // a source that doesn't carry this field must not erase it
        continue;
      }

      const curRank = field in fieldSources ? this.getSourceRank(fieldSources[field]!) : Number.MAX_SAFE_INTEGER;
      if (cur !== null && incomingRank > curRank) {
        values[field] = cur; // a lower-priority source never overwrites a higher one
        continue;
      }

      values[field] = inc;
      if (cur === null || !this.decEqual(cur, inc)) {
        datesAdded[field] = today;
      }
      fieldSources[field] = source;
      sourceAttribution[field] = sourceLabel(source);
    }

    // Narrative columns: prefer a non-empty incoming value, else keep existing.
    const incNotes = typeof incoming.notes === 'string' && incoming.notes.trim() ? incoming.notes : null;
    const incRDoc =
      typeof incoming.rDocSection === 'string' && incoming.rDocSection.trim() ? incoming.rDocSection : null;

    return {
      request: values.request ?? null,
      hascMark: values.hascMark ?? null,
      sascMark: values.sascMark ?? null,
      hacDMark: values.hacDMark ?? null,
      sacDMark: values.sacDMark ?? null,
      conference: values.conference ?? null,
      enacted: values.enacted ?? null,
      reprogrammed: values.reprogrammed ?? null,
      executed: values.executed ?? null,
      notes: incNotes ?? existing?.notes ?? null,
      rDocSection: incRDoc ?? existing?.rDocSection ?? null,
      raw: this.toJsonValue({ ...existingRaw, fieldSources, sourceAttribution, datesAdded }),
    };
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
    incoming: Omit<Prisma.ProgramElementYearUncheckedCreateInput, 'id' | 'peCode' | 'fy' | 'lastSyncedAt'>,
  ): FieldDelta[] {
    const fields: Array<keyof Omit<Prisma.ProgramElementYearUncheckedCreateInput, 'id' | 'peCode' | 'fy' | 'lastSyncedAt'>> = [
      'request',
      'hascMark',
      'sascMark',
      'hacDMark',
      'sacDMark',
      'conference',
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

  private async logSourceValue(record: PeYearInput, source: string, isWinner: boolean): Promise<void> {
    if (isWinner) {
      await this.prisma.programElementYearSourceValue.updateMany({
        where: {
          peCode: record.peCode,
          fy: record.fy,
          fieldName: '__row__',
          isWinner: true,
        },
        data: { isWinner: false },
      });
    }

    await this.prisma.programElementYearSourceValue.create({
      data: {
        peCode: record.peCode,
        fy: record.fy,
        fieldName: '__row__',
        source,
        valueJsonb: this.toJsonValue(record),
        isWinner,
      },
    });
  }

  private async emitYearDeltaChange(peCode: string, fy: number, delta: FieldDelta[]): Promise<void> {
    const primaryDelta = this.pickPrimaryDelta(delta);
    if (!primaryDelta) return;

    const oldValueRaw = this.toNumber(primaryDelta.oldValue);
    const newValueNum = this.toNumber(primaryDelta.newValue);
    if (newValueNum === null) return;

    const oldValueNum = oldValueRaw ?? (MARK_FIELDS.has(primaryDelta.field) ? 0 : null);
    if (oldValueNum === null) return;
    if (oldValueNum === newValueNum) return;

    const affected = await this.getAffectedTenants(peCode);
    if (affected.length === 0) return;

    const emission = this.buildYearEmission(peCode, fy, primaryDelta.field, oldValueNum, newValueNum);
    await this.emitForTenants(peCode, affected, emission);
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

    const deltaDays = Math.ceil((newActual.getTime() - plannedDate.getTime()) / (24 * 60 * 60 * 1000));
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

  private pickPrimaryDelta(delta: FieldDelta[]): FieldDelta | null {
    for (const entry of delta) {
      if (MARK_FIELDS.has(String(entry.field)) && this.toNumber(entry.newValue) !== null) {
        return entry;
      }
    }
    for (const entry of delta) {
      if (this.toNumber(entry.oldValue) !== null || this.toNumber(entry.newValue) !== null) {
        return entry;
      }
    }
    return null;
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
    const [watches, capabilities] = await Promise.all([
      this.prisma.programElementWatch.findMany({
        where: { peCode },
        select: { tenantId: true },
      }),
      // Cross-tenant BY DESIGN: a budget delta on a PE affects every tenant
      // whose client capability names it, so this enumeration must bypass RLS
      // (system path). client_capabilities is RLS-FORCED, so a plain read here
      // would return zero rows for the non-super app role.
      this.prisma.withSystem((tx) =>
        tx.clientCapability.findMany({
          where: { peNumber: peCode },
          select: { tenantId: true, clientId: true },
        }),
      ),
    ]);

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

  private async emitForTenants(peCode: string, affected: AffectedTenantContext[], payload: EmissionPayload): Promise<void> {
    await Promise.all(
      affected.map(({ tenantId, relatedClientIds }) =>
        this.prisma.intelligenceChange.create({
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
        }).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to emit program-element change for tenant ${tenantId}: ${message}`);
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
      return Object.values(value as Record<string, unknown>).every((item) => this.isJsonValue(item));
    }

    return false;
  }
}
