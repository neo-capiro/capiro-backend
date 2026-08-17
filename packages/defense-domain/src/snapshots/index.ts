export type DefenseSnapshotStatus =
  | 'building'
  | 'verified'
  | 'rejected'
  | 'active'
  | 'superseded';

export interface DefenseSnapshotIdentity {
  readonly snapshotId: string;
  readonly contentSha256: string;
  readonly createdAt: string;
  readonly status: DefenseSnapshotStatus;
}

export interface SnapshotBackedValue<T> {
  readonly value: T;
  readonly snapshotId: string;
  readonly snapshotActivatedAt: string;
}

export class MixedCanonicalSnapshotError extends Error {
  constructor(readonly snapshotIds: readonly string[]) {
    super(
      `A response cannot combine canonical snapshots [${[...snapshotIds].sort().join(', ')}].`,
    );
    this.name = 'MixedCanonicalSnapshotError';
  }
}

export function assertOneCanonicalSnapshot(
  values: readonly { readonly snapshotId: string | null | undefined }[],
): string | null {
  const ids = new Set(
    values
      .map((value) => value.snapshotId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  if (ids.size > 1) throw new MixedCanonicalSnapshotError([...ids]);
  return ids.values().next().value ?? null;
}
