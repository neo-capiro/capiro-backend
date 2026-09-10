import { MERI_MAIL_MAX_STALENESS_MS } from '@capiro/shared';
import {
  attentionItem,
  evidenceRows,
  isRecord,
  resultHasError,
  resultHasMore,
  resultRows,
  safeInvoke,
  sourceCount,
  stringValue,
  uniqueEvidence,
  type MeriRecipeEvidence,
  type MeriRetrievalRecipeContext,
  type SourceResult,
} from './meriv3-retrieval-recipe-utils.js';

const FREE_MAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordsFrom(result: unknown): Record<string, unknown>[] {
  const rows = resultRows(result).filter(isRecord);
  return isRecord(result) ? [result, ...rows] : rows;
}

function normalizedTargetTokens(target: string): string[] {
  return target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 3 && !['company', 'group', 'strategies', 'strategy'].includes(token),
    );
}

function domainFromIdentifier(value: string): string | null {
  const candidate = value.includes('@') ? (value.split('@').pop() ?? '') : value;
  const normalized = candidate
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/, 1)[0]
    ?.toLowerCase()
    .replace(/[),.;!?]+$/g, '');
  return normalized && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,24}$/.test(normalized) ? normalized : null;
}

function collectContactIdentifiers(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/.test(normalized)) {
      output.add(normalized);
      return;
    }
    const domain = domainFromIdentifier(normalized);
    if (domain && !FREE_MAIL_DOMAINS.has(domain)) output.add(domain);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item) => collectContactIdentifiers(item, output, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      /email|domain|website|url|participant|address/i.test(key) ||
      /^(results|data|items|contacts|records|matches|rows)$/i.test(key)
    ) {
      collectContactIdentifiers(nested, output, depth + 1);
    }
  }
}

function participantIdentifiers(
  target: string,
  contacts: SourceResult,
  clientRegistry: SourceResult,
): string[] {
  const identifiers = new Set<string>();
  collectContactIdentifiers(contacts.result, identifiers);
  collectContactIdentifiers(clientRegistry.result, identifiers);
  const tokens = normalizedTargetTokens(target);
  return [...identifiers]
    .sort((left, right) => {
      const leftMatch = tokens.some((token) => left.includes(token)) ? 1 : 0;
      const rightMatch = tokens.some((token) => right.includes(token)) ? 1 : 0;
      return rightMatch - leftMatch || left.localeCompare(right);
    })
    .slice(0, 3);
}

function clientIdFrom(result: unknown): string | null {
  for (const record of recordsFrom(result)) {
    for (const field of ['clientId', 'id']) {
      const value = stringValue(record[field]);
      if (value) return value;
    }
    if (isRecord(record.client)) {
      const value = stringValue(record.client.id);
      if (value) return value;
    }
  }
  return null;
}

function explicitComplete(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result.paginationComplete === true || result.exhausted === true) return true;
  if (isRecord(result.coverage) && result.coverage.complete === true) return true;
  const returned = numberValue(result.returned) ?? resultRows(result).length;
  const total = numberValue(result.total) ?? numberValue(result.totalMatches);
  return result.hasMore === false && (total == null || total <= returned);
}

function reportedTotal(result: unknown): number | null {
  if (!isRecord(result)) return null;
  return numberValue(result.total) ?? numberValue(result.totalMatches);
}

function mailboxHealthIssues(result: unknown, now = Date.now()): string[] {
  if (!isRecord(result) || !Array.isArray(result.searchedMailboxes)) return [];
  if (result.searchedMailboxes.length === 0) return ['No connected mailbox was searched.'];
  const issues: string[] = [];
  for (const raw of result.searchedMailboxes) {
    if (!isRecord(raw)) {
      issues.push('Mailbox coverage returned an invalid record.');
      continue;
    }
    const provider = typeof raw.provider === 'string' ? raw.provider : 'mailbox';
    const account = typeof raw.accountEmail === 'string' ? raw.accountEmail : provider;
    const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
    if (/error|failed|disabled|unavailable|needs_configuration/.test(status)) {
      issues.push(`${account} is ${status || 'unavailable'}.`);
      continue;
    }
    const syncedMessages =
      numberValue(raw.syncedMessages) ??
      numberValue(raw.messageCount) ??
      numberValue(raw.syncedCount) ??
      0;
    if (syncedMessages <= 0) {
      issues.push(`${account} has no synchronized messages.`);
      continue;
    }
    const lastSyncAt =
      raw.lastSyncAt instanceof Date
        ? raw.lastSyncAt
        : typeof raw.lastSyncAt === 'string'
          ? new Date(raw.lastSyncAt)
          : null;
    if (!lastSyncAt || !Number.isFinite(lastSyncAt.getTime())) {
      issues.push(`${account} has no verifiable last-sync timestamp.`);
      continue;
    }
    if (now - lastSyncAt.getTime() > MERI_MAIL_MAX_STALENESS_MS) {
      issues.push(`${account} has not synchronized within the last 48 hours.`);
    }
  }
  return issues;
}

