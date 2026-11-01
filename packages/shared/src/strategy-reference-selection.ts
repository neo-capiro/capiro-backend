/** The existing per-kind tenant override rule, shared by display and Objective grounding. */
export const STRATEGY_REFERENCE_KINDS = ['congress_milestone', 'ppbe_lane_bar', 'ppbe_current_phase'] as const;
export function selectStrategyReferenceRows<T extends { kind: string }>(baseline: readonly T[], overrides: readonly T[]) {
  return STRATEGY_REFERENCE_KINDS.flatMap(kind => {
    const tenantRows = overrides.filter(row => row.kind === kind);
    const source = tenantRows.length ? 'override' as const : 'baseline' as const;
    return (tenantRows.length ? tenantRows : baseline.filter(row => row.kind === kind)).map(row => ({ source, row }));
  });
}
export interface StrategyReferenceWitnessRow {
  id: string; kind: string; label: string; fy: number | null; startsOn: string | null;
  endsOn: string | null; tone: string | null; position: number;
}
export async function readStrategyReferenceWitness(tx: {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}, tenantId: string) {
  const rows = await tx.$queryRaw<Array<StrategyReferenceWitnessRow & { source: 'baseline' | 'override' }>>`
    SELECT id::text, kind, label, fy, starts_on::text AS "startsOn", ends_on::text AS "endsOn", tone, position,
      'baseline'::text AS source FROM sp_reference_entry WHERE active
    UNION ALL
    SELECT id::text, kind, label, fy, starts_on::text AS "startsOn", ends_on::text AS "endsOn", tone, position,
      'override'::text AS source FROM sp_reference_override WHERE tenant_id=${tenantId}::uuid AND active
    ORDER BY position, id`;
  return selectStrategyReferenceRows(rows.filter(row => row.source === 'baseline'), rows.filter(row => row.source === 'override'))
    .map(({ source, row }) => ({ id: row.id, kind: row.kind, label: row.label, fy: row.fy,
      startsOn: row.startsOn, endsOn: row.endsOn, tone: row.tone, position: row.position, source }));
}
