const MAX_STRATEGY_SERIALIZED_CHARS = 10_700;

interface StrategyCompactOptions {
  programLimit: number;
  evidencePerSection: number;
  resultLimit: number;
  snippetLimit: number;
  includeCompany: boolean;
  includeCandidates: boolean;
}

const COMPACTION_PASSES: readonly StrategyCompactOptions[] = [
  {
    programLimit: 10,
    evidencePerSection: 4,
    resultLimit: 24,
    snippetLimit: 240,
    includeCompany: true,
    includeCandidates: true,
  },
  {
    programLimit: 8,
    evidencePerSection: 3,
    resultLimit: 18,
    snippetLimit: 190,
    includeCompany: false,
    includeCandidates: false,
  },
  {
    programLimit: 6,
    evidencePerSection: 2,
    resultLimit: 14,
    snippetLimit: 150,
    includeCompany: false,
    includeCandidates: false,
  },
  {
    programLimit: 4,
    evidencePerSection: 1,
    resultLimit: 10,
    snippetLimit: 120,
    includeCompany: false,
    includeCandidates: false,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function truncate(value: unknown, max: number): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 1))}…`
    : normalized;
}

function compactArray(value: unknown, max: number): unknown {
  return Array.isArray(value) ? value.slice(0, max) : value;
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = stringValue(record[field]);
    if (value) return value;
  }
  return null;
}

function resultRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ['results', 'data', 'items', 'rows', 'timeline', 'awards', 'grants']) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function compactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 2) {
    if (Array.isArray(value)) return value.slice(0, 2);
    if (isRecord(value)) return '[structured detail omitted]';
    return truncate(value, 260);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((entry) => compactUnknown(entry, depth + 1));
  }
  if (!isRecord(value)) return truncate(value, 500);
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 18)
      .map(([key, entry]) => [key, compactUnknown(entry, depth + 1)]),
  );
}

function compactEvidence(
  value: unknown,
  snippetLimit = 260,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const id = firstString(value, [
    'id',
    'identifier',
    'peCode',
    'solicitationNumber',
    'billNumber',
    'threadId',
  ]);
  const title = firstString(value, [
    'title',
    'name',
    'subject',
    'headline',
    'companyName',
    'clientName',
    'peCode',
  ]);
  if (!title) return null;
  const url = firstString(value, [
    'url',
    'link',
    'sourceUrl',
    'webUrl',
    'documentUrl',
    'officialWebsite',
  ]);
  const snippet = firstString(value, [
    'snippet',
    'summary',
    'description',
    'abstract',
    'text',
    'bodyText',
    'latestAction',
  ]);
  const out: Record<string, unknown> = {
    ...(id ? { id } : {}),
    title: truncate(title, 150),
    ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
    ...(snippet ? { snippet: truncate(snippet, snippetLimit) } : {}),
  };
  for (const key of [
    'sourceTool',
    'peCode',
    'service',
    'serviceBranch',
    'agency',
    'status',
    'type',
    'budgetExhibitType',
    'fiscalYear',
    'stage',
    'amount',
    'deadline',
    'responseDeadline',
    'postedDate',
    'naics',
    'naicsCode',
    'psc',
    'pscCode',
    'uei',
    'cageCode',
  ]) {
    if (value[key] !== undefined && value[key] !== null) {
      out[key] = compactUnknown(value[key]);
    }
  }
  if (isRecord(value.metadata)) {
    out.metadata = Object.fromEntries(
      Object.entries(value.metadata)
        .filter(([, entry]) => entry !== undefined && entry !== null)
        .slice(0, 10)
        .map(([key, entry]) => [key, compactUnknown(entry)]),
    );
  }
  return out;
}

function compactEvidenceList(
  value: unknown,
  max: number,
  snippetLimit = 260,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => compactEvidence(entry, snippetLimit))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .slice(0, max);
}

function compactDetail(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const key of [
    'peCode',
    'code',
    'title',
    'name',
    'description',
    'service',
    'serviceBranch',
    'budgetActivity',
    'budgetExhibitType',
    'exhibitType',
    'appropriationType',
    'appropriationTitle',
    'account',
  ]) {
    if (value[key] !== undefined && value[key] !== null) {
      out[key] = truncate(compactUnknown(value[key]), key === 'description' ? 360 : 160);
    }
  }
  return Object.keys(out).length ? out : null;
}

function compactStructuredRows(value: unknown, max: number): unknown[] {
  return resultRows(value)
    .slice(0, max)
    .map((row) => {
      if (!isRecord(row)) return truncate(row, 220);
      const selected: Record<string, unknown> = {};
      for (const key of [
        'title',
        'name',
        'description',
        'summary',
        'text',
        'report',
        'reportTitle',
        'billNumber',
        'relationship',
        'contractorName',
        'role',
        'organization',
        'fiscalYear',
        'stage',
        'amount',
        'request',
        'hasc',
        'sasc',
        'hacd',
        'sacd',
        'enacted',
        'url',
        'sourceUrl',
      ]) {
        if (row[key] !== undefined && row[key] !== null) {
          selected[key] = truncate(
            compactUnknown(row[key]),
            /description|summary|text/.test(key) ? 300 : 150,
          );
        }
      }
      return Object.keys(selected).length ? selected : compactUnknown(row);
    });
}

function compactValidatedProgram(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const detail = compactDetail(value.detail);
  const title =
    (Array.isArray(value.titles) ? stringValue(value.titles[0]) : null) ??
    (detail ? firstString(detail, ['title', 'name']) : null) ??
    stringValue(value.peCode) ??
    'Budget candidate';
  return {
    peCode: stringValue(value.peCode),
    title: truncate(title, 170),
    score: value.score,
    programType: value.programType,
    budgetExhibitType: value.budgetExhibitType,
    verified: value.verified,
    matchedQueries: Array.isArray(value.matchedQueries)
      ? value.matchedQueries.slice(0, 3).map((entry) => truncate(entry, 100))
      : [],
    evidenceLimitations: Array.isArray(value.evidenceLimitations)
      ? value.evidenceLimitations.slice(0, 3).map((entry) => truncate(entry, 160))
      : [],
    ...(detail ? { detail } : {}),
    budgetTimeline: compactStructuredRows(value.budgetTimeline, 5),
    reportLanguage: compactStructuredRows(value.reportLanguage, 3),
    contractors: compactStructuredRows(value.contractors, 3),
    bills: compactStructuredRows(value.bills, 3),
    acquisitionPersonnel: compactStructuredRows(value.acquisitionPersonnel, 3),
    evidence: compactEvidenceList(value.evidence, 2, 180),
  };
}

function compactCompanyResearch(value: unknown, includeFull: boolean): unknown {
  if (!isRecord(value)) return value;
  if (!includeFull) {
    return {
      researchSubject: value.researchSubject,
      resolutionStatus: value.resolutionStatus,
      resolvedEntity: compactUnknown(value.resolvedEntity),
      identityDiscovery: compactUnknown(value.identityDiscovery),
      qualificationGaps: compactArray(value.qualificationGaps, 8),
    };
  }
  return {
    coverage: compactUnknown(value.coverage),
    researchSubject: value.researchSubject,
    resolutionStatus: value.resolutionStatus,
    resolvedEntity: compactUnknown(value.resolvedEntity),
    identityDiscovery: compactUnknown(value.identityDiscovery),
    federalMarketSignals: compactUnknown(value.federalMarketSignals),
    qualificationGaps: compactArray(value.qualificationGaps, 8),
    publicCapabilities: compactEvidenceList(value.publicCapabilities, 6, 220),
    historicalAwards: compactEvidenceList(value.historicalAwards, 6, 220),
    candidateOpportunities: compactEvidenceList(value.candidateOpportunities, 6, 220),
    candidateGrants: compactEvidenceList(value.candidateGrants, 4, 220),
    results: compactEvidenceList(value.results, 8, 220),
  };
}

function uniqueEvidence(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${String(row.url ?? '')}:${String(row.id ?? '')}:${String(row.title ?? '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const EVIDENCE_SECTIONS = [
  ['programs', 'validatedPrograms'],
  ['congressional', 'congressionalEvidence'],
  ['opportunities', 'currentAndRecurringOpportunities'],
  ['acquisition', 'acquisitionChannels'],
  ['partners', 'partnerAndOemEvidence'],
  ['grants', 'grantsAndInnovation'],
  ['operationalValidation', 'operationalValidation'],
  ['industrialBase', 'industrialBaseAndFinance'],
  ['compliance', 'complianceAndMarketAccess'],
  ['stakeholders', 'acquisitionStakeholders'],
  ['risks', 'authoritativeRiskEvidence'],
  ['public', 'publicEvidence'],
] as const;

function programCitationRows(value: unknown, snippetLimit: number): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const raw of value.slice(0, 10)) {
    if (!isRecord(raw)) continue;
    rows.push(...compactEvidenceList(raw.evidence, 2, snippetLimit));
    rows.push(...compactEvidenceList(resultRows(raw.reportLanguage), 1, snippetLimit));
    rows.push(...compactEvidenceList(resultRows(raw.bills), 1, snippetLimit));
  }
  return uniqueEvidence(rows);
}

function sectionEvidence(
  value: Record<string, unknown>,
  section: string,
  field: string,
  max: number,
  snippetLimit: number,
): Record<string, unknown>[] {
  if (section === 'programs') {
    return programCitationRows(value[field], snippetLimit).slice(0, max);
  }
  return compactEvidenceList(value[field], max, snippetLimit);
}

function evidenceIndex(
  value: Record<string, unknown>,
  perSection: number,
  snippetLimit: number,
): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(
    EVIDENCE_SECTIONS.filter(([section]) => section !== 'programs').map(([section, field]) => [
      section,
      sectionEvidence(value, section, field, perSection, snippetLimit),
    ]),
  );
}

function roundRobinEvidence(
  value: Record<string, unknown>,
  max: number,
  snippetLimit: number,
): Record<string, unknown>[] {
  const pools = EVIDENCE_SECTIONS.map(([section, field]) =>
    sectionEvidence(value, section, field, 6, snippetLimit),
  );
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; rows.length < max; index += 1) {
    let added = false;
    for (const pool of pools) {
      const row = pool[index];
      if (!row) continue;
      rows.push(row);
      added = true;
      if (rows.length >= max) break;
    }
    if (!added) break;
  }
  return uniqueEvidence(rows).slice(0, max);
}

function compactCoverageGate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    requiredDomains: compactArray(value.requiredDomains, 20),
    searchedDomains: compactArray(value.searchedDomains, 20),
    evidenceDomains: compactArray(value.evidenceDomains, 20),
    missingDomains: compactArray(value.missingDomains, 20),
    partialDomains: compactArray(value.partialDomains, 20),
    readyForSynthesis: value.readyForSynthesis,
    criticFindings: Array.isArray(value.criticFindings)
      ? value.criticFindings.slice(0, 12).map((entry) => truncate(entry, 220))
      : [],
    sourceErrors: Array.isArray(value.sourceErrors)
      ? value.sourceErrors.slice(0, 8).map((entry) => compactUnknown(entry))
      : [],
  };
}

function compactResearchDirector(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const blueprint = isRecord(value.blueprint) ? value.blueprint : {};
  const plan = isRecord(value.plan) ? value.plan : {};
  return {
    researchWaves: compactArray(blueprint.wavesExecuted, 10),
    queryCount: blueprint.queryCount,
    requiredSections: compactArray(plan.outputSections, 16),
    stopConditions: compactArray(plan.stopConditions, 8),
    criticChecklist: Array.isArray(value.criticChecklist)
      ? value.criticChecklist.slice(0, 16).map((entry) => truncate(entry, 200))
      : [],
  };
}

function identityDirective(value: Record<string, unknown>): string {
  if (value.identityUsable === false) {
    return [
      'Identity remains materially ambiguous or unresolved.',
      'Do not combine evidence from distinct candidates into one company strategy.',
      'Present a concise candidate comparison, identify which evidence belongs to each candidate, provide only clearly conditional market observations, and ask one targeted clarification that would select the correct company.',
    ].join(' ');
  }
  return stringValue(value.answerDirective) ??
    'Write the complete client-ready federal growth and capture strategy from the Research Director evidence packet.';
}

function strategyPacket(
  value: Record<string, unknown>,
  options: StrategyCompactOptions,
): Record<string, unknown> {
  const validatedPrograms = Array.isArray(value.validatedPrograms)
    ? value.validatedPrograms
        .slice(0, options.programLimit)
        .map(compactValidatedProgram)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  return {
    coverage: compactUnknown(value.coverage),
    coverageGate: compactCoverageGate(value.coverageGate),
    answerDirective: truncate(identityDirective(value), 1_100),
    tool: value.tool,
    subject: value.subject,
    researchSubject: value.researchSubject,
    identityUsable: value.identityUsable,
    companyResearch: compactCompanyResearch(value.companyResearch, options.includeCompany),
    federalMarketSignals: compactUnknown(value.federalMarketSignals),
    capabilityMissionMap: compactUnknown(value.capabilityMissionMap),
    researchDirector: compactResearchDirector(value.researchDirector),
    validatedPrograms,
    ...(options.includeCandidates && Array.isArray(value.programCandidates)
      ? {
          programCandidates: value.programCandidates.slice(0, 8).map((entry) => {
            if (!isRecord(entry)) return compactUnknown(entry);
            return {
              peCode: entry.peCode,
              score: entry.score,
              titles: compactArray(entry.titles, 2),
              matchedQueries: compactArray(entry.matchedQueries, 3),
            };
          }),
        }
      : {}),
    evidenceByDomain: evidenceIndex(
      value,
      options.evidencePerSection,
      options.snippetLimit,
    ),
    // Shared citation extraction reads top-level results/data and currently
    // keeps only a handful of rows. Round-robin across domains so those rows do
    // not all come from the first evidence family.
    results: roundRobinEvidence(value, options.resultLimit, options.snippetLimit),
    note: truncate(value.note, 500),
  };
}

export function compactMeriFederalStrategyResult(
  value: Record<string, unknown>,
): Record<string, unknown> {
  for (const options of COMPACTION_PASSES) {
    const packet = strategyPacket(value, options);
    if (JSON.stringify(packet).length <= MAX_STRATEGY_SERIALIZED_CHARS) return packet;
  }

  const fallbackOptions = COMPACTION_PASSES[COMPACTION_PASSES.length - 1]!;
  const minimal = strategyPacket(value, fallbackOptions);
  const fallback = {
    coverage: compactUnknown(minimal.coverage),
    coverageGate: compactCoverageGate(minimal.coverageGate),
    answerDirective: truncate(minimal.answerDirective, 700),
    tool: minimal.tool,
    subject: minimal.subject,
    researchSubject: minimal.researchSubject,
    identityUsable: minimal.identityUsable,
    companyResearch: compactUnknown(minimal.companyResearch),
    federalMarketSignals: compactUnknown(minimal.federalMarketSignals),
    capabilityMissionMap: compactUnknown(minimal.capabilityMissionMap),
    // Preserve the already-compacted director contract. Recompacting it as a
    // raw director object would erase researchWaves/requiredSections.
    researchDirector: compactUnknown(minimal.researchDirector),
    validatedPrograms: Array.isArray(minimal.validatedPrograms)
      ? minimal.validatedPrograms.slice(0, 3)
      : [],
    evidenceByDomain: compactUnknown(minimal.evidenceByDomain),
    results: Array.isArray(minimal.results) ? minimal.results.slice(0, 8) : [],
  };

  if (JSON.stringify(fallback).length <= MAX_STRATEGY_SERIALIZED_CHARS) return fallback;
  // Last-resort packet still keeps at least three validated programs so the
  // model can distinguish PE / procurement / SOCOM anchors in synthesis.
  return {
    coverage: compactUnknown(fallback.coverage),
    coverageGate: compactCoverageGate(fallback.coverageGate),
    answerDirective: truncate(fallback.answerDirective, 400),
    tool: fallback.tool,
    subject: fallback.subject,
    researchSubject: fallback.researchSubject,
    identityUsable: fallback.identityUsable,
    capabilityMissionMap: compactUnknown(fallback.capabilityMissionMap, 1),
    researchDirector: compactUnknown(fallback.researchDirector, 1),
    validatedPrograms: Array.isArray(fallback.validatedPrograms)
      ? fallback.validatedPrograms.slice(0, 3)
      : [],
    evidenceByDomain: compactUnknown(fallback.evidenceByDomain, 1),
    results: Array.isArray(fallback.results) ? fallback.results.slice(0, 4) : [],
  };
}
