/**
 * Stage D: hand-rolled YAML-frontmatter parser + validator for the Meri
 * Strategy Context Pack (src/context/templates/ is the in-repo contract).
 *
 * PURE module — no Nest, no Prisma, no I/O. The grammar is deliberately the
 * flat subset the 17 templates actually use: a leading `---` fence, flat
 * `key: value` scalar lines (bare scalar | double-quoted string | true/false |
 * null), and a closing `---`. Nested keys, arrays, and block scalars are
 * STRUCTURAL errors — the contract is flat by design, and a tiny exact parser
 * beats a permissive dependency (house rule: no new npm deps).
 *
 * Every failure — structural or semantic — is reported as a FIELD-LEVEL
 * FieldError so the UI can annotate the offending line/key (the Stage D
 * acceptance criterion). Vocabularies are exported as consts; Stage E (fact
 * extraction / conflict detection) reuses them.
 */
export interface FieldError {
    field: string;
    message: string;
}
export type FrontmatterValue = string | boolean | null;
export type Frontmatter = Record<string, FrontmatterValue>;
export interface ParseResult {
    frontmatter: Frontmatter | null;
    body: string;
    errors: FieldError[];
}
/** The 17 known document types, in template-pack order (00..16). */
export declare const DOCUMENT_TYPES: readonly ["context_manifest", "strategy_brief", "client_constraints", "ask_and_options", "stakeholder_map", "calendar_and_deadlines", "decision_rules", "current_plan", "evidence_register", "meeting_intelligence", "decision_log", "agent_mission", "execution_playbook", "agent_permissions", "target_budget_line", "vendor_reference_pull", "route_and_vehicle_status"];
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];
/** document_type -> SpContextDocument.templateKey (the NN_name file stem). */
export declare const TEMPLATE_KEY_BY_TYPE: Readonly<Record<DocumentTypeValue, string>>;
/** SpContextDocState mirror. */
export declare const CONTEXT_STATES: readonly ["draft", "active", "superseded", "archived"];
export type ContextStateValue = (typeof CONTEXT_STATES)[number];
/** SpContextScope mirror. NOTE: 'meeting' is in the PACK but deferred here. */
export declare const CONTEXT_SCOPES: readonly ["once", "node", "strategy", "client", "firm"];
export type ContextScopeValue = (typeof CONTEXT_SCOPES)[number];
export declare const AUTHORITIES: readonly ["firm_approved", "client_approved", "working_draft", "external_authoritative", "meeting_intelligence"];
export type AuthorityValue = (typeof AUTHORITIES)[number];
export declare const CONFIDENTIALITIES: readonly ["client_confidential", "firm_internal"];
export type ConfidentialityValue = (typeof CONFIDENTIALITIES)[number];
/** The literal placeholder the blank templates ship with — never a real date. */
export declare const DATE_PLACEHOLDER = "YYYY-MM-DD";
/**
 * The literal id placeholders the blank templates ship with — never real ids.
 * Exact-literal matches only (a real Clerk id like 'user_2NNEq…' must pass);
 * symmetric with DATE_PLACEHOLDER so filled-in dates can't smuggle these
 * fabricated ids past validation into Stage E.
 */
export declare const ID_PLACEHOLDERS: readonly ["client_123", "strategy_456", "user_123", "meeting_789"];
/**
 * Parse the leading `---` frontmatter block. Returns the parsed flat map, the
 * body (everything after the closing fence), and structural errors. On a
 * structural failure the frontmatter is null and the body falls back to the
 * whole input (nothing is guessed).
 */
export declare function parseFrontmatter(raw: string): ParseResult;
/**
 * Real-calendar-date check. `new Date('2027-02-30')` ROLLS OVER to March 2 in
 * V8 (it does not NaN), so we round-trip the UTC date part back to the input —
 * any rollover fails the equality (same trick as src/strategy/dates.ts).
 */
export declare function isRealIsoDate(value: string): boolean;
/**
 * Enforce the template contract on a parsed frontmatter map. Returns
 * field-level errors only (empty array = valid).
 */
export declare function validateFrontmatter(fm: Frontmatter): FieldError[];
//# sourceMappingURL=frontmatter.d.ts.map