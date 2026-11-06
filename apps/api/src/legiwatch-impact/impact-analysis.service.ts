import { Injectable } from '@nestjs/common';
import Ajv from 'ajv';
import type {
  LegiWatchCitation,
  LegiWatchImpactAnalysis,
  LegiWatchImpactFinding,
} from '@capiro/shared';
import {
  PortfolioAgentService,
  type PortfolioAgentSource,
} from '../clients/portfolio-agent.service.js';
import { IMPACT_REVIEW_SCHEMA, verifyImpactReview } from '../bill-impact/bill-impact.evidence.js';
import type { ImpactEvidenceSnapshot } from './impact-evidence.types.js';
import { impactAgentConfig } from './impact-agent.config.js';
import {
  IMPACT_ANALYSIS_INSTRUCTIONS,
  IMPACT_ANALYSIS_SCHEMA,
  IMPACT_GROUNDING_INSTRUCTIONS,
  type ImpactDraft,
} from './impact-analysis.schema.js';

const validateDraft = new Ajv({ strict: false }).compile(IMPACT_ANALYSIS_SCHEMA);
const MAX_PACKET_CHARS = 500_000;
type Reference = { citation: LegiWatchCitation; text: string };
type Packet = {
  sources: PortfolioAgentSource[];
  provisions: Map<string, Reference>;
  facts: Map<string, Reference>;
};

/** Canonical evidence ownership stays upstream; this only packs complete records for SDK tools. */
function packet(snapshot: ImpactEvidenceSnapshot): Packet {
  const provisions = new Map<string, Reference>();
  const facts = new Map<string, Reference>();
  const records: string[] = [];
  const versions = new Set(snapshot.versions.map((version) => version.id));
  const validCitation = (citation: LegiWatchCitation) =>
    !!(citation.sourceId && citation.revision && citation.locator && citation.quote?.trim());
  snapshot.provisions.forEach((provision, index) => {
    if (
      !validCitation(provision) ||
      !versions.has(provision.sourceId) ||
      !provision.text?.includes(provision.quote)
    )
      throw new Error('Invalid bill evidence');
    const ref = `P${index + 1}`;
    provisions.set(ref, { citation: provision, text: provision.text });
    const { sourceId, sourceUrl, label, locator, revision, text } = provision;
    records.push(
      `BILL PASSAGE ${ref}\n${JSON.stringify({ sourceId, sourceUrl, label, locator, revision })}\n${text}`,
    );
  });
  snapshot.clientFacts.forEach((fact, index) => {
    if (!fact.id || !fact.revision || !fact.value?.trim())
      throw new Error('Invalid client evidence');
    fact.citations.forEach((citation, citationIndex) => {
      if (!validCitation(citation)) throw new Error('Invalid client citation');
      const ref = `F${index + 1}C${citationIndex + 1}`;
      facts.set(ref, { citation, text: citation.quote });
      records.push(
        `CLIENT FACT ${ref}\n${JSON.stringify({ id: fact.id, kind: fact.kind, label: fact.label, revision: fact.revision, citation })}\nStated fact: ${fact.value}\nRetained supporting quote:\n${citation.quote}`,
      );
    });
  });
  const sources: PortfolioAgentSource[] = [];
  let text = '';
  let total = 0;
  const flush = () => {
    if (text) sources.push({ id: `impact-evidence-${sources.length + 1}`, text });
    text = '';
  };
  for (const record of records) {
    total += record.length;
    if (record.length > 95_000 || total > MAX_PACKET_CHARS)
      throw new Error('Evidence exceeds analysis limit');
    if (text.length + record.length + 2 > 95_000) flush();
    text += `${record}\n\n`;
  }
  flush();
  return { sources, provisions, facts };
}

function citations(
  refs: Array<{ ref: string; quote: string }>,
  allowed: Map<string, Reference>,
): LegiWatchCitation[] {
  if (new Set(refs.map((ref) => ref.ref)).size !== refs.length)
    throw new Error('Duplicate evidence');
  return refs.map(({ ref, quote }) => {
    const original = allowed.get(ref);
    if (!original || !quote.trim() || !original.text.includes(quote))
      throw new Error('Unsupported evidence');
    const { sourceId, sourceUrl, label, locator, revision } = original.citation;
    return { sourceId, sourceUrl, label, locator, revision, quote };
  });
}

function unresolved(
  snapshot: ImpactEvidenceSnapshot,
  status: 'needs_evidence' | 'unavailable',
  missingFacts: string[],
): LegiWatchImpactAnalysis {
  return {
    status,
    summary:
      status === 'needs_evidence'
        ? 'More evidence is needed to establish a client-specific impact.'
        : 'Impact analysis is temporarily unavailable.',
    direction: 'uncertain',
    confidence: 'low',
    findings: [],
    missingFacts,
    analyzedAt: null,
    inputFingerprint: snapshot.fingerprint,
    stale: false,
    staleReason: null,
    model: null,
  };
}

@Injectable()
export class ImpactAnalysisService {
  constructor(private readonly agent: PortfolioAgentService) {}

