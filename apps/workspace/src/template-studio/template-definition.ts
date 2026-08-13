// ============================================================================
// Firm Blueprint definition — the versioned, immutable contract a document is
// pinned to (Template Studio, DECISIONS §Template-Studio).
//
// A WorkspaceBlueprintDefinition is the full, self-contained description of how
// a document of a given product type is authored: intake questions, section
// structure, evidence policy, content rules, approval policy, and theme. It is
// stored verbatim as JSON on WsBlueprintVersion.definition. A published version
// is IMMUTABLE — its definitionHash is the pin an existing WsDraft carries, so
// editing the blueprint later (a new draft version) never retroactively
// changes a document already in flight.
// ============================================================================

/** Where an intake answer may come from. */
export type AnswerSource = 'user' | 'client_profile' | 'context' | 'meri_recommendation';

/** Conditional display rule for an intake question. */
export interface IntakeCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'present';
  value?: unknown;
}

/** A single intake question resolved before generation. */
export interface IntakeQuestion {
  id: string;
  label: string;
  helpText?: string;
  required: boolean;
  answerSource: AnswerSource;
  condition?: IntakeCondition;
}

/** A section of the generated document. */
export interface BlueprintSection {
  id: string;
  title: string;
  purpose: string;
  instructions: string;
  required: boolean;
  removable: boolean;
  reorderable: boolean;
  lockedByDefault: boolean;
  targetWords: { min: number; max: number };
  evidenceRules: string[];
}

/** Evidence sourcing rules enforced across the document. */
export interface EvidencePolicy {
  minimumSources: number;
  primarySourcesPreferred: boolean;
  citationRequiredFor: string[];
  freshnessRules: Array<{
    sourceType: string;
    maximumAgeDays?: number;
    currentCycleRequired?: boolean;
  }>;
}

/** Content-level rules (terms, disclaimers, authoring instructions). */
export interface ContentRules {
  requiredTerms: string[];
  prohibitedTerms: string[];
  requiredDisclaimers: string[];
  instructions: string[];
}

/** Who must approve a document built from this blueprint. */
export interface ApprovalPolicy {
  clientFacingApprovalRequired: boolean;
  permittedApproverRoles: string[];
}

/** The default theme applied to a document built from this blueprint. */
export interface BlueprintTheme {
  id: string;
  name: string;
  settings: Record<string, unknown>;
}

/**
 * The canonical, versioned blueprint definition. `schemaVersion: 1` is the
 * only supported shape today; a future migration bumps this and carries a
 * forward-migrator. Stored verbatim on WsBlueprintVersion.definition (Json).
 */
export interface WorkspaceBlueprintDefinition {
  schemaVersion: 1;
  documentType: { id: string; label: string; product: string };
  intakeQuestions: IntakeQuestion[];
  sections: BlueprintSection[];
  evidencePolicy: EvidencePolicy;
  contentRules: ContentRules;
  approvalPolicy: ApprovalPolicy;
  defaultTheme: BlueprintTheme;
}
