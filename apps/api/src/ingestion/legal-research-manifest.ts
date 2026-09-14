export type LegalResearchManifest = {
  jurisdiction: 'FL';
  edition: string;
  sessionKey: string;
  citations: string[];
  billIds: string[];
  constitutionArticles?: string[];
  adoptedRules?: Array<{ ruleNumber: string; sourceUrl: string }>;
  hydrateDocuments?: boolean;
  documentBudget?: number;
};
export function legalResearchManifest(input: unknown): LegalResearchManifest {
  const b = input as LegalResearchManifest;
  const strings = (v: unknown, max: number) =>
    Array.isArray(v) &&
    v.length <= max &&
    v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 180);
  if (
    !b ||
    b.jurisdiction !== 'FL' ||
    !/^20\d{2}$/.test(b.edition) ||
    typeof b.sessionKey !== 'string' ||
    !b.sessionKey ||
    b.sessionKey.length > 60 ||
    !strings(b.citations, 30) ||
    !strings(b.billIds, 30)
  )
    throw Error('EXPLICIT_BOUNDED_FLORIDA_MANIFEST_REQUIRED');
  if (
    b.constitutionArticles !== undefined &&
    (!strings(b.constitutionArticles, 3) ||
      b.constitutionArticles.some(
        (a) =>
          !['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'].includes(a),
      ))
  )
    throw Error('BOUNDED_CONSTITUTION_ARTICLES_REQUIRED');
  if (
    b.adoptedRules !== undefined &&
    (!Array.isArray(b.adoptedRules) ||
      b.adoptedRules.length > 3 ||
      b.adoptedRules.some(
        (r) =>
          !r ||
          !/^\d+[A-Z]*-\d+[A-Z]*\.\d+$/.test(r.ruleNumber) ||
          typeof r.sourceUrl !== 'string' ||
          r.sourceUrl.length > 2000,
      ))
  )
    throw Error('BOUNDED_PUBLISHER_RULE_LINKS_REQUIRED');
  if (
    !b.citations.length &&
    !b.billIds.length &&
    !b.constitutionArticles?.length &&
    !b.adoptedRules?.length
  )
    throw Error('EMPTY_SOURCE_MANIFEST');
  if (b.hydrateDocuments !== undefined && typeof b.hydrateDocuments !== 'boolean')
    throw Error('EXPLICIT_HYDRATION_POLICY_REQUIRED');
  if (
    b.hydrateDocuments &&
    (!b.billIds.length ||
      !Number.isSafeInteger(b.documentBudget) ||
      Number(b.documentBudget) < 1 ||
      Number(b.documentBudget) > 30)
  )
    throw Error('BOUNDED_DOCUMENT_BUDGET_REQUIRED');
  return { ...b, billIds: [...new Set(b.billIds)].sort(), citations: [...new Set(b.citations)] };
}
