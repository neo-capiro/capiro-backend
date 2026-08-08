import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

const DEFAULT_BASE_URL = 'https://v3-api.newscatcherapi.com/api';
const DEFAULT_CACHE_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_SIGNAL_QUERY_CHARS = 3_500;
const MAX_DASHBOARD_ITEMS = 8;
const MAX_ITEMS_PER_PRIMARY_CLIENT = 3;
const PAGE_SIZE = 100;

/**
 * NewsCatcher is the retrieval layer; Capiro owns relevance.
 *
 * The provider query is portfolio-wide and deliberately combines two things:
 *   1. public-policy context; and
 *   2. client issue/capability/company signals.
 *
 * This is intentionally NOT `ORG_entity_name = client names`. Small Capiro
 * clients are often affected by a policy/program/capability story without being
 * named in it. Company aliases remain a high-confidence signal, but capability
 * and specific issue matches can independently qualify an article.
 *
 * Broad commercial words are paired with government context so ordinary company
 * news (for example, signing a commercial customer contract) does not become a
 * government-affairs signal merely because it contains the word "contract".
 */
const POLICY_QUERY =
  '(Congress OR Senate OR "House of Representatives" OR "congressional committee" OR hearing OR markup OR legislation OR legislative OR regulation OR regulatory OR rule OR "Federal Register" OR rulemaking OR appropriations OR authorization OR "executive order" OR "White House" OR governor OR "state legislature" OR statehouse OR DoD OR Pentagon OR "Department of Defense" OR Army OR Navy OR "Air Force" OR "Space Force" OR "Marine Corps" OR ((budget OR procurement OR acquisition OR contract OR grant OR award) AND (federal OR government OR agency OR department OR Congress OR state)))';

type SignalKind = 'capability' | 'issue' | 'program' | 'alias';

interface ClientSignal {
  term: string;
  label: string;
  kind: SignalKind;
  priority: number;
  strong: boolean;
}

interface WatchedClient {
  id: string;
  name: string;
  aliases: string[];
  signals: ClientSignal[];
}

interface CapabilitySeed {
  name: string;
  sector: string | null;
  tags: unknown;
  issueCodes: unknown;
  keywords: string[];
  peNumber: string | null;
  peNumbers: string[];
  appropriationAccount: string | null;
  serviceBranch: string | null;
  targetSubcommittee: string | null;
}

interface ClientSeed {
  id: string;
  name: string;
  intakeData: unknown;
  issueCodes: string[];
  capabilities: CapabilitySeed[];
}

interface RawNewsArticle {
  _id?: unknown;
  title?: unknown;
  link?: unknown;
  name_source?: unknown;
  domain_url?: unknown;
  published_date?: unknown;
  description?: unknown;
  content?: unknown;
  duplicate_count?: unknown;
  nlp?: unknown;
}

interface RawSearchResponse {
  articles?: unknown;
}

interface ScoredNewsDashboardItem extends NewsDashboardItem {
  _score: number;
  _primaryClientId: string | null;
}

interface ClientArticleMatch {
  client: WatchedClient;
  score: number;
  labels: string[];
}

export interface NewsDashboardItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  clientMatches: Array<{ id: string; name: string }>;
  topics: string[];
  relevanceReason: string;
  duplicateCount: number | null;
}

export type NewsDashboardUnavailableReason =
  | 'not_configured'
  | 'no_clients'
  | 'provider_unavailable';

export interface NewsDashboardResponse {
  available: boolean;
  provider: 'newscatcher';
  items: NewsDashboardItem[];
  generatedAt: string;
  cached: boolean;
  stale?: boolean;
  reason?: NewsDashboardUnavailableReason;
  monitoredClientCount: number;
  activeClientCount: number;
  coverageLimited: boolean;
}

