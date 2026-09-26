import type { LedgerEntry } from '../grounding/auditor';
import {
  buildAssuredClaimLedger,
  type AssuredClaimType,
  type AssuredEvidence,
  type ClaimCandidate,
  type ClaimLedger,
} from './claim-ledger';
import { inferClaimCategories, type DomainEvidencePlan, type EvidenceClass } from './evidence-plan';
import { deriveEvidenceDates } from './evidence-dates';

export interface CitationLike {
  n: number;
  tool: string;
  id: string;
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  type?: string;
  source?: { observedAt?: string };
  documentEvidence?: { observedAt: string | null };
}

const FORM_B_RE = /\[S:([a-zA-Z0-9_\-]+):([^\]\s]+)\]/g;
const FORM_A_RE = /\[(\d+)\]/g;

/**
 * Build a claim ledger from the final answer and the exact same-turn tool/citation
 * ledger. This is intentionally conservative: uncited factual sentences remain
 * unsupported, and empty tool results never become complete absence evidence.
 */
export function buildClaimLedgerFromToolResults(input: {
  output: string;
  ledgerEntries: readonly LedgerEntry[];
  citations?: readonly CitationLike[];
  plan?: DomainEvidencePlan;
  classification?: EvidenceClassification;
}): ClaimLedger {
  const evidence = evidenceFromToolResults(input.ledgerEntries, input.citations ?? [], input.plan, {
    classification: input.classification,
  });
  const formBByToken = new Map<string, string>();
  for (const item of evidence) {
    if (item.id.startsWith('formb:')) {
      const [, tool, ...rest] = item.id.split(':');
      formBByToken.set(`[S:${tool}:${rest.join(':')}]`, item.id);
    }
  }
  const formAByNumber = new Map<number, string>();
  for (const citation of input.citations ?? []) {
    formAByNumber.set(citation.n, citationEvidenceId(citation));
  }

  const candidates: ClaimCandidate[] = sentences(input.output).map((text, index) => {
    const sourceIds: string[] = [];
    for (const match of text.matchAll(FORM_B_RE)) {
      const token = match[0];
      const id = formBByToken.get(token);
      if (id) sourceIds.push(id);
    }
    for (const match of text.matchAll(FORM_A_RE)) {
      const id = formAByNumber.get(Number(match[1]));
      if (id) sourceIds.push(id);
    }
    const category = inferClaimCategories(text)[0] ?? 'general_background';
    return {
      id: `sentence-${index + 1}`,
      text,
      type: classifyClaimType(text),
      category,
      sourceIds: [...new Set(sourceIds)],
      confidence: confidenceFromLanguage(text),
    };
  });
  return buildAssuredClaimLedger(candidates, evidence, { plan: input.plan });
}

export function evidenceFromToolResults(
  ledgerEntries: readonly LedgerEntry[],
  citations: readonly CitationLike[],
  plan?: DomainEvidencePlan,
  options: { classification?: EvidenceClassification } = {},
): AssuredEvidence[] {
  const classification = options.classification ?? 'legacy';
  const classify = classification === 'profiles' ? evidenceClassForTool : legacyEvidenceClassForTool;
  const isPrimary = classification === 'profiles' ? primaryTool : legacyPrimaryTool;
  const isAuthoritative = classification === 'profiles' ? authoritativeTool : legacyAuthoritativeTool;
  const evidence: AssuredEvidence[] = [];
  const entryByTool = new Map<string, LedgerEntry[]>();
  for (const entry of ledgerEntries) {
    const bucket = entryByTool.get(entry.tool) ?? [];
    bucket.push(entry);
    entryByTool.set(entry.tool, bucket);
  }
  for (const citation of citations) {
    const entries = entryByTool.get(citation.tool) ?? [];
    const resolves = entries.some((entry) => entry.serialized.includes(citation.id));
    const dates = deriveEvidenceDates({ citation: citation as Parameters<typeof deriveEvidenceDates>[0]['citation'] });
    evidence.push({
      id: citationEvidenceId(citation),
      sourceType: citation.tool,
      sourceId: citation.id,
      evidenceClass: classify(citation.tool),
      ...(citation.title ? { title: citation.title } : {}),
      ...(citation.url ? { url: citation.url } : {}),
      ...(dates.publishedAt ? { publishedAt: dates.publishedAt } : {}),
      ...(dates.effectiveAt ? { effectiveAt: dates.effectiveAt } : {}),
      ...(dates.retrievedAt ? { retrievedAt: dates.retrievedAt } : {}),
      primary: isPrimary(citation.tool),
      authoritative: resolves && isAuthoritative(citation.tool),
      requirementIds: requirementIdsForTool(citation.tool, plan),
      // The ordinary citation extractor does not prove result-set completeness.
      // Negative/exhaustive claims therefore stay unsupported unless a future
      // tool explicitly supplies complete coverage metadata.
      coverage: {
        description: 'Cited record only; result-set completeness not established.',
        complete: false,
        truncated: false,
        failedSources: resolves ? [] : [citation.tool],
      },
    });
  }

  for (const entry of ledgerEntries) {
    for (const token of entry.serialized.matchAll(FORM_B_RE)) {
      const tool = token[1]!;
      const sourceId = token[2]!;
      if (tool !== entry.tool) continue;
      const id = `formb:${tool}:${sourceId}`;
      if (evidence.some((item) => item.id === id)) continue;
      evidence.push({
        id,
        sourceType: tool,
        sourceId,
        evidenceClass: classify(tool),
        primary: isPrimary(tool),
        authoritative: isAuthoritative(tool) && entry.serialized.includes(sourceId),
        requirementIds: requirementIdsForTool(tool, plan),
        coverage: {
          description: 'Exact cited record; result-set completeness not established.',
          complete: false,
          truncated: false,
          failedSources: [],
        },
      });
    }
  }
  return evidence;
}

