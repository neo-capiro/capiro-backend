// Stage-G grounded content: POST /meri-api/strategy-document-draft
// ---------------------------------------------------------------------------

/** One drafted body section — heading + sanitized HTML + optional provenance. */
export interface DocumentDraftSection {
  heading: string;
  html: string;
  sources?: Array<{ section: string; ref?: string }>;
}

/**
 * Orchestrator-decided claim-level release verdict for a generated deliverable.
 *
 * Phase 16 carries the canonical envelope across the service boundary, but this
 * independently deployed destination deliberately does not import
 * @capiro/meriv2-core. It treats the envelope as untrusted wire data, verifies
 * its version/hash/bindings locally, and recomputes destination-side structural
 * checks before any artifact is staged.
 */
export interface DocumentDraftAssurance {
  /** True only when the orchestrator's tenant/surface rollout was in enforce. */
  held: boolean;
  /** Populated in off/shadow/enforce for observation and operator evidence. */
  blockers?: string[];
  decision?: string;
  unresolvedProvenanceSections?: string[];
  ledgerHash?: string;
  /** Untrusted wire object; execution-assurance.ts verifies it before use. */
  envelope?: Record<string, unknown>;
}

/** The full node-scoped document/message draft the orchestrator returns. */
export interface NodeDocumentDraftResponse {
  title: string | null;
  summary: string | null;
  sections: DocumentDraftSection[];
  provenance?: PackProvenance;
  groundingHealth?: GroundingHealth;
  assurance?: DocumentDraftAssurance;
  /** The model that actually produced this draft (for provenance stamping). */
  model: string | null;
}