  async analyze(snapshot: ImpactEvidenceSnapshot): Promise<LegiWatchImpactAnalysis> {
    if (!snapshot.provisions.length || !snapshot.clientFacts.some((fact) => fact.citations.length))
      return unresolved(snapshot, 'needs_evidence', [
        ...snapshot.coverageNotes,
        ...(!snapshot.provisions.length ? ['Retained bill text is needed.'] : []),
        ...(!snapshot.clientFacts.some((fact) => fact.citations.length)
          ? ['Cited client activities or capabilities are needed.']
          : []),
      ]);
    let evidence: Packet;
    try {
      evidence = packet(snapshot);
    } catch {
      return unresolved(snapshot, 'needs_evidence', [
        'The retained evidence is incomplete, inconsistent, or exceeds the analysis limit. Review the source documents.',
      ]);
    }
    let config: ReturnType<typeof impactAgentConfig>;
    try {
      config = impactAgentConfig();
    } catch {
      return unresolved(snapshot, 'unavailable', ['The analysis service is not configured.']);
    }
    const incomplete = snapshot.versions.some(
      (version) => version.current && version.completeness !== 'complete',
    );
    const coverage = [
      ...snapshot.coverageNotes,
      ...(incomplete
        ? ['Some current bill text is incomplete; definitions or exceptions may be missing.']
        : []),
    ];
    const request = {
      ...config,
      subject: { kind: 'client' as const, id: snapshot.clientId },
      sources: evidence.sources,
      prompt: JSON.stringify({
        billId: snapshot.billId,
        billStatus: snapshot.billStatus,
        versions: snapshot.versions,
        coverage,
      }),
    };
    let draft: ImpactDraft;
    try {
      const response = await this.agent.extract<ImpactDraft>({
        ...request,
        task: 'legiwatch_impact',
        schemaVersion: 'legiwatch-impact-v1',
        instructions: IMPACT_ANALYSIS_INSTRUCTIONS,
        schema: IMPACT_ANALYSIS_SCHEMA,
        timeoutMs: Math.floor((config.timeoutMs! * 2) / 3),
        maxBudgetUsd: (config.maxBudgetUsd! * 2) / 3,
      });
      draft = response.data;
    } catch {
      return unresolved(snapshot, 'unavailable', [
        'The analysis could not be completed. Retry after reviewing the available evidence.',
      ]);
    }
    let findings: LegiWatchImpactFinding[];
    try {
      if (!validateDraft(draft)) throw new Error('Invalid impact output');
      findings = draft.findings.map((finding) => {
        const provisions = citations(finding.provisions, evidence.provisions);
        if (new Set(provisions.map((citation) => citation.sourceId)).size !== 1)
          throw new Error('Mixed bill versions');
        return {
          ...finding,
          confidence: incomplete || finding.missingFacts.length ? 'low' : finding.confidence,
          provisions,
          clientFacts: citations(finding.clientFacts, evidence.facts),
        };
      });
      if (!findings.length)
        return unresolved(snapshot, 'needs_evidence', [
          ...coverage,
          ...draft.missingFacts,
          'No specific provision-to-client connection was established. Confirm relevant products, locations, programs, suppliers or thresholds.',
        ]);
    } catch {
      return unresolved(snapshot, 'needs_evidence', [
        'The proposed impact could not be supported by the retained bill and client evidence. Verify applicability before retrying.',
      ]);
    }
    let review: unknown;
    try {
      const response = await this.agent.extract({
        ...request,
        task: 'legiwatch_impact_grounding',
        schemaVersion: 'legiwatch-impact-grounding-v1',
        instructions: IMPACT_GROUNDING_INSTRUCTIONS,
        schema: IMPACT_REVIEW_SCHEMA,
        timeoutMs: Math.floor(config.timeoutMs! / 3),
        maxBudgetUsd: config.maxBudgetUsd! / 3,
        prompt: JSON.stringify({
          context: request.prompt,
          impacts: findings.map((finding, index) => ({ index, ...finding })),
        }),
      });
      review = response.data;
    } catch {
      return unresolved(snapshot, 'unavailable', [
        'The independent evidence review could not be completed. Retry after reviewing the available evidence.',
      ]);
    }
    try {
      verifyImpactReview(review, findings.length);
    } catch {
      return unresolved(snapshot, 'needs_evidence', [
        'The proposed impact could not be supported by the retained bill and client evidence. Verify applicability before retrying.',
      ]);
    }
    const directions = new Set(findings.map((finding) => finding.direction));
    const confidence = findings.every((finding) => finding.confidence === 'high')
      ? 'high'
      : findings.some((finding) => finding.confidence === 'low')
        ? 'low'
        : 'medium';
    return {
      status: 'ready',
      summary: `${findings.length} potential client-specific impact${findings.length === 1 ? '' : 's'} identified. Applicability and proposed actions require review.`,
      direction: directions.size === 1 ? findings[0]!.direction : 'mixed',
      confidence,
      findings,
      missingFacts: [
        ...new Set([
          ...coverage,
          ...draft.missingFacts,
          ...findings.flatMap((finding) => finding.missingFacts),
        ]),
      ],
      analyzedAt: new Date().toISOString(),
      inputFingerprint: snapshot.fingerprint,
      stale: false,
      staleReason: null,
      model: config.runtime!.model,
    };
  }
}
