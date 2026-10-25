/** Native reads whose result shape depends on the tenant's evidence-accuracy
 * mode. Shared by the Meri tool transport and the application-authority
 * read-mode observation; it has no runtime dependencies. */
export const MERI_EVIDENCE_MODE_READS = [
  'search_federal_grants',
  'search_federal_awards',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'search_sam_opportunities',
] as const;
export type MeriEvidenceModeReadOperation = (typeof MERI_EVIDENCE_MODE_READS)[number];

export function isMeriEvidenceModeRead(name: string): name is MeriEvidenceModeReadOperation {
  return (MERI_EVIDENCE_MODE_READS as readonly string[]).includes(name);
}
