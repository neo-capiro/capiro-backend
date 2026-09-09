/** The supported history starts with the 2021–2022 cycle and grows over time. */
export function fecCycles(now = new Date()): number[] {
  const year = now.getUTCFullYear();
  const currentCycle = year + (year % 2);
  return Array.from({ length: Math.max(0, (currentCycle - 2022) / 2 + 1) }, (_, i) => 2022 + i * 2);
}

/** Keep discovery aligned with EntityResolutionService.matchFecCommittee. */
export const FEC_PAC_COMMITTEE_TYPES = ['Q', 'N', 'O', 'V', 'W'] as const;