export function classifyClaimType(text: string): AssuredClaimType {
  if (/\b(?:recommend|should|consider|next\s+step|engage|ask\s+for|contact)\b/i.test(text)) {
    return 'recommendation';
  }
  if (
    /\b(?:likely|unlikely|may|might|could|appears?|suggests?|we\s+infer|assessment)\b/i.test(text)
  ) {
    return 'inference';
  }
  if (
    /\b(?:uncertain|unknown|not\s+verified|could\s+not\s+confirm|insufficient\s+evidence|no\s+reliable\s+source)\b/i.test(
      text,
    )
  ) {
    return 'uncertainty';
  }
  return 'fact';
}

export type EvidenceClassification = 'legacy' | 'profiles';

export interface ToolEvidenceProfile {
  evidenceClass: EvidenceClass;
  primary: boolean;
  authoritative: boolean;
}

function official(evidenceClass: EvidenceClass): ToolEvidenceProfile {
  return { evidenceClass, primary: true, authoritative: true };
}

/** Capiro's own operational record (email, tasks, calendar, CRM search). Self-
 *  authoritative: there is no more primary source for "did we send this email"
 *  than Capiro's own system, so these stay primary/authoritative like an
 *  official record does. */
const CAPIRO_OWN_RECORD: ToolEvidenceProfile = {
  evidenceClass: 'capiro_system_of_record',
  primary: true,
  authoritative: true,
};

/**
 * Capiro's own COMPUTED/DERIVED output — a score, match explanation,
 * comparison, ranking, synthesized brief/memo/plan/strategy — or an
 * action/mutation tool with no independent evidentiary content of its own.
 * Never primary, never authoritative: a claim citing Capiro's own judgment
 * must not be calibrated as trustworthy as one citing an independently
 * verifiable record. This is also the SAFE fallback below for any tool name
 * not listed in {@link TOOL_EVIDENCE_PROFILES} — a new or unrecognized tool
 * must be explicitly classified before it can be treated as authoritative.
 */
const CAPIRO_DERIVED: ToolEvidenceProfile = {
  evidenceClass: 'capiro_system_of_record',
  primary: false,
  authoritative: false,
};

const SECONDARY_REPORTING: ToolEvidenceProfile = {
  evidenceClass: 'secondary_reporting',
  primary: false,
  authoritative: false,
};

/**
 * Every tool name the Meri tool-dispatch switch
 * (apps/api/src/meri/meri-tools.service.ts) and the meriv2-orchestrator's
 * retrieval recipes (apps/meriv2-orchestrator/src/meri/meriv3/meriv3-retrieval-*)
 * can attach to a citation or ledger entry, mapped to how its result should be
 * treated as evidence. Deliberately a flat, explicit table rather than a
 * cascade of regexes with a dangerous "everything else is official" fallthrough:
 * every tool must be reviewed and listed here on purpose. See CAPIRO_DERIVED for
 * what happens to a tool that is not.
 */
