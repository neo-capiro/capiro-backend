export interface CanonicalBackfillReplayResolution {
  key: string;
  selectedEntityId: string | null;
}

export interface CanonicalBackfillReplaySnapshot {
  entityIds: readonly string[];
  aliasKeys: readonly string[];
  identifierKeys: readonly string[];
  resolutions: readonly CanonicalBackfillReplayResolution[];
  cursor: string | null;
}

export interface CanonicalBackfillReplayReport {
  addedEntityIds: string[];
  addedAliasKeys: string[];
  addedIdentifierKeys: string[];
  duplicateEntityIds: string[];
  duplicateAliasKeys: string[];
  duplicateIdentifierKeys: string[];
  changedSelections: Array<{
    key: string;
    firstSelectedEntityId: string | null;
    secondSelectedEntityId: string | null;
  }>;
  cursorStable: boolean;
  pass: boolean;
}

/**
 * Evaluate one bounded backfill cohort after running the exact same cohort a
 * second time. The replay is safe only when identity cardinality and selected
 * canonical entities remain stable.
 */
export function evaluateCanonicalBackfillReplay(
  first: CanonicalBackfillReplaySnapshot,
  second: CanonicalBackfillReplaySnapshot,
): CanonicalBackfillReplayReport {
  const addedEntityIds = difference(second.entityIds, first.entityIds);
  const addedAliasKeys = difference(second.aliasKeys, first.aliasKeys);
  const addedIdentifierKeys = difference(second.identifierKeys, first.identifierKeys);
  const duplicateEntityIds = duplicates(second.entityIds);
  const duplicateAliasKeys = duplicates(second.aliasKeys);
  const duplicateIdentifierKeys = duplicates(second.identifierKeys);

  const firstSelections = new Map(
    first.resolutions.map((resolution) => [resolution.key, resolution.selectedEntityId]),
  );
  const changedSelections: CanonicalBackfillReplayReport['changedSelections'] = [];
  for (const resolution of second.resolutions) {
    if (!firstSelections.has(resolution.key)) continue;
    const firstSelectedEntityId = firstSelections.get(resolution.key) ?? null;
    if (firstSelectedEntityId !== resolution.selectedEntityId) {
      changedSelections.push({
        key: resolution.key,
        firstSelectedEntityId,
        secondSelectedEntityId: resolution.selectedEntityId,
      });
    }
  }

  const cursorStable = first.cursor === second.cursor;
  const pass =
    addedEntityIds.length === 0 &&
    addedAliasKeys.length === 0 &&
    addedIdentifierKeys.length === 0 &&
    duplicateEntityIds.length === 0 &&
    duplicateAliasKeys.length === 0 &&
    duplicateIdentifierKeys.length === 0 &&
    changedSelections.length === 0 &&
    cursorStable;

  return {
    addedEntityIds,
    addedAliasKeys,
    addedIdentifierKeys,
    duplicateEntityIds,
    duplicateAliasKeys,
    duplicateIdentifierKeys,
    changedSelections,
    cursorStable,
    pass,
  };
}

function difference(next: readonly string[], previous: readonly string[]): string[] {
  const previousSet = new Set(previous);
  return [...new Set(next.filter((value) => !previousSet.has(value)))].sort();
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}
