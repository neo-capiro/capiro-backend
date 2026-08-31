import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs';

type JsonRecord = Record<string, unknown>;

interface LdaPresentation {
  displayTitle: string;
  displaySummary: string | null;
  metadataLine: string;
  category: string;
  issueCode: string | null;
  filingYear: number | null;
  filingPeriod: string | null;
  topics: string[];
  specificAskStated: boolean;
  sourceTitle: string;
  sourceStatus: string | null;
}

const LDA_ISSUE_LABELS: Record<string, string> = {
  AER: 'Aerospace policy',
  APP: 'Appropriations',
  BUD: 'Federal budget & appropriations',
  DEF: 'Defense authorization & appropriations',
  EDU: 'Education policy',
  ENG: 'Energy policy',
  ENV: 'Environmental policy',
  GOV: 'Government operations',
  HCR: 'Health policy',
  HOM: 'Homeland security',
  IMM: 'Immigration policy',
  LAW: 'Law enforcement',
  SCI: 'Science policy',
  TAX: 'Tax policy',
  TEC: 'Technology policy',
  TRD: 'Trade policy',
  TRA: 'Transportation policy',
  VET: 'Veterans policy',
};

const TOPIC_PATTERNS: Array<{ label: string; pattern: RegExp; specific: boolean }> = [
  { label: 'GBSD', pattern: /\b(?:GBSD|Ground[- ]Based Strategic Deterrent)\b/i, specific: true },
  { label: 'Sentinel', pattern: /\bSentinel\b/i, specific: true },
  { label: 'Space Propulsion', pattern: /\bspace propulsion(?: technology| systems?)?\b/i, specific: true },
  { label: 'Hypersonics', pattern: /\bhypersonic(?:s| weapons?| systems?)?\b/i, specific: true },
  { label: 'Missile Defense', pattern: /\bmissile defense\b/i, specific: true },
  { label: 'Nuclear Modernization', pattern: /\bnuclear modernization\b/i, specific: true },
  { label: 'Space Systems', pattern: /\bspace systems?\b/i, specific: true },
  { label: 'Cybersecurity', pattern: /\b(?:cybersecurity|cyber security|cyber)\b/i, specific: true },
  { label: 'Artificial Intelligence', pattern: /\b(?:artificial intelligence|AI)\b/i, specific: true },
  { label: 'Autonomous Systems', pattern: /\b(?:autonomous|unmanned) systems?\b/i, specific: true },
  { label: 'Defense Appropriations', pattern: /\bdefense appropriations?\b/i, specific: false },
  { label: 'RDT&E', pattern: /\b(?:RDT&E|RDT\s*&\s*E|RDTE|research,? development,? test(?:ing)? and evaluation)\b/i, specific: false },
  { label: 'Procurement', pattern: /\bprocurement\b/i, specific: false },
];

const ASK_SIGNAL = /\b(?:request(?:ed|ing)?|seek(?:s|ing)?|sought|support(?:ed|ing)?|oppose(?:d|ing)?|advocat(?:e|ed|ing)|urge(?:d|ing)?|restore(?:d|s|ing)?|increase(?:d|s|ing)?|decrease(?:d|s|ing)?|include(?:d|s|ing)?\s+(?:funding|language)|protect(?:ed|s|ing)?\s+(?:funding|the program)|appropriate(?:d|s|ing)?\s+\$?)\b/i;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{4}$/.test(value.trim())) return Number(value.trim());
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function issueCategory(issueCode: string | null): string {
  if (!issueCode) return 'Federal advocacy activity';
  return LDA_ISSUE_LABELS[issueCode] ?? `${issueCode} advocacy activity`;
}

function normalizeQuarter(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map: Record<string, string> = {
    q1: 'Q1',
    first_quarter: 'Q1',
    q2: 'Q2',
    second_quarter: 'Q2',
    q3: 'Q3',
    third_quarter: 'Q3',
    q4: 'Q4',
    fourth_quarter: 'Q4',
  };
  return map[normalized] ?? null;
}

function extractIssueCode(metadata: JsonRecord, sourceTitle: string): string | null {
  const activity = isRecord(metadata.activity) ? metadata.activity : {};
  const direct =
    asString(activity.general_issue_code) ??
    asString(activity.issue_code) ??
    asString(metadata.issueCode);
  if (direct) return direct.toUpperCase();

  if (Array.isArray(metadata.issueCodes)) {
    const first = metadata.issueCodes.find((value) => asString(value));
    const code = asString(first);
    if (code) return code.toUpperCase();
  }

  return sourceTitle.match(/[—-]\s*([A-Z]{2,5})\s*$/)?.[1]?.toUpperCase() ?? null;
}

function extractFilingYear(metadata: JsonRecord, sourceTitle: string): number | null {
  const metadataYear = asNumber(metadata.filingYear);
  if (metadataYear != null) return metadataYear;
  const titleYear = sourceTitle.match(/\b(20\d{2})\b/)?.[1];
  return titleYear ? Number(titleYear) : null;
}

