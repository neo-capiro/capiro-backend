export interface QueueAgeRow {
  state: string;
  oldest: Date | null;
}

export function oldestActionableQueueAgeMs(rows: QueueAgeRow[], logicalNow: Date): number | null {
  const oldest = rows
    .filter((row) => (row.state === 'pending' || row.state === 'leased') && row.oldest !== null)
    .map((row) => row.oldest!.getTime())
    .sort((left, right) => left - right)[0];

  return oldest === undefined ? null : Math.max(0, logicalNow.getTime() - oldest);
}

export function sourceRegistrationToEvidenceCommitMs(
  registrationAt: Date,
  committedAt: Date,
): number {
  return Math.max(0, committedAt.getTime() - registrationAt.getTime());
}