export const TOOL_EVIDENCE_PROFILES: Readonly<Record<string, ToolEvidenceProfile>> = {
  // ── Official action / vote status ─────────────────────────────────────
  get_bill_status: official('official_action_vote_status'),
  get_state_bill_status: official('official_action_vote_status'),
  search_floor_votes: official('official_action_vote_status'),
  search_state_floor_votes: official('official_action_vote_status'),
  get_state_rule_status: official('official_action_vote_status'),

  // ── Primary legislative/legal text ────────────────────────────────────
  search_congress_bills: official('primary_legislative_legal_text'),
  search_state_bills: official('primary_legislative_legal_text'),
  get_legal_reference: official('primary_legislative_legal_text'),

  // ── Official budget exhibit / mark / law ──────────────────────────────
  get_pe_budget_timeline: official('official_budget_exhibit_mark_law'),
  get_program_element: official('official_budget_exhibit_mark_law'),
  get_pe_report_language: official('official_budget_exhibit_mark_law'),
  get_pe_bills: official('official_budget_exhibit_mark_law'),
  get_pe_contractors: official('official_budget_exhibit_mark_law'),
  search_program_elements: official('official_budget_exhibit_mark_law'),

  // ── Committee / agency guidance ───────────────────────────────────────
  query_regulatory_dockets: official('committee_agency_guidance'),
  get_committee_roster: official('committee_agency_guidance'),

  // ── Controlled certification status (Stage 4b) ─────────────────────────
  // Reads the official FedRAMP Marketplace registry directly; not a Capiro-derived
  // summary. See docs/meri/grounding/stage-4/4b-status-provenance.md.
  get_certification_status: official('official_government_data'),

  // ── Other independently-sourced government/public records ─────────────
  get_acquisition_person: official('official_government_data'),
  search_acquisition_personnel: official('official_government_data'),
  get_state_legislator: official('official_government_data'),
  list_members: official('official_government_data'),
  get_representation: official('official_government_data'),
  resolve_entity: official('official_government_data'),
  search_cbo_cost_estimates: official('official_government_data'),
  search_committee_hearings: official('official_government_data'),
  search_crs_reports: official('official_government_data'),
  search_gao_reports: official('official_government_data'),
  search_lda_filings: official('official_government_data'),
  search_sec_filings: official('official_government_data'),
  search_fara_registrations: official('official_government_data'),
  search_federal_awards: official('official_government_data'),
  search_federal_grants: official('official_government_data'),
  search_sam_opportunities: official('official_government_data'),
  search_funding_opportunities: official('official_government_data'),
  get_funding_opportunity: official('official_government_data'),
  get_funding_opportunity_requirements: official('official_government_data'),
  query_economic_data: official('official_government_data'),
  // Mixed public context and verified client nexus are Capiro projections, not primary source records.
  get_district_nexus_context: CAPIRO_DERIVED,
  get_district_nexus_changes: CAPIRO_DERIVED,
  query_global_data: official('official_government_data'),
  list_global_datasets: official('official_government_data'),
  search_tracked_bills: official('official_government_data'),
  lookup_client_registry: official('official_government_data'),
  get_florida_budget_project: official('official_government_data'),
  query_intelligence: official('official_government_data'),

  // ── Institutional memory (internal knowledge search) ───────────────────
  // search_memory is deliberately not primary/authoritative like its two
  // siblings: free recall over saved memory, unlike a specific saved document
  // or research note, carries no source identity of its own.
  search_memory: { evidenceClass: 'institutional_memory', primary: false, authoritative: false },
  search_client_knowledge: official('institutional_memory'),
  read_client_documents: official('institutional_memory'),
  search_legislative_research: official('institutional_memory'),

  // ── Secondary/public reporting ──────────────────────────────────────────
  search_public_web: SECONDARY_REPORTING,
  scrape_web_page: SECONDARY_REPORTING,
  search_intel_articles: SECONDARY_REPORTING,
  search_legiwatch_news: SECONDARY_REPORTING,
  // Server-captured research-session attachments of unknown provenance until
  // read; treated like a scraped page rather than assumed authoritative.
  get_research_evidence: SECONDARY_REPORTING,

  // ── Capiro's own operational records (self-authoritative) ──────────────
  get_client_context: CAPIRO_OWN_RECORD,
  query_tasks: CAPIRO_OWN_RECORD,
  query_debriefs: CAPIRO_OWN_RECORD,
  query_outreach: CAPIRO_OWN_RECORD,
  list_emails: CAPIRO_OWN_RECORD,
  search_emails: CAPIRO_OWN_RECORD,
  get_email_thread: CAPIRO_OWN_RECORD,
  list_upcoming_meetings: CAPIRO_OWN_RECORD,
  list_scheduled_tasks: CAPIRO_OWN_RECORD,
  find_contacts: CAPIRO_OWN_RECORD,
  search_research_sources: CAPIRO_OWN_RECORD,

  // ── Capiro's own computed/derived judgment: Funding Opportunities (P37) ─
  // search_funding_opportunities / get_funding_opportunity / requirements
  // stay official_government_data above: their content is the notice itself.
  // These five instead surface Capiro's own scoring, composition or plan.
  explain_opportunity_match: CAPIRO_DERIVED,
  get_opportunity_client_context: CAPIRO_DERIVED,
  get_opportunity_government_landscape: CAPIRO_DERIVED,
  compare_funding_opportunities: CAPIRO_DERIVED,
  build_opportunity_action_plan: CAPIRO_DERIVED,

  // ── Capiro's own computed/derived judgment: research & strategy ────────
  research_federal_market_strategy: CAPIRO_DERIVED,
  run_analysis: CAPIRO_DERIVED,
  search_capiro_data: CAPIRO_DERIVED,
  find_path_to: CAPIRO_DERIVED,
  query_knowledge_graph: CAPIRO_DERIVED,
  query_action_items: CAPIRO_DERIVED,
  create_meeting_brief: CAPIRO_DERIVED,
  draft_policy_memo: CAPIRO_DERIVED,
  compare_florida_budget_amounts: CAPIRO_DERIVED,
  prepare_legiwatch_briefing: CAPIRO_DERIVED,
  get_legiwatch_review: CAPIRO_DERIVED,
  compare_legislative_versions: CAPIRO_DERIVED,
  preview_legiwatch_relevance: CAPIRO_DERIVED,
  // meriv2-orchestrator retrieval recipes (apps/meriv2-orchestrator/src/meri/
  // meriv3/meriv3-retrieval-*.ts): each composes/ranks/scores across several
  // leaf tool calls and self-reports its OWN name as the citation tool,
  // rather than the leaf tools it read from.
  query_relationship_brief: CAPIRO_DERIVED,
  query_client_changes: CAPIRO_DERIVED,
  query_portfolio_changes: CAPIRO_DERIVED,
  research_external_company: CAPIRO_DERIVED,
  query_portfolio_overlap: CAPIRO_DERIVED,
  query_funding_opportunity_match: CAPIRO_DERIVED,

  // ── Actions/mutations: no independent evidentiary content ──────────────
  save_note: CAPIRO_DERIVED,
  save_chat_attachments: CAPIRO_DERIVED,
  send_email: CAPIRO_DERIVED,
  reply_email: CAPIRO_DERIVED,
  save_memory: CAPIRO_DERIVED,
  confirm_memory: CAPIRO_DERIVED,
  correct_memory: CAPIRO_DERIVED,
  forget_memory: CAPIRO_DERIVED,
  create_word: CAPIRO_DERIVED,
  create_excel: CAPIRO_DERIVED,
  create_powerpoint: CAPIRO_DERIVED,
  schedule_task: CAPIRO_DERIVED,
  cancel_scheduled_task: CAPIRO_DERIVED,
  create_client: CAPIRO_DERIVED,
  create_task: CAPIRO_DERIVED,
  update_task: CAPIRO_DERIVED,
  update_client_profile: CAPIRO_DERIVED,
  save_legislative_research: CAPIRO_DERIVED,
  save_legiwatch_relevance: CAPIRO_DERIVED,
  apply_legiwatch_suggestion: CAPIRO_DERIVED,
};