function extractFilingPeriod(metadata: JsonRecord, sourceTitle: string): string | null {
  const fromMetadata = normalizeQuarter(asString(metadata.filingPeriod));
  if (fromMetadata) return fromMetadata;
  const titlePeriod = sourceTitle.match(/\b(first_quarter|second_quarter|third_quarter|fourth_quarter|q[1-4])\b/i)?.[1] ?? null;
  return normalizeQuarter(titlePeriod);
}

function extractPolicyAnchor(summary: string): string | null {
  const patterns = [
    /National Defense Authorization Act(?:\s+for Fiscal Year|\s+of)?\s*(20\d{2})/i,
    /FY\s*(20\d{2})\s+(?:National Defense Authorization Act|NDAA)/i,
    /(?:National Defense Authorization Act|NDAA)\s+(?:for\s+)?FY\s*(20\d{2})/i,
  ];
  for (const pattern of patterns) {
    const match = summary.match(pattern);
    if (match?.[1]) return `FY${match[1]} NDAA`;
  }
  if (/\b(?:National Defense Authorization Act|NDAA)\b/i.test(summary)) return 'NDAA';
  return null;
}

function extractTopics(summary: string): Array<{ label: string; specific: boolean; index: number }> {
  const matches: Array<{ label: string; specific: boolean; index: number }> = [];
  for (const topic of TOPIC_PATTERNS) {
    const match = topic.pattern.exec(summary);
    if (match?.index != null) matches.push({ label: topic.label, specific: topic.specific, index: match.index });
  }
  return matches
    .sort((a, b) => a.index - b.index)
    .filter((topic, index, all) => all.findIndex((candidate) => candidate.label === topic.label) === index);
}

function joinTitleTopics(topics: string[]): string {
  if (topics.length === 0) return '';
  if (topics.length === 1) return topics[0]!;
  return `${topics[0]} & ${topics[1]}`;
}

function normalizeIssueText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\bRDT\s*&\s*E\b/gi, 'RDT&E')
    .replace(/\bRDTE\b/gi, 'RDT&E')
    .replace(/\band Procurement\b/g, 'and procurement')
    .trim();
}

function normalizeLdaSummary(summary: string | null, specificAskStated: boolean): string | null {
  if (!summary) return null;
  const normalized = normalizeIssueText(summary);
  const monitored = normalized.match(
    /^National Defense Authorization Act(?:\s+for Fiscal Year|\s+of)?\s*(20\d{2}),\s*monitored issues related to\s+(.+?)\.\s*House and Senate Defense Appropriations Bills,\s*as they relate to\s+(.+?)\.?$/i,
  );

  let display = normalized;
  if (monitored?.[1] && monitored[2] && monitored[3]) {
    display = `Monitored the FY${monitored[1]} NDAA and House and Senate defense appropriations bills related to ${normalizeIssueText(monitored[2])}, as well as ${normalizeIssueText(monitored[3])}.`;
  } else if (!/[.!?]$/.test(display)) {
    display = `${display}.`;
  }

  if (!specificAskStated && !/specific ask|specific position/i.test(display)) {
    display += ' The filing does not state a specific ask or position.';
  }
  return display;
}

function buildSemanticTitle(
  summary: string | null,
  category: string,
  periodYear: string | null,
): { title: string; topics: string[] } {
  if (!summary) {
    return {
      title: periodYear ? `${category} — ${periodYear}` : category,
      topics: [],
    };
  }

  const anchor = extractPolicyAnchor(summary);
  const matched = extractTopics(summary);
  const specific = matched.filter((topic) => topic.specific).map((topic) => topic.label);
  const general = matched.filter((topic) => !topic.specific).map((topic) => topic.label);
  const titleTopics = specific.slice(0, 2);

  let title: string;
  if (anchor && titleTopics.length > 0) {
    title = `${anchor} — ${joinTitleTopics(titleTopics)}`;
  } else if (anchor) {
    title = `${anchor} — ${category}`;
  } else if (titleTopics.length > 0) {
    title = `${joinTitleTopics(titleTopics)} — ${category}`;
  } else if (general.length > 0) {
    title = `${category} — ${joinTitleTopics(general.slice(0, 2))}`;
  } else {
    title = periodYear ? `${category} — ${periodYear}` : category;
  }

  return { title, topics: unique([anchor ?? '', ...specific, ...general]) };
}

