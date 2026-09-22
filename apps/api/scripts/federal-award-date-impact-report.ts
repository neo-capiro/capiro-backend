export const INCIDENT_AWARD_IDS = [
  'CONT_AWD_H9222216C0078_9700_-NONE-_-NONE-',
  'CONT_AWD_W9128Z26FA001_9700_W519TC25D0039_9700',
  'CONT_AWD_FA880625FB009_9700_FA880623D0015_9700',
] as const;

export interface AwardDateImpactRow {
  id: string | null;
  awardUniqueId: string;
  piid: string | null;
  amount: number | null;
  actionDate: string | null;
  before: {
    baseAwardSignedDate: string | null;
    latestActionDate: string | null;
    sourceLastModifiedDate: string | null;
    popStartDate: string | null;
    popEndDate: string | null;
    dateSemanticsVersion: number | null;
  };
  after: {
    baseAwardSignedDate: string | null;
    latestActionDate: string | null;
    sourceLastModifiedDate: string | null;
    popStartDate: string | null;
    popEndDate: string | null;
    dateSemanticsVersion: 1;
  };
}

export interface AwardDateImpactReport {
  generatedAt: string;
  rowsExamined: number;
  baseSignedDateFound: number;
  legacyActionEqualsSourceLastModified: number;
  signedMinusActionDateDays: Record<string, number>;
  incidentAwards: Record<string, 'present' | 'absent'>;
  topAwards: AwardDateImpactRow[];
}

function dayDifference(left: string, right: string): number | null {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86_400_000) : null;
}

function bucket(days: number | null): string {
  if (days == null) return 'unknown';
  if (days === 0) return '0';
  const sign = days < 0 ? '-' : '+';
  const n = Math.abs(days);
  if (n <= 7) return `${sign}1-7`;
  if (n <= 30) return `${sign}8-30`;
  if (n <= 365) return `${sign}31-365`;
  return `${sign}>365`;
}

function dateOnly(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

export function buildAwardDateImpactReport(
  rows: AwardDateImpactRow[],
  generatedAt = new Date().toISOString(),
): AwardDateImpactReport {
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    const key = bucket(
      row.after.baseAwardSignedDate && row.actionDate
        ? dayDifference(row.after.baseAwardSignedDate, row.actionDate)
        : null,
    );
    distribution[key] = (distribution[key] ?? 0) + 1;
  }

  return {
    generatedAt,
    rowsExamined: rows.length,
    baseSignedDateFound: rows.filter((row) => row.after.baseAwardSignedDate != null).length,
    legacyActionEqualsSourceLastModified: rows.filter(
      (row) =>
        dateOnly(row.actionDate) != null &&
        dateOnly(row.actionDate) === dateOnly(row.after.sourceLastModifiedDate),
    ).length,
    signedMinusActionDateDays: distribution,
    incidentAwards: Object.fromEntries(
      INCIDENT_AWARD_IDS.map((id) => [
        id,
        rows.some((row) => row.awardUniqueId === id) ? 'present' : 'absent',
      ]),
    ),
    topAwards: [...rows]
      .sort((a, b) => (b.amount ?? Number.NEGATIVE_INFINITY) - (a.amount ?? Number.NEGATIVE_INFINITY))
      .slice(0, 20),
  };
}

export function renderAwardDateImpactMarkdown(report: AwardDateImpactReport): string {
  const lines = [
    '# Federal award date backfill impact report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `- Rows examined: ${report.rowsExamined}`,
    `- Base signed date found: ${report.baseSignedDateFound}`,
    `- Legacy action date equals source last-modified date: ${report.legacyActionEqualsSourceLastModified}`,
    `- Signed minus legacy action date buckets: ${JSON.stringify(report.signedMinusActionDateDays)}`,
    '',
    '## Incident awards',
    '',
    ...Object.entries(report.incidentAwards).map(([id, state]) => `- ${id}: ${state}`),
    '',
    '## Top awards by amount',
    '',
    '| Award | PIID | Amount | Legacy action | Base signed | Latest action | Source modified |',
    '| --- | --- | ---: | --- | --- | --- | --- |',
    ...report.topAwards.map(
      (row) =>
        `| ${row.awardUniqueId} | ${row.piid ?? ''} | ${row.amount ?? ''} | ${row.actionDate ?? ''} | ${row.after.baseAwardSignedDate ?? ''} | ${row.after.latestActionDate ?? ''} | ${row.after.sourceLastModifiedDate ?? ''} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
