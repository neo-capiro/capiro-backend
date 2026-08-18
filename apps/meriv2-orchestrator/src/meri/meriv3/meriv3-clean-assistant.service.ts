import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FORM_B_CITATION_RE, type MeriCitation } from '@capiro/shared';
import type { LedgerEntry } from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { MeriRegistryService } from '../meri-registry.service.js';
import { MeriRetrievalCoordinator } from '../retrieval/meri-retrieval-coordinator.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { ApiVisualAnalysisRepo } from './api-visual-analysis.repo.js';
import { MeriV3RetrievalAssistantService } from './meriv3-retrieval-assistant.service.js';
import { OpenAiResponsesClient } from './openai-responses.client.js';

interface FinalizeReplyArgs {
  reply: string;
  citations: MeriCitation[];
  ledgerEntries: LedgerEntry[];
  [key: string]: unknown;
}

interface FinalizeReplyResult {
  reply: string;
  citations: MeriCitation[];
  held: boolean;
}

interface FinalizeReplyInternals {
  finalizeReply: (args: FinalizeReplyArgs) => FinalizeReplyResult;
}

interface CitationEvidence {
  callTool: string;
  sourceTool: string;
  id: string;
  title: string;
  url: string | null;
  snippet: string | null;
}

const RESULT_ARRAY_KEYS = [
  'results',
  'messages',
  'data',
  'items',
  'threads',
  'contacts',
  'meetings',
  'records',
  'filings',
  'opportunities',
  'grants',
  'awards',
] as const;
const ID_FIELDS = [
  'id',
  'messageId',
  'threadId',
  'memoryItemId',
  'recordId',
  'sourceId',
  'identifier',
] as const;
const TITLE_FIELDS = [
  'title',
  'subject',
  'name',
  'companyName',
  'clientName',
  'headline',
  'identifier',
] as const;
const URL_FIELDS = ['url', 'sourceUrl', 'webUrl', 'link', 'website'] as const;
const SNIPPET_FIELDS = [
  'bodyText',
  'preview',
  'summary',
  'description',
  'abstract',
  'snippet',
  'text',
  'excerpt',
] as const;
const MAX_RELEASE_CITATIONS = 48;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result.filter(isRecord);
  if (!isRecord(result)) return [];
  for (const key of RESULT_ARRAY_KEYS) {
    const rows = result[key];
    if (Array.isArray(rows)) return rows.filter(isRecord);
  }
  return firstString(result, [...TITLE_FIELDS, ...SNIPPET_FIELDS]) ? [result] : [];
}

function citationType(tool: string, fallback?: MeriCitation['type']): MeriCitation['type'] {
  const typeByTool: Record<string, MeriCitation['type']> = {
    search_emails: 'email',
    list_emails: 'email',
    find_contacts: 'contact',
    search_memory: 'memory',
    query_debriefs: 'meeting',
    search_public_web: 'web',
    scrape_web_page: 'web',
    search_research_sources: 'internal',
    get_client_context: 'client',
    search_client_knowledge: 'client_kb',
  };
  return typeByTool[tool] ?? fallback ?? 'source';
}