function toolProfile(tool: string): ToolEvidenceProfile {
  return TOOL_EVIDENCE_PROFILES[tool] ?? CAPIRO_DERIVED;
}

function evidenceClassForTool(tool: string): EvidenceClass {
  return toolProfile(tool).evidenceClass;
}

function primaryTool(tool: string): boolean {
  return toolProfile(tool).primary;
}

function authoritativeTool(tool: string): boolean {
  return toolProfile(tool).authoritative;
}

export function legacyEvidenceClassForTool(tool: string): EvidenceClass {
  if (
    /^(?:get_bill_status|get_state_bill_status|search_floor_votes|search_state_floor_votes|get_state_rule_status)$/.test(
      tool,
    )
  ) {
    return 'official_action_vote_status';
  }
  if (/^(?:search_congress_bills|search_state_bills)$/.test(tool)) {
    return 'primary_legislative_legal_text';
  }
  if (
    /^(?:get_pe_budget_timeline|get_program_element|get_pe_report_language|get_pe_bills|get_funding_positions)$/.test(
      tool,
    )
  ) {
    return 'official_budget_exhibit_mark_law';
  }
  if (/^(?:query_regulatory_dockets|get_committee_roster)$/.test(tool)) {
    return 'committee_agency_guidance';
  }
  if (
    /^(?:get_client_context|query_tasks|query_debriefs|query_outreach|list_emails|search_emails)$/.test(
      tool,
    )
  ) {
    return 'capiro_system_of_record';
  }
  if (/^(?:search_memory|search_client_knowledge|read_client_documents)$/.test(tool)) {
    return 'institutional_memory';
  }
  if (/^(?:search_public_web|scrape_web_page|search_intel_articles)$/.test(tool)) {
    return 'secondary_reporting';
  }
  return 'official_government_data';
}