@Injectable()
export class NewsCatcherDashboardService {
  private readonly logger = new Logger(NewsCatcherDashboardService.name);
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: NewsDashboardResponse }
  >();
  private readonly inflight = new Map<string, Promise<NewsDashboardResponse>>();

  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(tenantId: string): Promise<NewsDashboardResponse> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) {
      return { ...cached.value, cached: true };
    }

    const existing = this.inflight.get(tenantId);
    if (existing) return existing;

    const run = this.computeDashboard(tenantId, cached?.value)
      .then((value) => {
        this.cache.set(tenantId, {
          expiresAt: Date.now() + cacheMs(),
          value: { ...value, cached: false },
        });
        return value;
      })
      .finally(() => this.inflight.delete(tenantId));

    this.inflight.set(tenantId, run);
    return run;
  }

  private async computeDashboard(
    tenantId: string,
    staleValue?: NewsDashboardResponse,
  ): Promise<NewsDashboardResponse> {
    const generatedAt = new Date().toISOString();

    // One tenant-scoped client/capability read. The remaining two portfolio reads
    // below batch LDA-derived issues rather than calling a relevance method once
    // per client (which would turn a dashboard load into N database workflows).
    const allClients = (await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({
        where: { status: { not: 'archived' } },
        select: {
          id: true,
          name: true,
          intakeData: true,
          issueCodes: true,
          capabilities: {
            select: {
              name: true,
              sector: true,
              tags: true,
              issueCodes: true,
              keywords: true,
              peNumber: true,
              peNumbers: true,
              appropriationAccount: true,
              serviceBranch: true,
              targetSubcommittee: true,
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
    )) as ClientSeed[];

    if (allClients.length === 0) {
      return unavailable('no_clients', generatedAt, 0, 0, false);
    }

    const clientIds = allClients.map((client) => client.id);
    const ldaMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: {
          clientId: { in: clientIds },
          source: 'lda',
          confirmed: true,
        },
        select: { clientId: true, externalId: true },
      }),
    );

    const clientsByLdaId = new Map<number, string[]>();
    for (const mapping of ldaMappings) {
      const ldaId = Number(mapping.externalId);
      if (!Number.isFinite(ldaId)) continue;
      const bucket = clientsByLdaId.get(ldaId) ?? [];
      bucket.push(mapping.clientId);
      clientsByLdaId.set(ldaId, bucket);
    }

    const ldaIds = Array.from(clientsByLdaId.keys());
    const ldaCodeRows = ldaIds.length
      ? await this.prisma.$queryRaw<Array<{ id: number; code: string }>>`
          SELECT id, unnest(issue_codes) AS code
          FROM lda_client
          WHERE id = ANY(${ldaIds}::int[]) AND issue_codes IS NOT NULL
        `
      : [];

    const ldaCodesByClient = new Map<string, string[]>();
    for (const row of ldaCodeRows) {
      for (const clientId of clientsByLdaId.get(row.id) ?? []) {
        const bucket = ldaCodesByClient.get(clientId) ?? [];
        bucket.push(row.code);
        ldaCodesByClient.set(clientId, bucket);
      }
    }

    const allIssueCodes = uniqueStrings(
      allClients.flatMap((client) => [
        ...(client.issueCodes ?? []),
        ...(ldaCodesByClient.get(client.id) ?? []),
        ...client.capabilities.flatMap((capability) => stringArray(capability.issueCodes)),
      ]),
    );

    const issueNameRows = allIssueCodes.length
      ? await this.prisma.$queryRaw<Array<{ code: string; name: string }>>`
          SELECT code, name
          FROM lda_issue_code
          WHERE code = ANY(${allIssueCodes}::text[])
        `
      : [];
    const issueNameByCode = new Map(issueNameRows.map((row) => [row.code, row.name]));

    const watched = allClients
      .map((client) =>
        buildWatchedClient(client, ldaCodesByClient.get(client.id) ?? [], issueNameByCode),
      )
      .filter((client) => client.signals.length > 0);

    if (watched.length === 0) {
      return unavailable('no_clients', generatedAt, 0, allClients.length, false);
    }

    const apiKey = process.env.NEWSCATCHER_API_KEY?.trim();
    if (!apiKey || apiKey === 'REPLACE_ME') {
      return unavailable(
        'not_configured',
        generatedAt,
        watched.length,
        allClients.length,
        false,
      );
    }

    const selection = selectSignalsForSharedQuery(watched);
    if (selection.signals.length === 0) {
      return unavailable('no_clients', generatedAt, 0, allClients.length, false);
    }

    const monitoredClients = watched.filter((client) => selection.clientIds.has(client.id));
    const portfolioQuery = selection.signals.map((signal) => quoteBooleanPhrase(signal)).join(' OR ');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const base = (process.env.NEWSCATCHER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
      const response = await fetch(`${base}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-token': apiKey,
        },
        body: JSON.stringify({
          q: `${POLICY_QUERY} AND (${portfolioQuery})`,
          lang: 'en',
          from_: '48h',
          sort_by: 'date',
          ranked_only: true,
          page_size: PAGE_SIZE,
          include_nlp_data: true,
          has_nlp: true,
          exclude_duplicates: true,
          robots_compliant: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(`NewsCatcher dashboard request failed with HTTP ${response.status}`);
        return staleOrUnavailable(
          staleValue,
          generatedAt,
          monitoredClients.length,
          allClients.length,
          selection.coverageLimited,
        );
      }

      const payload = (await response.json()) as RawSearchResponse;
      const articles = Array.isArray(payload.articles)
        ? (payload.articles.filter(isRecord) as RawNewsArticle[])
        : [];

      const scored = articles
        .map((article) => normalizeArticle(article, watched))
        .filter((item): item is ScoredNewsDashboardItem => item != null);
      const items = selectDashboardItems(scored).map(stripInternalScore);

      return {
        available: true,
        provider: 'newscatcher',
        items,
        generatedAt,
        cached: false,
        monitoredClientCount: monitoredClients.length,
        activeClientCount: allClients.length,
        coverageLimited: selection.coverageLimited,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      this.logger.warn(`NewsCatcher dashboard request failed (${reason})`);
      return staleOrUnavailable(
        staleValue,
        generatedAt,
        monitoredClients.length,
        allClients.length,
        selection.coverageLimited,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildWatchedClient(
  client: ClientSeed,
  ldaIssueCodes: string[],
  issueNameByCode: Map<string, string>,
): WatchedClient {
  const intake = asRecord(client.intakeData);
  const dba = typeof intake?.dba === 'string' ? intake.dba.trim() : '';
  const aliases = uniqueStrings([
    client.name,
    stripLegalSuffix(client.name),
    dba,
    stripLegalSuffix(dba),
  ]).filter(isUsefulEntityAlias);

  const signalMap = new Map<string, ClientSignal>();
  const add = (
    term: string,
    label: string,
    kind: SignalKind,
    priority: number,
    strong: boolean,
  ) => addSignal(signalMap, { term, label, kind, priority, strong });

  // Capabilities are the primary path for the typical smaller Capiro client.
  // Names/tags/keywords are far more likely to describe what a client cares
  // about than the company name appearing in national coverage.
  for (const capability of client.capabilities ?? []) {
    add(capability.name, capability.name, 'capability', 0, true);
    for (const tag of stringArray(capability.tags)) {
      add(tag, tag, 'capability', 0, true);
    }
    for (const keyword of capability.keywords ?? []) {
      add(keyword, keyword, 'capability', 0, true);
    }
    if (capability.sector && isSpecificSignalTerm(capability.sector)) {
      add(capability.sector, capability.sector, 'capability', 1, true);
    }

    for (const peCode of uniqueStrings([
      capability.peNumber ?? '',
      ...(capability.peNumbers ?? []),
    ])) {
      add(peCode, `PE ${peCode}`, 'program', 2, true);
    }
    if (capability.appropriationAccount) {
      add(
        capability.appropriationAccount,
        capability.appropriationAccount,
        'program',
        2,
        true,
      );
    }
    if (capability.targetSubcommittee) {
      add(capability.targetSubcommittee, capability.targetSubcommittee, 'program', 2, true);
    }
    // Service branch is useful corroboration but too broad to qualify a story by
    // itself ("Army" should not map every Army article to every Army client).
    if (capability.serviceBranch) {
      add(capability.serviceBranch, capability.serviceBranch, 'program', 4, false);
    }
  }

  const issueCodes = uniqueStrings([
    ...(client.issueCodes ?? []),
    ...ldaIssueCodes,
    ...client.capabilities.flatMap((capability) => stringArray(capability.issueCodes)),
  ]);
  for (const code of issueCodes) {
    const issueName = issueNameByCode.get(code);
    if (!issueName) continue;
    const specific = isSpecificIssueTerm(issueName);
    for (const variant of issueNameVariants(issueName)) {
      add(variant, issueName, 'issue', specific ? 1 : 4, specific);
    }
  }

  // Direct company coverage is retained as a high-confidence bonus/fallback,
  // but comes after issues/capabilities in the provider query ordering.
  for (const alias of aliases) {
    add(alias, 'Direct company coverage', 'alias', 3, true);
  }

  return {
    id: client.id,
    name: client.name,
    aliases,
    signals: Array.from(signalMap.values()).sort(
      (a, b) => a.priority - b.priority || specificityScore(b.term) - specificityScore(a.term),
    ),
  };
}

function addSignal(map: Map<string, ClientSignal>, signal: ClientSignal): void {
  const term = cleanSignalTerm(signal.term);
  if (!isUsefulSearchSignal(term, signal.kind)) return;
  const key = normalizeText(term);
  const existing = map.get(key);
  const next = { ...signal, term };
  if (
    !existing ||
    next.priority < existing.priority ||
    (next.strong && !existing.strong)
  ) {
    map.set(key, next);
  }
}

/**
 * Fairly pack the portfolio into ONE provider query. Round-robin selection means
 * a client with twenty capability tags cannot consume the whole query before the
 * next client gets one signal. Shared terms count once and still cover every
 * client that owns that term.
 *
 * Only strong signals go to NewsCatcher. Broad issue/service terms stay local as
 * corroborating evidence; sending `Defense` or `Army` to the provider would let
 * generic coverage crowd out the first page before Capiro gets a chance to rank.
 */
export function selectSignalsForSharedQuery(clients: WatchedClient[]): {
  signals: string[];
  clientIds: Set<string>;
  coverageLimited: boolean;
} {
  const providerSignals = clients.map((client) => ({
    client,
    signals: client.signals.filter((signal) => signal.strong),
  }));
  const selected: string[] = [];
  const selectedKeys = new Set<string>();
  let chars = 0;
  let omitted = false;
  const maxDepth = providerSignals.reduce(
    (max, entry) => Math.max(max, entry.signals.length),
    0,
  );

  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const entry of providerSignals) {
      const signal = entry.signals[depth];
      if (!signal) continue;
      const key = normalizeText(signal.term);
      if (selectedKeys.has(key)) continue;
      const quoted = quoteBooleanPhrase(signal.term);
      const addition = quoted.length + (selected.length ? 4 : 0);
      if (chars + addition > MAX_SIGNAL_QUERY_CHARS) {
        omitted = true;
        continue;
      }
      selected.push(signal.term);
      selectedKeys.add(key);
      chars += addition;
    }
  }

  const clientIds = new Set(
    providerSignals
      .filter((entry) =>
        entry.signals.some((signal) => selectedKeys.has(normalizeText(signal.term))),
      )
      .map((entry) => entry.client.id),
  );

  if (clientIds.size < clients.length) omitted = true;
  return { signals: selected, clientIds, coverageLimited: omitted };
}

function normalizeArticle(
  article: RawNewsArticle,
  clients: WatchedClient[],
): ScoredNewsDashboardItem | null {
  const title = asNonEmptyString(article.title);
  const url = asNonEmptyString(article.link);
  if (!title || !url || !isHttpUrl(url)) return null;

  const nlp = asRecord(article.nlp);
  const summary = asNonEmptyString(nlp?.summary) ?? '';
  const description = asNonEmptyString(article.description) ?? '';
  // Full article text, when the provider returns it, is used ephemerally only to
  // improve matching. It is never returned to the browser or persisted by this
  // MVP; the customer-facing object stays headline/source/link + derived signals.
  const content = asNonEmptyString(article.content) ?? '';
  const organizationNames = extractOrganizationNames(nlp);
  const searchable = normalizeText(`${title} ${description} ${summary} ${content}`);

  const matches = clients
    .map((client) => matchClientToArticle(client, searchable, organizationNames))
    .filter((match): match is ClientArticleMatch => match != null)
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) return null;

  const topics = policyTopics(`${title} ${description} ${summary} ${content}`);
  // POLICY_QUERY can match provider-indexed body text even when a compact result
  // omits that body. Preserve the qualified signal with a conservative label.
  if (topics.length === 0) topics.push('Public policy');

  const topMatches = matches.slice(0, 3);
  const top = topMatches[0]!;
  const clientLabel = `${top.client.name}${topMatches.length > 1 ? ` +${topMatches.length - 1}` : ''}`;
  const evidenceLabel = top.labels.slice(0, 2).join(' / ');

  return {
    id: asNonEmptyString(article._id) ?? `${url}:${title}`,
    title,
    source:
      asNonEmptyString(article.name_source) ??
      hostname(asNonEmptyString(article.domain_url) ?? url) ??
      'News source',
    url,
    publishedAt: toIsoDate(asNonEmptyString(article.published_date)),
    clientMatches: topMatches.map(({ client }) => ({ id: client.id, name: client.name })),
    topics,
    relevanceReason: `Relevant to ${clientLabel} · ${evidenceLabel}`,
    duplicateCount: asPositiveIntegerOrNull(article.duplicate_count),
    _score: top.score,
    _primaryClientId: top.client.id,
  };
}

function matchClientToArticle(
  client: WatchedClient,
  searchable: string,
  organizationNames: string[],
): ClientArticleMatch | null {
  const direct = client.aliases.some((alias) => {
    const normalizedAlias = normalizeText(alias);
    if (!normalizedAlias) return false;
    return (
      organizationNames.some((entity) => entityMatchesAlias(entity, normalizedAlias)) ||
      containsPhrase(searchable, normalizedAlias)
    );
  });

  const matchedSignals = client.signals.filter(
    (signal) => signal.kind !== 'alias' && matchesSignal(searchable, signal.term),
  );
  const capability = matchedSignals.filter((signal) => signal.kind === 'capability' && signal.strong);
  const issue = matchedSignals.filter((signal) => signal.kind === 'issue' && signal.strong);
  const program = matchedSignals.filter((signal) => signal.kind === 'program' && signal.strong);
  const supporting = matchedSignals.filter((signal) => !signal.strong);

  // A broad issue or service branch alone is not enough. "Defense" and "Army"
  // are context, not proof that an article matters to every defense/Army client.
  if (!direct && capability.length === 0 && issue.length === 0 && program.length === 0) {
    return null;
  }

  let score = direct ? 100 : 0;
  if (capability.length) score += 80 + Math.min(20, (capability.length - 1) * 8);
  if (issue.length) score += 65 + Math.min(16, (issue.length - 1) * 6);
  if (program.length) score += 70 + Math.min(15, (program.length - 1) * 5);
  if (supporting.length) score += Math.min(15, supporting.length * 5);

  const labels = uniqueStrings([
    ...capability.map((signal) => signal.label),
    ...issue.map((signal) => signal.label),
    ...program.map((signal) => signal.label),
    ...(direct ? ['Direct company coverage'] : []),
  ]);

  return { client, score, labels: labels.length ? labels : ['Client relevance'] };
}

function selectDashboardItems(items: ScoredNewsDashboardItem[]): ScoredNewsDashboardItem[] {
  const sorted = [...items].sort(
    (a, b) => b._score - a._score || +new Date(b.publishedAt) - +new Date(a.publishedAt),
  );
  const selected: ScoredNewsDashboardItem[] = [];
  const selectedIds = new Set<string>();
  const perClient = new Map<string, number>();

  for (const item of sorted) {
    if (selected.length >= MAX_DASHBOARD_ITEMS) break;
    const primary = item._primaryClientId;
    if (primary && (perClient.get(primary) ?? 0) >= MAX_ITEMS_PER_PRIMARY_CLIENT) continue;
    selected.push(item);
    selectedIds.add(item.id);
    if (primary) perClient.set(primary, (perClient.get(primary) ?? 0) + 1);
  }

  // If diversity left open slots, fill them with the next best remaining items.
  for (const item of sorted) {
    if (selected.length >= MAX_DASHBOARD_ITEMS) break;
    if (selectedIds.has(item.id)) continue;
    selected.push(item);
    selectedIds.add(item.id);
  }

  return selected;
}

function stripInternalScore(item: ScoredNewsDashboardItem): NewsDashboardItem {
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    url: item.url,
    publishedAt: item.publishedAt,
    clientMatches: item.clientMatches,
    topics: item.topics,
    relevanceReason: item.relevanceReason,
    duplicateCount: item.duplicateCount,
  };
}

function unavailable(
  reason: NewsDashboardUnavailableReason,
  generatedAt: string,
  monitoredClientCount: number,
  activeClientCount: number,
  coverageLimited: boolean,
): NewsDashboardResponse {
  return {
    available: false,
    provider: 'newscatcher',
    items: [],
    generatedAt,
    cached: false,
    reason,
    monitoredClientCount,
    activeClientCount,
    coverageLimited,
  };
}

function staleOrUnavailable(
  staleValue: NewsDashboardResponse | undefined,
  generatedAt: string,
  monitoredClientCount: number,
  activeClientCount: number,
  coverageLimited: boolean,
): NewsDashboardResponse {
  if (staleValue?.available) {
    return {
      ...staleValue,
      generatedAt,
      cached: true,
      stale: true,
      monitoredClientCount,
      activeClientCount,
      coverageLimited,
    };
  }
  return unavailable(
    'provider_unavailable',
    generatedAt,
    monitoredClientCount,
    activeClientCount,
    coverageLimited,
  );
}

function extractOrganizationNames(nlp: Record<string, unknown> | null): string[] {
  if (!nlp) return [];
  const candidates = [nlp.ner_ORG, nlp.translation_ner_ORG];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const row of candidate) {
      if (typeof row === 'string') {
        out.push(row);
        continue;
      }
      const record = asRecord(row);
      const value =
        asNonEmptyString(record?.entity_name) ??
        asNonEmptyString(record?.name) ??
        asNonEmptyString(record?.text);
      if (value) out.push(value);
    }
  }
  return out.map(normalizeText).filter(Boolean);
}

function entityMatchesAlias(entity: string, alias: string): boolean {
  if (entity === alias) return true;
  if (alias.length < 4) return false;
  return containsPhrase(entity, alias) || containsPhrase(alias, entity);
}

function matchesSignal(searchable: string, term: string): boolean {
  const normalized = normalizeText(term);
  if (!normalized) return false;
  if (containsPhrase(searchable, normalized)) return true;

  const tokens = normalized.split(' ').filter((token) => token.length >= 3);
  // Distinctive long single-word concepts tolerate morphological compounds such
  // as communications ↔ telecommunications. Short/generic terms never get this
  // looser path.
  if (tokens.length === 1 && normalized.length >= 8) {
    return searchable
      .split(' ')
      .some(
        (word) =>
          word.length >= 8 && (word.includes(normalized) || normalized.includes(word)),
      );
  }

  // LDA issue names often contain separators ("Aviation/Aircraft/Airlines") and
  // article prose inserts conjunctions between words. For multi-token signals,
  // require every meaningful token rather than requiring an exact phrase.
  return tokens.length >= 2 && tokens.every((token) => containsPhrase(searchable, token));
}

function policyTopics(text: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ['Legislation', /\b(congress|senate|house of representatives|committee|hearing|markup|legislat(?:ion|ive|ure))\b/i],
    ['Regulation', /\b(regulat(?:ion|ory)|federal register|rulemak(?:ing|e)|final rule|proposed rule|rule)\b/i],
    ['Budget', /\b(budget|appropriat(?:ion|ions|e)|authoriz(?:ation|e)|funding level)\b/i],
    ['Procurement', /\b(procurement|acquisition|contract(?:ing|or|ors|s)?|solicitation|award)\b/i],
    ['Grants', /\b(grant|grants|funding opportunity|notice of funding)\b/i],
    ['Defense', /\b(pentagon|department of defense|dod|army|navy|air force|space force|marine corps)\b/i],
    ['State government', /\b(governor|statehouse|state legislature|state senate|state assembly|attorney general)\b/i],
    ['Executive / agency', /\b(executive order|white house|federal agency|department|agency)\b/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([label]) => label).slice(0, 3);
}

function issueNameVariants(value: string): string[] {
  const base = value.trim();
  if (!base) return [];
  return uniqueStrings([
    base,
    ...base
      .split(/[\/;,]/)
      .map((part) => part.trim())
      .filter((part) => isSpecificSignalTerm(part)),
  ]);
}

function isSpecificIssueTerm(value: string): boolean {
  const normalized = normalizeText(value);
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length >= 2) return !tokens.every((token) => BROAD_SIGNAL_TERMS.has(token));
  return isSpecificSignalTerm(value);
}

const BROAD_SIGNAL_TERMS = new Set([
  'defense',
  'budget',
  'appropriations',
  'government',
  'federal',
  'technology',
  'technologies',
  'business',
  'commerce',
  'energy',
  'health',
  'transportation',
  'environment',
  'science',
  'education',
  'tax',
  'taxes',
]);

function isSpecificSignalTerm(value: string): boolean {
  const trimmed = value.trim();
  const normalized = normalizeText(trimmed);
  if (!normalized || BROAD_SIGNAL_TERMS.has(normalized)) return false;
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length >= 2) return normalized.length >= 6;
  if (/^[A-Z0-9-]{2,8}$/.test(trimmed) && /[A-Z]/.test(trimmed)) return true;
  return normalized.length >= 7;
}

function isUsefulSearchSignal(value: string, kind: SignalKind): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  if (kind === 'program' && /^\d{5,}[a-z0-9-]*$/i.test(value.replace(/\s+/g, ''))) return true;
  if (kind === 'alias') return isUsefulEntityAlias(value);
  if (kind === 'issue') return normalized.length >= 4;
  return isSpecificSignalTerm(value);
}

function specificityScore(value: string): number {
  const normalized = normalizeText(value);
  const tokens = normalized.split(' ').filter(Boolean);
  return Math.min(100, normalized.length + tokens.length * 8);
}

function cleanSignalTerm(value: string): string {
  return value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripLegalSuffix(value: string): string {
  if (!value.trim()) return '';
  return value
    .replace(
      /(?:,?\s+)(?:incorporated|inc\.?|llc|l\.l\.c\.?|corp\.?|corporation|co\.?|company|ltd\.?|limited|plc|holdings?)\s*$/i,
      '',
    )
    .trim();
}

function quoteBooleanPhrase(value: string): string {
  return `"${cleanSignalTerm(value)}"`;
}

function isUsefulEntityAlias(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.length >= 2 && normalized !== 'inc' && normalized !== 'llc';
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeText(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asPositiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer > 0 ? integer : null;
}

function toIsoDate(value: string | null): string {
  if (!value) return new Date().toISOString();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function hostname(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function cacheMs(): number {
  return envPositiveInt('NEWSCATCHER_DASHBOARD_CACHE_MS', DEFAULT_CACHE_MS);
}

function timeoutMs(): number {
  return envPositiveInt('NEWSCATCHER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
