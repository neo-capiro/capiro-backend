/** Display saved fiscal-year values consistently (2027, 27, FY27 or FY2027). */
export function reportFiscalYear(value: string | null | undefined): string {
  const year = (value ?? '').trim().replace(/^(?:FY\s*)+/i, '');
  return year ? `FY${year}` : 'Fiscal year not set';
}

/** Internal enum keys are metadata, not client-facing prose. */
export function reportLabel(value: string): string {
  const label = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  return label ? label[0]!.toUpperCase() + label.slice(1) : 'Not set';
}

export const REPORT_ACTIVITY_COVERAGE =
  'Activity counts reflect records linked to this client in Capiro during the stated period. ' +
  'They do not establish all real-world activity: disconnected mailboxes, unlogged work, duplicate calendar records and delayed syncs can affect coverage. ' +
  'Completed task counts include tasks currently marked done whose records were updated in the period; the update date does not establish when they were completed. ' +
  'Zero recorded activity is not evidence of no engagement or diminished influence.';
