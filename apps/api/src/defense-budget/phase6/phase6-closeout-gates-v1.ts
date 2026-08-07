/** Phase 6 Workstream O — permanent architecture, source-proof, and cost gates. */
export const PHASE6_NEGATIVE_CONTROL_IDS = [
  'last_numeric_value_treated_as_mark',
  'last_wins_duplicate_dedupe',
  'hasc_source_writes_request',
  'authorization_field_mapped_to_appropriations',
  'title_only_line_binding_accepted',
  'missing_procurement_account_accepted',
  'missing_page_evidence_accepted',
  'unit_guessed_from_magnitude',
  'adjustment_treated_as_absolute_total',
  'absolute_total_treated_as_adjustment',
  'hasc_sasc_disagreement_auto_resolved',
  'ndaa_conference_mapped_to_conference',
  'hacd_sacd_fields_swapped',
  'missing_appropriations_conference_comparison_passes',
  'public_law_label_alone_creates_enacted',
  'incorporated_statement_without_incorporation_proof',
  'continuing_resolution_full_year_enacted',
  'rescission_sign_reversed',
  'transfer_direction_lost_through_silent_netting',
  'transfer_amount_mapped_as_reprogrammed_total',
  'obligations_outlays_conflated',
  'stale_superseded_vehicle_proof_accepted',
  'candidate_line_binding_machine_passes',
  'canonical_writer_imported',
] as const;
export type Phase6NegativeControlId = (typeof PHASE6_NEGATIVE_CONTROL_IDS)[number];

export interface Phase6ArchitectureViolationV1 {
  code: string;
  message: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

export function scanPhase6ArchitectureSourceV1(source: string): Phase6ArchitectureViolationV1[] {
  const code = stripComments(source);
  const violations: Phase6ArchitectureViolationV1[] = [];
  const rules: Array<[string, RegExp, string]> = [
    [
      'legacy_writer_import',
      /\bProgramElementWriterService\b|program-element-writer/i,
      'Phase 6 production path may not import or invoke the legacy canonical writer',
    ],
    [
      'canonical_native_writer',
      /\b(?:ProgramElementWriterService|ProcurementBudgetLineWriter|OmSagWriter|MilconProjectWriter)\b/i,
      'Phase 6 production path may not import a canonical native-line writer',
    ],
    [
      'prisma_dml',
      /\bPrismaClient\b|\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$queryRaw/,
      'Phase 6 stage/extraction production paths may not perform direct Prisma/canonical DML',
    ],
    [
      'legacy_public_law_loader',
      /ConferenceReportParserService|conferenceReportSource\(['"]public_law['"]\)/,
      'legacy public-law promotion parser is forbidden',
    ],
    [
      'legacy_committee_parser_base',
      /committee-report-parser(?:\.service)?/i,
      'Phase 6 stage extractors may not import the legacy committee parser base',
    ],
    [
      'last_wins_dedupe',
      /(?:last\s*wins|lastWins|map\.set\([^\n]+row[^\n]+\))/i,
      'last-wins duplicate resolution is forbidden',
    ],
    [
      'last_amount_mark_logic',
      /(?:last\s+(?:numeric|amount)|amounts?\.at\(-1\)|values?\.at\(-1\)).*(?:mark|recommend|appropriat|authoriz)/i,
      'last numeric/amount positional mark logic is forbidden',
    ],
    [
      'direct_product_provision_write',
      /committeeReportProvision\.(?:create|update|upsert|delete)|provisionPeLink\.(?:create|update|upsert|delete)/i,
      'direct product provision writes are forbidden',
    ],
    [
      'paid_parser_direct',
      /llamaparse|LlamaParse|paidParser\.parse|paid_page_verifier\.parse/i,
      'Phase 6 source modules may not invoke paid parser providers directly',
    ],
  ];
  for (const [codeValue, pattern, message] of rules) {
    if (pattern.test(code)) violations.push({ code: codeValue, message });
  }
  return violations;
}

export interface Phase6SourceDescriptorV1 {
  logicalKey: string;
  expectedSourceSha256: string;
  actualSourceSha256: string;
  expectedSourceUrl?: string;
  actualSourceUrl?: string;
  sourceDocumentStatus: 'current' | 'superseded';
  paidPages: number;
  paidPageCap: number;
}

export function validatePhase6SourceDescriptorV1(
  descriptor: Phase6SourceDescriptorV1,
): Phase6ArchitectureViolationV1[] {
  const violations: Phase6ArchitectureViolationV1[] = [];
  if (descriptor.expectedSourceSha256 !== descriptor.actualSourceSha256) {
    violations.push({ code: 'source_hash_mismatch', message: 'parser/source proof SHA mismatch' });
  }
  if (
    descriptor.expectedSourceUrl != null &&
    descriptor.actualSourceUrl != null &&
    descriptor.expectedSourceUrl !== descriptor.actualSourceUrl
  ) {
    violations.push({
      code: 'source_url_drift',
      message: `logical source ${descriptor.logicalKey} resolved to a different URL`,
    });
  }
  if (descriptor.sourceDocumentStatus !== 'current') {
    violations.push({
      code: 'source_document_superseded',
      message: 'superseded SourceDocument cannot be used as current proof',
    });
  }
  if (descriptor.paidPages > descriptor.paidPageCap) {
    violations.push({
      code: 'paid_page_cap_exceeded',
      message: `paid verifier pages ${descriptor.paidPages} exceed cap ${descriptor.paidPageCap}`,
    });
  }
  return violations;
}

export function assertPhase6CloseoutSourceDescriptorV1(descriptor: Phase6SourceDescriptorV1): void {
  const violations = validatePhase6SourceDescriptorV1(descriptor);
  if (violations.length > 0) {
    throw new Error(violations.map((violation) => `${violation.code}: ${violation.message}`).join('; '));
  }
}
