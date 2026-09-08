import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EngagementTaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { REPORT_ACTIVITY_COVERAGE, reportFiscalYear, reportLabel } from './report-card-format.js';
import { InsightGeneratorService } from './insight-generator.service.js';

export interface ReportCardData {
  client: { id: string; name: string; sectorTag: string | null };
  tenant: { name: string; logoS3Key: string | null };
  period: { start: Date; end: Date; label: string };
  activity: {
    meetings: number;
    /** Distinct attendee ROLES engaged across meetings (GAI-29: this is derived
     *  from `attendee.role`, not congressional offices — named honestly). */
    uniqueRoles: string[];
    outreachSent: number;
    /** Share of sent outreach with ≥1 open, in [0,1] (GAI-29: unique-open
     *  denominator; can never exceed 1). */
    outreachOpenRate: number;
    tasksCompleted: number;
    debriefsFiled: number;
    mailThreads: number;
  };
  intelligence: {
    billsTracked: number | null;
    billsByStatus: Record<string, number>;
    relatedOrganizationCount: number | null;
    lobbySpend: number | null;
    contractWins: number | null;
    coverage: {
      trackedBills: string;
      relatedOrganizations: string;
      lobbying: string;
      contracting: string;
    };
  };
  outcomes: Array<{
    title: string;
    fiscalYear: string;
    outcomeType: string;
    capability: string | null;
    notes: string | null;
  }>;
  healthTrend: Array<{ week: string; score: number }>;
  aiForwardLook: string;
  generatedAt: string;
}

@Injectable()
export class ReportCardService {
  private readonly logger = new Logger(ReportCardService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly insightGen: InsightGeneratorService,
  ) {}

