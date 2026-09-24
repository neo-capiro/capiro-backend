/**
 * Read-only coverage inventory. Logical expected-source slots describe what
 * should exist; physical units describe what has actually been inventoried.
 * The two collections intentionally have no one-to-one assumption: one slot
 * may point to several volumes/sections/exhibits, or one document may satisfy
 * several slots. Missing detail is unknown, never an inferred zero.
 */
export const DEFENSE_COVERAGE_INVENTORY_VERSION = 'defense_coverage_inventory_v1';

export type CoverageUnitKind = 'document' | 'volume' | 'section' | 'exhibit';
export type CoverageKnowledge = 'inventoried' | 'not_inventoried' | 'unknown';

export interface CoverageExpectedSlotInput {
  readonly slotId: string;
  readonly fiscalYear: number;
  readonly sourceFamily: string;
  readonly adapterId: string;
  readonly label: string;
  readonly optional: boolean;
}

export interface CoverageObservationInput {
  readonly observationId: string;
  readonly slotId: string;
  readonly sourceDocumentId: string | null;
  readonly observationState: string;
  readonly supersededByObservationId: string | null;
  readonly discoveredUrl?: string;
  readonly classification: 'classified' | 'unavailable' | 'review_required';
  /** Metadata may include publisher-derived volume/section/exhibit identities. */
  readonly physicalUnits?: readonly {
    readonly unitId: string;
    readonly kind: CoverageUnitKind;
    readonly label: string;
  }[];
}

export interface CoverageInventoryInput {
  readonly fiscalYear: number;
  readonly inventoryKnowledge: CoverageKnowledge;
  readonly expectedSlots: readonly CoverageExpectedSlotInput[];
  readonly observations: readonly CoverageObservationInput[];
  /** Optional member manifests (e.g. an R-2 volume catalog) are physical units, not slots. */
  readonly inventoriedUnits?: readonly {
    readonly slotId: string;
    readonly unitId: string;
    readonly kind: CoverageUnitKind;
    readonly label: string;
    readonly sourceDocumentId: string | null;
    readonly observationId: string | null;
    readonly memberStatus: 'missing' | 'observed' | 'verified';
  }[];
}

export interface DefenseCoverageInventory {
  readonly schemaVersion: typeof DEFENSE_COVERAGE_INVENTORY_VERSION;
  readonly fiscalYear: number;
  readonly inventoryKnowledge: CoverageKnowledge;
  readonly expectedSlots: readonly {
    readonly slotId: string;
    readonly sourceFamily: string;
    readonly adapterId: string;
    readonly label: string;
    readonly optional: boolean;
    readonly coverage: 'observed' | 'not_observed' | 'unknown';
    readonly observationIds: readonly string[];
  }[];
  readonly physicalUnits: readonly {
    readonly unitId: string;
    readonly kind: CoverageUnitKind;
    readonly label: string;
    readonly sourceDocumentId: string | null;
    readonly observationId: string | null;
    readonly superseded: boolean;
    readonly classification: 'classified' | 'unavailable' | 'review_required';
    readonly slotId: string | null;
    readonly memberStatus: 'missing' | 'observed' | 'verified' | null;
  }[];
}

export function buildDefenseCoverageInventory(
  input: CoverageInventoryInput,
): DefenseCoverageInventory {
  const observationsBySlot = new Map<string, CoverageObservationInput[]>();
  for (const observation of input.observations) {
    const bucket = observationsBySlot.get(observation.slotId) ?? [];
    bucket.push(observation);
    observationsBySlot.set(observation.slotId, bucket);
  }

  return {
    schemaVersion: DEFENSE_COVERAGE_INVENTORY_VERSION,
    fiscalYear: input.fiscalYear,
    inventoryKnowledge: input.inventoryKnowledge,
    expectedSlots: input.expectedSlots.map((slot) => {
      const observations = observationsBySlot.get(slot.slotId) ?? [];
      return {
        slotId: slot.slotId,
        sourceFamily: slot.sourceFamily,
        adapterId: slot.adapterId,
        label: slot.label,
        optional: slot.optional,
        coverage: observations.length > 0
          ? 'observed'
          : input.inventoryKnowledge === 'unknown' || input.inventoryKnowledge === 'not_inventoried'
            ? 'unknown'
            : 'not_observed',
        observationIds: observations.map((observation) => observation.observationId),
      };
    }),
    physicalUnits: [
      ...(input.inventoriedUnits ?? []).map((unit) => ({
        ...unit,
        classification: unit.sourceDocumentId ? 'classified' as const : 'unavailable' as const,
        superseded: false,
      })),
      ...input.observations.flatMap((observation) => [
      {
        unitId: observation.sourceDocumentId ?? `observation:${observation.observationId}`,
        kind: 'document' as const,
        label: observation.discoveredUrl ?? observation.sourceDocumentId ?? 'Observed source document (identity unavailable)',
        sourceDocumentId: observation.sourceDocumentId,
        observationId: observation.observationId,
        superseded: observation.supersededByObservationId !== null,
        classification: observation.classification,
        slotId: observation.slotId,
        memberStatus: null,
      },
      ...(observation.physicalUnits ?? []).map((unit) => ({
        ...unit,
        sourceDocumentId: observation.sourceDocumentId,
        observationId: observation.observationId,
        superseded: observation.supersededByObservationId !== null,
        classification: observation.classification,
        slotId: observation.slotId,
        memberStatus: null,
      })),
    ])],
  };
}