function mailboxCoverage(
  sources: readonly SourceResult[],
  communications: readonly MeriRecipeEvidence[],
) {
  const mailSources = sources.filter((source) => source.tool === 'search_emails');
  const errors = mailSources.filter((source) => resultHasError(source.result));
  const healthIssues = [
    ...new Set(mailSources.flatMap((source) => mailboxHealthIssues(source.result))),
  ];
  const totals = mailSources
    .map((source) => reportedTotal(source.result))
    .filter((value): value is number => value != null);
  const maxReportedMatches = totals.length ? Math.max(...totals) : null;
  const recoveredAllReported =
    maxReportedMatches != null && communications.length >= maxReportedMatches;
  const paginationComplete =
    errors.length === 0 &&
    (recoveredAllReported ||
      (mailSources.length > 0 && mailSources.every((source) => explicitComplete(source.result))));
  const paginationIncomplete =
    !paginationComplete ||
    (mailSources.some((source) => resultHasMore(source.result)) && !recoveredAllReported);

  return {
    complete: errors.length === 0 && healthIssues.length === 0 && !paginationIncomplete,
    authoritative: true,
    requestedDomains: ['mail'],
    searchedDomains: ['mail'],
    requestedEntityCount: 1,
    searchedEntityCount: mailSources.length > errors.length ? 1 : 0,
    recordsEvaluated: maxReportedMatches ?? communications.length,
    recordsReturned: communications.length,
    paginationComplete: !paginationIncomplete,
    truncated: paginationIncomplete,
    partialSources: paginationIncomplete || healthIssues.length > 0 ? ['search_emails'] : [],
    unavailableSources: [
      ...errors.map((source) => ({
        source: 'mail',
        reason:
          isRecord(source.result) && typeof source.result.error === 'string'
            ? source.result.error
            : 'mailbox unavailable',
      })),
      ...healthIssues.map((reason) => ({ source: 'mail', reason })),
    ],
  };
}