export function buildLdaRecordPresentation(record: JsonRecord): LdaPresentation {
  const sourceTitle = asString(record.title) ?? 'LDA filing';
  const sourceSummary = asString(record.summary);
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const issueCode = extractIssueCode(metadata, sourceTitle);
  const filingYear = extractFilingYear(metadata, sourceTitle);
  const filingPeriod = extractFilingPeriod(metadata, sourceTitle);
  const category = issueCategory(issueCode);
  const periodYear = [filingPeriod, filingYear?.toString()].filter(Boolean).join(' ') || null;
  const semantic = buildSemanticTitle(sourceSummary, category, periodYear);
  const specificAskStated = sourceSummary ? ASK_SIGNAL.test(sourceSummary) : false;
  const displaySummary = normalizeLdaSummary(sourceSummary, specificAskStated);
  const metadataLine = ['LDA', periodYear, issueCode].filter(Boolean).join(' · ');

  return {
    displayTitle: semantic.title,
    displaySummary,
    metadataLine,
    category,
    issueCode,
    filingYear,
    filingPeriod,
    topics: semantic.topics,
    specificAskStated,
    sourceTitle,
    sourceStatus: asString(record.status),
  };
}

export function presentIssueMatterTitle(title: string, externalKey?: string | null): string {
  const genericTitle = title.match(/^([A-Z0-9]+)\s+lobbying activity$/i);
  if (!genericTitle?.[1]) return title;

  const titleCode = genericTitle[1].toUpperCase();
  const keyCode = externalKey?.match(/^issue:([A-Z0-9]+)$/i)?.[1]?.toUpperCase() ?? null;
  if (keyCode && keyCode !== titleCode) return title;
  return issueCategory(titleCode);
}

function presentLdaTimelineTitle(rawTitle: string): string {
  if (!/^20\d{2}\b/i.test(rawTitle) || !/[—-]\s*[A-Z]{2,5}\s*$/.test(rawTitle)) return rawTitle;
  const metadata: JsonRecord = {};
  const issueCode = extractIssueCode(metadata, rawTitle);
  const filingYear = extractFilingYear(metadata, rawTitle);
  const filingPeriod = extractFilingPeriod(metadata, rawTitle);
  const periodYear = [filingPeriod, filingYear?.toString()].filter(Boolean).join(' ');
  return periodYear ? `${issueCategory(issueCode)} — ${periodYear}` : issueCategory(issueCode);
}

function presentMatter(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const title = asString(value.title);
  const externalKey = asString(value.externalKey);
  if (!title || value.autoGenerated !== true || !/^issue:/i.test(externalKey ?? '')) return value;
  return { ...value, title: presentIssueMatterTitle(title, externalKey) };
}

function presentLdaRecord(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.recordType !== 'federal_lobbying' || value.sourceType !== 'lda') return value;

  const presentation = buildLdaRecordPresentation(value);
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const priorPresentation = isRecord(metadata.presentation) ? metadata.presentation : {};

  return {
    ...value,
    title: presentation.displayTitle,
    summary: presentation.displaySummary,
    status: presentation.metadataLine,
    metadata: {
      ...metadata,
      presentation: {
        ...priorPresentation,
        sourceTitle: presentation.sourceTitle,
        sourceStatus: presentation.sourceStatus,
        displayTitle: presentation.displayTitle,
        displaySummary: presentation.displaySummary,
        category: presentation.category,
        issueCode: presentation.issueCode,
        filingYear: presentation.filingYear,
        filingPeriod: presentation.filingPeriod,
        topics: presentation.topics,
        specificAskStated: presentation.specificAskStated,
        sourceLabel: 'LDA filing',
      },
    },
  };
}

function presentTimelineEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const title = asString(value.title);
  const matterTitle = asString(value.matterTitle);
  return {
    ...value,
    title:
      value.kind === 'record' && value.subtype === 'federal_lobbying' && title
        ? presentLdaTimelineTitle(title)
        : value.title,
    matterTitle: matterTitle ? presentIssueMatterTitle(matterTitle) : value.matterTitle,
  };
}

export function presentAdvocacyHistoryResponse(path: string, value: unknown): unknown {
  const normalizedPath = path.replace(/\/+$/, '');
  if (normalizedPath.includes('/federal-register-correlations')) return value;

  if (normalizedPath.endsWith('/timeline')) {
    return Array.isArray(value) ? value.map(presentTimelineEntry) : value;
  }

  if (Array.isArray(value)) return value.map(presentMatter);
  if (!isRecord(value)) return value;

  const presentedMatter = presentMatter(value);
  if (!isRecord(presentedMatter)) return presentedMatter;
  return {
    ...presentedMatter,
    records: Array.isArray(presentedMatter.records)
      ? presentedMatter.records.map(presentLdaRecord)
      : presentedMatter.records,
  };
}

/**
 * Read-side presentation layer for Advocacy History.
 *
 * The durable ledger keeps the original source title/status untouched for
 * provenance and idempotency. GET responses turn LDA filing slugs such as
 * `2021 first_quarter — DEF` into issue-first product copy while retaining
 * the original values under metadata.presentation. Existing and future
 * records therefore improve immediately without a data rewrite or migration.
 */
@Injectable()
export class AdvocacyHistoryPresentationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
    }>();
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
    if (request.method !== 'GET' || !path.includes('/advocacy-matters')) return next.handle();
    return next.handle().pipe(map((value) => presentAdvocacyHistoryResponse(path, value)));
  }
}