export function legacyPrimaryTool(tool: string): boolean {
  return !/^(?:search_public_web|scrape_web_page|search_intel_articles|search_memory)$/.test(tool);
}

export function legacyAuthoritativeTool(tool: string): boolean {
  return !/^(?:search_public_web|scrape_web_page|search_intel_articles|search_memory|query_knowledge_graph)$/.test(
    tool,
  );
}

export interface EvidenceClassificationComparison {
  evidenceItems: number;
  evidenceChanged: number;
  toolsChanged: string[];
  claims: number;
  claimSupportChanged: number;
  claimConfidenceChanged: number;
  primarySourcePresentChanged: number;
}

export function compareEvidenceClassification(input: {
  ledgerEntries: readonly LedgerEntry[];
  citations?: readonly CitationLike[];
  plan?: DomainEvidencePlan;
  output: string;
}): EvidenceClassificationComparison {
  const legacy = buildClaimLedgerFromToolResults({ ...input, classification: 'legacy' });
  const profiles = buildClaimLedgerFromToolResults({ ...input, classification: 'profiles' });
  const profileEvidence = new Map(profiles.evidence.map((item) => [item.id, item]));
  const changedEvidence = legacy.evidence.filter((item) => {
    const other = profileEvidence.get(item.id);
    return Boolean(other) && (
      item.evidenceClass !== other!.evidenceClass ||
      item.primary !== other!.primary ||
      item.authoritative !== other!.authoritative
    );
  });
  const profileClaims = new Map(profiles.claims.map((claim) => [claim.id, claim]));
  let claimSupportChanged = 0;
  let claimConfidenceChanged = 0;
  let primarySourcePresentChanged = 0;
  for (const claim of legacy.claims) {
    const other = profileClaims.get(claim.id);
    if (!other) continue;
    if (Boolean(claim.unsupportedReason) !== Boolean(other.unsupportedReason)) claimSupportChanged += 1;
    if (claim.confidence !== other.confidence) claimConfidenceChanged += 1;
    if (claim.primarySourcePresent !== other.primarySourcePresent) primarySourcePresentChanged += 1;
  }
  return {
    evidenceItems: legacy.evidence.length,
    evidenceChanged: changedEvidence.length,
    toolsChanged: [...new Set(changedEvidence.map((item) => item.sourceType))].sort(),
    claims: legacy.claims.length,
    claimSupportChanged,
    claimConfidenceChanged,
    primarySourcePresentChanged,
  };
}

function requirementIdsForTool(tool: string, plan?: DomainEvidencePlan): string[] {
  if (!plan) return [];
  return plan.requirements
    .filter(
      (requirement) =>
        requirement.toolFamilies.includes(tool) ||
        requirement.toolFamilies.includes('domain_specific_tools'),
    )
    .map((requirement) => requirement.id);
}

function confidenceFromLanguage(text: string): 'high' | 'medium' | 'low' | 'unknown' {
  if (/\b(?:uncertain|unknown|not\s+verified|could\s+not\s+confirm)\b/i.test(text))
    return 'unknown';
  if (/\b(?:may|might|could|appears?|likely|unlikely)\b/i.test(text)) return 'low';
  return 'high';
}

function citationEvidenceId(citation: CitationLike): string {
  return `citation:${citation.n}:${citation.tool}:${citation.id}`;
}

function sentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
