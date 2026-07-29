import type { LedgerEntry } from '../grounding/auditor';
import {
  buildAssuredClaimLedger,
  type AssuredClaimType,
  type AssuredEvidence,
  type ClaimCandidate,
  type ClaimLedger,
} from './claim-ledger';
import {
  inferClaimCategories,
  type DomainEvidencePlan,
  type EvidenceClass,
} from './evidence-plan';

export interface CitationLike {
  n: number;
  tool: string;
  id: string;
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
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
}): ClaimLedger {
  const evidence = evidenceFromToolResults(
    input.ledgerEntries,
    input.citations ?? [],
    input.plan,
  );
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
): AssuredEvidence[] {
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
    evidence.push({
      id: citationEvidenceId(citation),
      sourceType: citation.tool,
      sourceId: citation.id,
      evidenceClass: evidenceClassForTool(citation.tool),
      ...(citation.title ? { title: citation.title } : {}),
      ...(citation.url ? { url: citation.url } : {}),
      primary: primaryTool(citation.tool),
      authoritative: resolves && authoritativeTool(citation.tool),
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
        evidenceClass: evidenceClassForTool(tool),
        primary: primaryTool(tool),
        authoritative: authoritativeTool(tool) && entry.serialized.includes(sourceId),
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
  if (/\b(?:likely|unlikely|may|might|could|appears?|suggests?|we\s+infer|assessment)\b/i.test(text)) {
    return 'inference';
  }
  if (/\b(?:uncertain|unknown|not\s+verified|could\s+not\s+confirm|insufficient\s+evidence|no\s+reliable\s+source)\b/i.test(text)) {
    return 'uncertainty';
  }
  return 'fact';
}

function evidenceClassForTool(tool: string): EvidenceClass {
  if (/^(?:get_bill_status|get_state_bill_status|search_floor_votes|search_state_floor_votes|get_state_rule_status)$/.test(tool)) {
    return 'official_action_vote_status';
  }
  if (/^(?:search_congress_bills|search_state_bills)$/.test(tool)) {
    return 'primary_legislative_legal_text';
  }
  if (/^(?:get_pe_budget_timeline|get_program_element|get_pe_report_language|get_pe_bills|get_funding_positions)$/.test(tool)) {
    return 'official_budget_exhibit_mark_law';
  }
  if (/^(?:query_regulatory_dockets|get_committee_roster)$/.test(tool)) {
    return 'committee_agency_guidance';
  }
  if (/^(?:get_client_context|query_tasks|query_debriefs|query_outreach|list_emails|search_emails)$/.test(tool)) {
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

function primaryTool(tool: string): boolean {
  return !/^(?:search_public_web|scrape_web_page|search_intel_articles|search_memory)$/.test(tool);
}

function authoritativeTool(tool: string): boolean {
  return !/^(?:search_public_web|scrape_web_page|search_intel_articles|search_memory|query_knowledge_graph)$/.test(tool);
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
  if (/\b(?:uncertain|unknown|not\s+verified|could\s+not\s+confirm)\b/i.test(text)) return 'unknown';
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