export async function executeMeriRelationshipBrief(
  input: Record<string, unknown>,
  ctx: MeriRetrievalRecipeContext,
) {
  const target = stringValue(input.entity) ?? ctx.plan.targetHint;
  if (!target) return { error: 'entity is required', results: [] };
  const withinDays =
    typeof input.withinDays === 'number'
      ? Math.min(Math.max(Math.floor(input.withinDays), 1), 3650)
      : undefined;
  const mailHistoryFocus =
    ctx.plan.reasons.includes('mail-history-focus') ||
    (ctx.plan.requiredDomains.length === 1 && ctx.plan.requiredDomains[0] === 'mail');

  const [primaryMail, contacts, memory, clientRegistry] = await Promise.all([
    safeInvoke(ctx.invoke, 'search_emails', {
      query: target,
      ...(withinDays ? { withinDays } : {}),
      limit: 50,
    }),
    safeInvoke(ctx.invoke, 'find_contacts', { query: target, limit: 100 }),
    safeInvoke(ctx.invoke, 'search_memory', {
      query: `relationship, decisions, commitments, promises, concerns, and history with ${target}`,
      k: 15,
    }),
    safeInvoke(ctx.invoke, 'lookup_client_registry', { name: target }),
  ]);
  const sources: SourceResult[] = [primaryMail, contacts, memory, clientRegistry];

  const participants = participantIdentifiers(target, contacts, clientRegistry);
  if (participants.length) {
    sources.push(
      ...(await Promise.all(
        participants.map((participant) =>
          safeInvoke(ctx.invoke, 'search_emails', {
            participant,
            ...(withinDays ? { withinDays } : {}),
            limit: 50,
          }),
        ),
      )),
    );
  }

  const matchedSubjects = [
    ...new Set(
      sources
        .filter((source) => source.tool === 'search_emails')
        .flatMap((source) => evidenceRows(source.tool, source.result, 50))
        .map((row) => row.title.trim())
        .filter((subject) => subject && !/^search_emails result/i.test(subject)),
    ),
  ].slice(0, 4);
  if (matchedSubjects.length) {
    const preferredDomain = participants
      .map(domainFromIdentifier)
      .find((value): value is string => Boolean(value));
    sources.push(
      ...(await Promise.all(
        matchedSubjects.map((subject) =>
          safeInvoke(ctx.invoke, 'search_emails', {
            query: subject,
            ...(preferredDomain ? { participant: preferredDomain } : {}),
            ...(withinDays ? { withinDays } : {}),
            limit: 50,
          }),
        ),
      )),
    );
  }

  const clientId = clientIdFrom(clientRegistry.result);
  if (!mailHistoryFocus && clientId) {
    sources.push(
      ...(await Promise.all([
        safeInvoke(ctx.invoke, 'get_client_context', { clientId }),
        safeInvoke(ctx.invoke, 'search_client_knowledge', {
          clientId,
          query: 'relationship people decisions commitments strategy recent work',
        }),
        safeInvoke(ctx.invoke, 'query_debriefs', { clientId }),
        safeInvoke(ctx.invoke, 'query_tasks', { clientId, limit: 50 }),
        safeInvoke(ctx.invoke, 'query_outreach', { clientId, limit: 50 }),
      ])),
    );
  }

  const evidence = uniqueEvidence(
    sources.flatMap((source) => evidenceRows(source.tool, source.result, 100)),
  );
  const chronology = evidence
    .filter((row) => row.occurredAt)
    .sort((a, b) => Date.parse(b.occurredAt ?? '') - Date.parse(a.occurredAt ?? ''));
  const communications = evidence.filter((row) => row.sourceTool === 'search_emails');
  const people = evidence.filter((row) => row.sourceTool === 'find_contacts');
  const memories = evidence.filter((row) => row.sourceTool === 'search_memory');
  const commitments = evidence.filter(
    (row) => row.sourceTool === 'query_tasks' && attentionItem(row),
  );
  const documents = evidence.filter((row) => row.sourceTool === 'search_client_knowledge');
  const manifest = mailboxCoverage(sources, communications);
  const domains = [
    ...new Set(
      participants.map(domainFromIdentifier).filter((value): value is string => Boolean(value)),
    ),
  ];
  const optionalFailures = sources
    .filter((source) => source.tool !== 'search_emails' && resultHasError(source.result))
    .map((source) => source.tool);

  return {
    tool: 'query_relationship_brief',
    subject: target,
    resolvedEntity: {
      canonicalName: target,
      domains,
      ...(clientId ? { clientId } : {}),
    },
    resolutionStatus:
      communications.length > 0 || people.length > 0 || clientId ? 'resolved' : 'unresolved',
    summary: {
      evidenceItems: evidence.length,
      communications: communications.length,
      people: people.length,
      memoryItems: memories.length,
      openCommitments: commitments.length,
      documents: documents.length,
      threadLikeFollowups: matchedSubjects.length,
      participantFollowups: participants.length,
      firstObservedAt: chronology.at(-1)?.occurredAt ?? null,
      lastObservedAt: chronology[0]?.occurredAt ?? null,
      recordsEvaluated: manifest.recordsEvaluated,
      recordsReturned: manifest.recordsReturned,
    },
    chronology: chronology.slice(0, 80),
    openCommitments: commitments.slice(0, 20),
    people: people.slice(0, 30),
    communications: communications.slice(0, 80),
    documents: documents.slice(0, 20),
    memories: memories.slice(0, 20),
    sections: Object.fromEntries(
      [...new Set(sources.map((source) => source.tool))].map((tool) => [
        tool,
        sourceCount(sources, tool),
      ]),
    ),
    results: evidence.slice(0, 120),
    coverage: manifest,
    diagnostics: {
      optionalSourceFailures: optionalFailures,
      mailHistoryFocus,
    },
    answerDirective:
      'Write a clean, chronological relationship or email-history summary. Lead with the relationship arc, then dated phases, key correspondents, current status, and any open commitments supported by evidence. Use only the numbered [N] citations supplied with this tool result; never expose internal [S:tool:id] markers. Do not expose tool names, HTTP errors, entity fan-out, raw source ids, “legislative context”, developer diagnostics, or a work log in the prose. Optional contact or memory failures do not make a mailbox history incomplete. Mention a limitation only when coverage.complete is false, and describe it in plain language.',
    nextRecommendedTools: [],
    note: manifest.complete
      ? `The mailbox history covered ${manifest.recordsReturned} unique synchronized messages for the requested scope.`
      : `The mailbox returned ${manifest.recordsReturned} unique messages out of ${manifest.recordsEvaluated} reported matches; the answer should be labeled as a summary of the retrieved history rather than exhaustive.`,
  };
}
