/** Never borrow another source's geography vintage, or infer it from fiscal year. */
export function gsaBoundaryLabel(boundaryCongresses?: Array<number | null>): string {
  if (!boundaryCongresses?.length || boundaryCongresses.some((value) => value == null)) {
    return 'district vintage source-unknown (not inferred)';
  }
  const known = [
    ...new Set(boundaryCongresses.filter((value): value is number => value != null)),
  ].sort((a, b) => a - b);
  return known.length === 1
    ? `source boundary Congress ${known[0]}`
    : `mixed source boundary Congresses ${known.join(', ')}`;
}

const SECTOR_METRIC_LABELS: Readonly<Record<string, string>> = {
  annual_payroll_usd: 'Annual payroll',
  q1_payroll_usd: 'First-quarter payroll',
  employment: 'Employment',
  establishments: 'Establishments',
};

/** Keep unknown measurements identifiable; a sector's name is not a metric. */
export function sectorMetricLabel(metricKey: string): string {
  return SECTOR_METRIC_LABELS[metricKey] ?? metricKey.replace(/_/g, ' ');
}
