export type ReportTargetStatusField = 'prepStatus' | 'outreachStatus' | 'submissionStatus';

const DISPLAY_FIELDS = [
  'memberPrincipal',
  'committee',
  'staffer',
  'building',
  'leadOwner',
] as const;

export function requireReportYear(reportYear: number | null | undefined): number {
  if (!Number.isInteger(reportYear)) {
    throw new Error('Select a reporting year before changing a target. All Time is read-only.');
  }
  return reportYear as number;
}

export function requireTargetClient(clientId: string | null | undefined): string {
  if (!clientId?.trim()) throw new Error('Select a client for this target.');
  return clientId;
}

export function reportTargetClientLabel(row: {
  clientId: string | null;
  clientName: string | null;
}): string {
  return (
    row.clientName?.trim() ||
    (row.clientId ? `Client ${row.clientId}` : 'Unassigned — select a client')
  );
}

export function buildReportTargetCreateBody({
  values,
  directoryContactId,
  editedFields,
  reportYear,
}: {
  values: { clientId?: string; manualOnly?: boolean } & Partial<
    Record<(typeof DISPLAY_FIELDS)[number], string>
  >;
  directoryContactId?: string | null;
  editedFields: ReadonlySet<string>;
  reportYear: number | null | undefined;
}) {
  const clientId = requireTargetClient(values.clientId);
  const year = requireReportYear(reportYear);
  const manualOnly = values.manualOnly === true;
  if (!manualOnly && !directoryContactId) {
    throw new Error('Select a Directory match or explicitly choose a manual-only target.');
  }
  if (manualOnly && !values.memberPrincipal?.trim())
    throw new Error('Enter a member or principal name.');
  const body: Record<string, unknown> = {
    clientId,
    reportYear: year,
    ...(manualOnly ? { manualOnly: true } : { directoryContactId }),
  };
  // Omitted directory defaults let the server preserve existing user edits when
  // this client already has a target for the same canonical office.
  for (const field of DISPLAY_FIELDS) {
    if (manualOnly || editedFields.has(field)) body[field] = values[field]?.trim() || null;
  }
  return body;
}

export function buildReportTargetRestoreBody({
  row,
  field,
  reportYear,
}: {
  row: { clientId: string | null; officeKey: string };
  field: ReportTargetStatusField;
  reportYear: number | null | undefined;
}) {
  return {
    clientId: requireTargetClient(row.clientId),
    officeKey: row.officeKey,
    reportYear: requireReportYear(reportYear),
    field,
  };
}

export function buildReportTargetAssignment(
  row: { targetId: string | null; clientId: string | null; archivedAt?: string | null },
  clientId: string | null | undefined,
) {
  if (!row.targetId) throw new Error('This target has no saved record to assign.');
  if (row.clientId) throw new Error('This target already belongs to a client.');
  if (row.archivedAt) throw new Error('Archived targets cannot be changed.');
  return { targetId: row.targetId, body: { clientId: requireTargetClient(clientId) } };
}