function evidenceFromLedger(entries: readonly LedgerEntry[]): CitationEvidence[] {
  const evidence: CitationEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const row of resultRows(entry.result)) {
      const id = firstString(row, ID_FIELDS);
      const title = firstString(row, TITLE_FIELDS);
      if (!id || !title) continue;
      const sourceTool = firstString(row, ['sourceTool']) ?? entry.tool;
      const key = `${sourceTool}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const urlRaw = firstString(row, URL_FIELDS);
      evidence.push({
        callTool: entry.tool,
        sourceTool,
        id,
        title: truncate(title, 200) ?? title,
        url: urlRaw && /^https?:\/\//i.test(urlRaw) ? urlRaw : null,
        snippet: truncate(firstString(row, SNIPPET_FIELDS), 240),
      });
    }
  }
  return evidence;
}

function matchingEvidence(
  citation: MeriCitation,
  evidence: readonly CitationEvidence[],
): CitationEvidence | undefined {
  return (
    evidence.find(
      (item) => item.id === citation.id && item.sourceTool === citation.tool,
    ) ??
    evidence.find(
      (item) => item.id === citation.id && item.callTool === citation.tool,
    ) ??
    evidence.find((item) => item.id === citation.id)
  );
}

export function buildMeriV3ReleaseCitations(
  citations: readonly MeriCitation[],
  ledgerEntries: readonly LedgerEntry[],
): { citations: MeriCitation[]; aliases: Map<string, MeriCitation> } {
  const evidence = evidenceFromLedger(ledgerEntries);
  const normalized: MeriCitation[] = [];
  const byKey = new Map<string, MeriCitation>();
  const aliases = new Map<string, MeriCitation>();

  for (const citation of citations) {
    const source = matchingEvidence(citation, evidence);
    const updated: MeriCitation = source
      ? {
          ...citation,
          type: citationType(source.sourceTool, citation.type),
          id: source.id,
          title: source.title,
          url: source.url,
          snippet: source.snippet,
          tool: source.sourceTool,
        }
      : citation;
    const key = `${updated.tool}:${updated.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, updated);
      normalized.push(updated);
    }
    aliases.set(`${citation.tool}:${citation.id}`, updated);
    aliases.set(key, updated);
    if (source) aliases.set(`${source.callTool}:${source.id}`, updated);
  }

  let nextN = normalized.reduce((max, citation) => Math.max(max, citation.n), 0) + 1;
  for (const source of evidence) {
    if (normalized.length >= MAX_RELEASE_CITATIONS) break;
    const key = `${source.sourceTool}:${source.id}`;
    let citation = byKey.get(key);
    if (!citation) {
      citation = {
        n: nextN,
        type: citationType(source.sourceTool),
        id: source.id,
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        tool: source.sourceTool,
      };
      nextN += 1;
      byKey.set(key, citation);
      normalized.push(citation);
    }
    aliases.set(key, citation);
    aliases.set(`${source.callTool}:${source.id}`, citation);
  }

  normalized.sort((left, right) => left.n - right.n);
  return { citations: normalized, aliases };
}

export function normalizeMeriV3FormBCitations(
  text: string,
  aliases: ReadonlyMap<string, MeriCitation>,
): string {
  const pattern = new RegExp(FORM_B_CITATION_RE.source, 'g');
  return text
    .replace(pattern, (_token, tool: string, id: string) => {
      const citation = aliases.get(`${tool}:${id}`);
      return citation ? `[${citation.n}]` : '';
    })
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Final release adapter for MeriV3.
 *
 * The core assistant already validates citations and runs assurance. This thin
 * subclass only repairs the boundary between composite recipe evidence and the
 * browser response: underlying source rows receive stable citation objects and
 * valid Form-B markers are converted to the numbered form consumed by the UI.
 */
@Injectable()
export class MeriV3CleanAssistantService extends MeriV3RetrievalAssistantService {
  constructor(
    registryService: MeriRegistryService,
    openai: OpenAiResponsesClient,
    actionProposals: ApiActionProposalRepo,
    prisma: PrismaService,
    config: ConfigService,
    managedMcp: ApiManagedMcpRepo,
    visualAnalysis: ApiVisualAnalysisRepo,
    retrieval: MeriRetrievalCoordinator,
  ) {
    super(
      registryService,
      openai,
      actionProposals,
      prisma,
      config,
      managedMcp,
      visualAnalysis,
      retrieval,
    );

    const internals = this as unknown as FinalizeReplyInternals;
    const nativeFinalize = internals.finalizeReply.bind(this);
    internals.finalizeReply = (args: FinalizeReplyArgs): FinalizeReplyResult => {
      const release = buildMeriV3ReleaseCitations(args.citations, args.ledgerEntries);
      return nativeFinalize({
        ...args,
        reply: normalizeMeriV3FormBCitations(args.reply, release.aliases),
        citations: release.citations,
      });
    };
  }
}