  async generateReportCard(
    clientId: string,
    tenantId: string,
    period: 'quarter' | 'year' = 'quarter',
  ): Promise<ReportCardData> {
    const days = period === 'quarter' ? 90 : 365;
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [client, tenant] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: { id: true, name: true, sectorTag: true },
        }),
      ),
      this.prisma.tenant.findFirst({
        where: { id: tenantId },
        select: { name: true, logoS3Key: true },
      }),
    ]);

    if (!client) throw new NotFoundException('Client not found');

    const [meetings, outreachRecords, tasksCompleted, debriefs, mailThreads, submissions] =
      await Promise.all([
        this.prisma.withTenant(tenantId, (tx) =>
          tx.meeting.findMany({
            where: {
              clientId,
              startsAt: { gte: start, lte: now },
              status: { notIn: ['cancelled', 'canceled'] },
            },
            include: { attendees: true },
          }),
        ),
        this.prisma.withTenant(tenantId, (tx) =>
          tx.outreachRecord.findMany({
            where: { clientId, sentAt: { gte: start, lte: now }, deletedAt: null },
            select: { id: true, stats: true },
          }),
        ),
        this.prisma.withTenant(tenantId, (tx) =>
          tx.engagementTask.count({
            where: {
              clientId,
              status: EngagementTaskStatus.done,
              updatedAt: { gte: start, lte: now },
            },
          }),
        ),
        this.prisma.withTenant(tenantId, (tx) =>
          tx.meetingDebrief.count({ where: { clientId, createdAt: { gte: start, lte: now } } }),
        ),
        this.prisma.withTenant(tenantId, (tx) =>
          tx.mailThread.count({ where: { clientId, lastMessageAt: { gte: start, lte: now } } }),
        ),
        this.prisma.withTenant(tenantId, (tx) =>
          tx.clientSubmissionHistory.findMany({
            where: { clientId, updatedAt: { gte: start, lte: now } },
            include: { capability: { select: { name: true } } },
          }),
        ),
      ]);

    // GAI-29: distinct attendee ROLES engaged (the data is `attendee.role`, a
    // staffer title/role — NOT a congressional office). Named honestly so the
    // report and the AI forward-look never claim "offices met."
    const uniqueRoles = new Set<string>();
    for (const meeting of meetings) {
      for (const attendee of meeting.attendees) {
        if (attendee.role) uniqueRoles.add(attendee.role);
      }
    }

    // GAI-29: open rate = share of SENT outreach with at least one open, so it
    // is a true rate in [0,1]. (The prior code summed per-record opens and
    // divided by record count, which could exceed 100% when a record had
    // multiple opens.)
    const outreachSent = outreachRecords.length;
    let openedRecords = 0;
    for (const rec of outreachRecords) {
      const stats = rec.stats as Record<string, unknown>;
      if (typeof stats?.opens === 'number' && stats.opens > 0) openedRecords += 1;
    }
    const outreachOpenRate = outreachSent > 0 ? Math.min(1, openedRecords / outreachSent) : 0;

    // Intelligence metrics via confirmed mappings
    const [roi, trackedBills, relatedOrganizations] = await Promise.all([
      this.getLobbyRoi(clientId, tenantId),
      this.getTrackedBillsCount(clientId, tenantId),
      this.getRelatedOrganizationCount(clientId, tenantId),
    ]);

    // Weekly engagement health trend
    const weekCount = Math.min(Math.floor(days / 7), 13);
    const healthTrendRows: Array<{ start: Date; end: Date }> = [];
    for (let i = weekCount - 1; i >= 0; i--) {
      const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
      const weekStart = new Date(
        Math.max(start.getTime(), weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000),
      );
      healthTrendRows.push({ start: weekStart, end: weekEnd });
    }

    const healthTrend: Array<{ week: string; score: number }> = await Promise.all(
      healthTrendRows.map(async (w) => {
        const [wMeet, wMail, wTask, wDebrief, wOutreach] = await Promise.all([
          this.prisma.withTenant(tenantId, (tx) =>
            tx.meeting.count({
              where: {
                clientId,
                startsAt: { gte: w.start, lt: w.end },
                status: { notIn: ['cancelled', 'canceled'] },
              },
            }),
          ),
          this.prisma.withTenant(tenantId, (tx) =>
            tx.mailThread.count({
              where: { clientId, lastMessageAt: { gte: w.start, lt: w.end } },
            }),
          ),
          this.prisma.withTenant(tenantId, (tx) =>
            tx.engagementTask.count({
              where: {
                clientId,
                status: EngagementTaskStatus.done,
                updatedAt: { gte: w.start, lt: w.end },
              },
            }),
          ),
          this.prisma.withTenant(tenantId, (tx) =>
            tx.meetingDebrief.count({
              where: { clientId, createdAt: { gte: w.start, lt: w.end } },
            }),
          ),
          this.prisma.withTenant(tenantId, (tx) =>
            tx.outreachRecord.count({
              where: { clientId, sentAt: { gte: w.start, lt: w.end }, deletedAt: null },
            }),
          ),
        ]);
        const score = Math.min(
          100,
          Math.round(
            ((wMeet * 15 + wMail * 2 + wTask * 10 + wDebrief * 20 + wOutreach * 5) / 100) * 100,
          ),
        );
        return { week: w.end.toISOString().split('T')[0]!, score };
      }),
    );

    // AI forward-look
    const contextLines = [
      `CLIENT: ${client.name}`,
      `PERIOD: trailing ${period === 'quarter' ? '90 days' : '365 days'} (${start.toLocaleDateString()} – ${now.toLocaleDateString()}); NOT a federal fiscal-year period`,
      `RECORDED MEETINGS: ${meetings.length} non-cancelled calendar records (${uniqueRoles.size} distinct attendee roles listed; attendance not independently verified)`,
      `OUTREACH: ${outreachSent} sent, ${(outreachOpenRate * 100).toFixed(0)}% open rate`,
      `COMPLETED TASK RECORDS UPDATED THIS PERIOD: ${tasksCompleted} (last update is not the completion date)`,
      `DEBRIEFS FILED: ${debriefs}`,
      `MAIL THREADS ACTIVE: ${mailThreads}`,
      `BILLS TRACKED: ${trackedBills.count ?? 'Unavailable'}; ${trackedBills.coverage}`,
      `REPORTED LDA FILING INCOME: ${roi.lobbySpend === null ? 'Unavailable' : '$' + roi.lobbySpend.toLocaleString()}; ${roi.lobbyingCoverage}`,
      `REPORTED FEDERAL CONTRACT TOTAL: ${roi.contractWins === null ? 'Unavailable' : '$' + roi.contractWins.toLocaleString()}; ${roi.contractingCoverage}`,
      `OTHER LDA ORGANIZATION RECORDS WITH SHARED ISSUE CODES: ${relatedOrganizations.count ?? 'Unavailable'}; ${relatedOrganizations.coverage}`,
      `SUBMISSION RECORDS UPDATED THIS PERIOD (update date does not establish an outcome date):`,
      ...submissions.map(
        (s) => `  - ${s.title} (${reportFiscalYear(s.fiscalYear)}): ${reportLabel(s.outcomeType)}`,
      ),
    ];

    const aiPrompt = `EVIDENCE RULES:
${REPORT_ACTIVITY_COVERAGE}
Never infer inactivity, lost access, diminished influence, lobbying effectiveness, or causation between lobbying and awards from these records. Shared issue codes identify related LDA organization records, not verified competitors or a count of filings. Unavailable metrics are unknown, not zero. Financial totals cover the source's on-record history, not the report's rolling activity period, and may include amendments. Submission update dates do not prove when a win occurred. Distinguish observations from judgments and recommendations, and state coverage limits in the assessment. Do not invent accomplishments or risks; when records are absent, recommend verifying coverage.

Based on this client's activity and intelligence data for the past ${period === 'quarter' ? 'quarter (90 days)' : 'year (365 days)'}, write a 3-paragraph forward-looking assessment: (1) recorded activity and supported outcomes, (2) evidence-backed opportunities and material uncertainties, (3) recommended priorities for next period. Do not manufacture a win or a risk when the available records do not support one. Be specific and cite the data points provided.\n\n${contextLines.join('\n')}`;

    const aiForwardLook = await this.insightGen.generateFreeText(aiPrompt).catch(() => '');

    // GAI-29: label the ACTUAL rolling window (start–end). The prior label
    // (`Q{calendar-quarter} FY{calendar-year}`) was wrong twice over — the window
    // is a trailing 90/365 days, not a calendar quarter, and the federal fiscal
    // year is offset from the calendar year — so it must not be presented as an
    // FY period to clients.
    const rangeFmt = (d: Date): string =>
      d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const periodLabel =
      period === 'quarter'
        ? `Trailing 90 days (${rangeFmt(start)} – ${rangeFmt(now)})`
        : `Trailing 365 days (${rangeFmt(start)} – ${rangeFmt(now)})`;

    return {
      client: { id: client.id, name: client.name, sectorTag: client.sectorTag ?? null },
      tenant: { name: tenant?.name ?? '', logoS3Key: tenant?.logoS3Key ?? null },
      period: { start, end: now, label: periodLabel },
      activity: {
        meetings: meetings.length,
        uniqueRoles: Array.from(uniqueRoles).slice(0, 20),
        outreachSent,
        outreachOpenRate,
        tasksCompleted,
        debriefsFiled: debriefs,
        mailThreads,
      },
      intelligence: {
        billsTracked: trackedBills.count,
        billsByStatus: {},
        relatedOrganizationCount: relatedOrganizations.count,
        lobbySpend: roi.lobbySpend,
        contractWins: roi.contractWins,
        coverage: {
          trackedBills: trackedBills.coverage,
          relatedOrganizations: relatedOrganizations.coverage,
          lobbying: roi.lobbyingCoverage,
          contracting: roi.contractingCoverage,
        },
      },
      outcomes: submissions.map((s) => ({
        title: s.title,
        fiscalYear: s.fiscalYear,
        outcomeType: s.outcomeType,
        capability: s.capability?.name ?? null,
        notes: s.notes ?? null,
      })),
      healthTrend,
      aiForwardLook,
      generatedAt: now.toISOString(),
    };
  }

  private async getLobbyRoi(clientId: string, tenantId: string) {
    const [ldaMapping, contractingMapping] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findFirst({ where: { clientId, source: 'lda', confirmed: true } }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findFirst({
          where: {
            clientId,
            source: 'contracting',
            confirmed: true,
            reviewStatus: 'confirmed',
            rollUpAwards: true,
          },
        }),
      ),
    ]);

    let lobbySpend: number | null = null;
    let contractWins: number | null = null;
    let lobbyingCoverage = 'Unavailable: no confirmed LDA organization mapping.';
    let contractingCoverage =
      'Unavailable: no confirmed contracting mapping approved for award rollup.';

    if (ldaMapping) {
      const rows = await this.prisma.$queryRaw<
        Array<{
          total: number | null;
          filings: number;
          first_year: number | null;
          last_year: number | null;
        }>
      >`
        SELECT SUM(income)::float AS total, COUNT(*)::int AS filings,
               MIN(filing_year)::int AS first_year, MAX(filing_year)::int AS last_year
        FROM lda_filing WHERE client_id = ${Number(ldaMapping.externalId)}
      `;
      const row = rows[0];
      lobbySpend = row?.total ?? null;
      lobbyingCoverage = row?.filings
        ? `LDA confirmed organization mapping; ${row.filings} stored filings, filing years ${row.first_year}–${row.last_year}. Sum of reported filing income; amendments may overlap. Not a deduplicated spending or trailing-period total.`
        : 'Confirmed LDA organization mapping; no stored filings with a reported income amount.';
    }

    if (contractingMapping) {
      const rows = await this.prisma.$queryRaw<Array<{ total: number | null }>>`
        SELECT total_contracts::float AS total
        FROM federal_contractor WHERE id = ${contractingMapping.externalId}::uuid
      `;
      contractWins = rows[0]?.total ?? null;
      contractingCoverage =
        'Federal contractor source total for one confirmed mapped entity approved for award rollup. Source reporting window is not supplied; subsidiary coverage is not established. Not a measure of lobbying-attributable wins or activity-period awards.';
    }

    return { lobbySpend, contractWins, lobbyingCoverage, contractingCoverage };
  }

  private async getTrackedBillsCount(clientId: string, tenantId: string) {
    // Both apps use this database, but curate DIFFERENT membership tables.
    // Resolve exactly the UI's tracker_v2 flag; never count issue-matched bills
    // or silently substitute the stale legacy board after a v2 read failure.
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const flags = await tx.$queryRaw<Array<{ enabled: boolean }>>`
          SELECT enabled FROM intel_feature_flag
          WHERE tenant_id = ${tenantId}::uuid AND feature = 'tracker_v2'
        `;
        const intel = flags[0]?.enabled === true;
        const rows = intel
          ? await tx.$queryRaw<Array<{ count: number }>>`
              SELECT COUNT(*)::int AS count FROM intel_tracked_bill
              WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
            `
          : await tx.$queryRaw<Array<{ count: number }>>`
              SELECT COUNT(*)::int AS count FROM tracked_bill
              WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
            `;
        return {
          count: rows[0]?.count ?? 0,
          coverage: `Current curated client board (${intel ? 'LegiWatch' : 'legacy tracker'}), all stored memberships as of generation; not issue-related recommendations or bills added during the activity period.`,
        };
      });
    } catch (error) {
      this.logger.warn(
        `Report-card tracked-bill source unavailable for client ${clientId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        count: null,
        coverage: 'Unavailable: the current client tracker source could not be read.',
      };
    }
  }

  private async getRelatedOrganizationCount(clientId: string, tenantId: string) {
    const ldaMapping = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findFirst({
        where: { clientId, source: 'lda', confirmed: true },
      }),
    );
    if (!ldaMapping)
      return { count: null, coverage: 'Unavailable: no confirmed LDA organization mapping.' };

    const ldaClientId = Number(ldaMapping.externalId);
    const codeRows = await this.prisma.$queryRaw<Array<{ issue_codes: string[] }>>`
      SELECT COALESCE(issue_codes, '{}') AS issue_codes FROM lda_client WHERE id = ${ldaClientId}
    `;
    const issueCodes = codeRows[0]?.issue_codes ?? [];
    if (!issueCodes.length)
      return {
        count: null,
        coverage: 'Unavailable: no LDA issue codes for the confirmed organization.',
      };

    const countRows = await this.prisma.$queryRaw<Array<{ count: string }>>`
      SELECT COUNT(DISTINCT id)::text AS count FROM lda_client
      WHERE issue_codes && ${issueCodes}::text[] AND id != ${ldaClientId}
    `;
    return {
      count: parseInt(countRows[0]?.count ?? '0', 10),
      coverage:
        'Other LDA organization records sharing at least one broad issue code in the stored corpus, across all available years. Not verified competitors, unique corporate groups, or a count of filings.',
    };
  }
}
