import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { factCitations, FACT_UUID_RE } from '../context/fact-citations.js';
import { LIVE_NODE_WHERE } from '../strategy/live-node.js';
import { requireWatchSourceAccess } from './watch-source-access.js';
import type { Finding } from './watcher-checks.js';

type Tx = Prisma.TransactionClient;
interface Dependency {
  nodeId: string; factId: string; documentId: string | null; checksum: string | null;
  sourceRef: string | null; factState: string; documentState: string | null;
  validUntil: string | null; expired: boolean; supersedesId: string | null;
}
export interface WatchSourceSnapshot {
  version: 1; strategyId: string; clientId: string; strategyVersionId: string; checkedOn: string;
  dependencies: Dependency[]; fingerprint: string;
}
// PostgreSQL jsonb reorders object keys. Hash a canonical representation.
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const content = (s: Omit<WatchSourceSnapshot, 'fingerprint'>) => ({
  version: s.version, strategyId: s.strategyId, clientId: s.clientId,
  strategyVersionId: s.strategyVersionId, checkedOn: s.checkedOn, dependencies: s.dependencies,
});

/** Resolve only this plan's cited facts. No text/model call and no client scan.
 * Source locks precede the strategy lock: document reassignment uses that order.
 * Callers recheck the plan and authority after taking their strategy lock. */
export async function watchSourceSnapshot(tx: Tx, tenantId: string, strategyId: string, lock = false): Promise<WatchSourceSnapshot | null> {
  const strategy = await tx.spStrategy.findFirst({
    where: { id: strategyId, tenantId, archivedAt: null },
    include: { nodes: { where: { ...LIVE_NODE_WHERE } } },
  });
  if (!strategy) throw new NotFoundException('Strategy not found');
  const citations = factCitations(strategy.nodes).filter(c => c.nodeId !== null)
    .map(c => ({ ...c, factId: FACT_UUID_RE.test(c.factId) ? c.factId.toLowerCase() : c.factId }));
  if (!citations.length) return null;
  const ids = [...new Set(citations.map(c => c.factId).filter(id => FACT_UUID_RE.test(id)))].sort();
  const readFacts = () => tx.spContextFact.findMany({ where: { tenantId, clientId: strategy.clientId, id: { in: ids } } });
  let facts = ids.length ? await readFacts() : [];
  const documentIds = [...new Set(facts.map(f => f.documentId))].sort();
  if (lock && documentIds.length) {
    await tx.$queryRawUnsafe(`SELECT id FROM sp_context_document WHERE tenant_id=$1::uuid
      AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, tenantId, documentIds);
    await tx.$queryRawUnsafe(`SELECT id FROM sp_context_fact WHERE tenant_id=$1::uuid
      AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, tenantId, ids);
    facts = await readFacts();
  }
  const documents = documentIds.length ? await tx.spContextDocument.findMany({ where: { tenantId, id: { in: documentIds } } }) : [];
  const byFact = new Map(facts.map(f => [f.id, f]));
  const byDocument = new Map(documents.map(d => [d.id, d]));
  const today = new Date().toISOString().slice(0, 10);
  const dependencies: Dependency[] = [];
  for (const citation of citations) {
    const fact = byFact.get(citation.factId), document = fact && byDocument.get(fact.documentId);
    // Existing client/firm packs remain outside this finite strategy-scoped slice.
    if (document && document.clientId === strategy.clientId && ['client', 'firm'].includes(document.scope)) continue;
    const eligible = !!fact && !!document && fact.clientId === strategy.clientId &&
      document.clientId === strategy.clientId && document.scope === 'strategy' && document.scopeRef === strategyId;
    const until = eligible && document!.validUntil ? document!.validUntil.toISOString().slice(0, 10) : null;
    dependencies.push({ nodeId: citation.nodeId!, factId: citation.factId,
      documentId: eligible ? document!.id : null, checksum: eligible ? document!.checksum : null,
      sourceRef: eligible ? fact!.sourceRef : null, factState: eligible ? fact!.state : 'unavailable',
      documentState: eligible ? document!.state : null, validUntil: until, expired: until !== null && until < today,
      supersedesId: eligible ? document!.supersedesId : null });
  }
  if (!dependencies.length) return null;
  const unique = [...new Map(dependencies.map(d => [`${d.nodeId}:${d.factId}`, d])).values()]
    .sort((a, b) => `${a.nodeId}:${a.factId}`.localeCompare(`${b.nodeId}:${b.factId}`));
  const head = await tx.spVersion.findFirst({ where: { strategyId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  if (!head) throw new ConflictException('Strategy has no saved version');
  const snapshot = content({ version: 1, strategyId, clientId: strategy.clientId, strategyVersionId: head.id, checkedOn: today, dependencies: unique });
  return { ...snapshot, fingerprint: digest(snapshot) };
}

export function storedWatchSources(findings: unknown): WatchSourceSnapshot | null {
  const value = (findings as { sourceDependencies?: WatchSourceSnapshot } | null)?.sourceDependencies;
  if (value == null) return null;
  if (value.version !== 1 || !Array.isArray(value.dependencies) || typeof value.fingerprint !== 'string' ||
      digest(content(value)) !== value.fingerprint) throw new ConflictException('Invalid saved source check');
  return value;
}
export const sameWatchSources = (a: WatchSourceSnapshot | null, b: WatchSourceSnapshot | null) =>
  (a?.fingerprint ?? null) === (b?.fingerprint ?? null);
export function watchSourceRunKey(key: string, source: WatchSourceSnapshot | null) {
  const suffix = source ? `:source:${source.fingerprint}` : '';
  return suffix && !key.includes(suffix) ? key + suffix : key;
}
export function preserveWatchSources(current: unknown, next: unknown) {
  const source = storedWatchSources(current);
  if (source && !isDeepStrictEqual(source, storedWatchSources(next)))
    throw new ConflictException('A saved Watch source check is immutable');
}
export function watchSourceFindings(source: WatchSourceSnapshot | null): Finding[] {
  const nodes = [...new Set(source?.dependencies.filter(d => d.factState !== 'active' || d.documentState !== 'active' || d.expired).map(d => d.nodeId) ?? [])];
  return nodes.length ? [{ code: 'cited-source-stale', severity: 'warning', nodeIds: nodes,
    message: 'Cited source evidence changed or is no longer available.',
    suggestion: 'Review the current source before revising these steps.', category: 'context',
    title: 'Cited source needs review', impact: 'These steps still cite an older or unavailable source.',
    whyCompared: ['saved fact citation', 'current document revision and fact state'], sortRank: 4 }] : [];
}

/** Source-bound proposals never adopt the latest run's different lineage. */
export async function requireWatchProposalSources(tx: Tx, tenantId: string, userId: string,
  proposal: { strategyId: string; runId: string | null; watchKey?: string | null }, current: WatchSourceSnapshot | null) {
  if (!proposal.watchKey) return;
  const run = proposal.runId ? await tx.spAgentRun.findFirst({ where: { id: proposal.runId, tenantId } }) : null;
  const stored = storedWatchSources(run?.findings);
  const observed = current;
  if (stored || observed) {
    await requireWatchSourceAccess(tx, tenantId, (observed ?? stored)!.clientId, userId);
    const lockedPlanSources = await watchSourceSnapshot(tx, tenantId, proposal.strategyId);
    if (!sameWatchSources(stored, observed) || !sameWatchSources(observed, lockedPlanSources)) throw new ConflictException('Cited sources changed. Recheck this plan before accepting.');
  }
}

/** Reuse for every existing route exposing a source-bound run or proposal. */
export async function requireSavedWatchAccess(tx: Tx, tenantId: string, userId: string | undefined,
  findings: unknown): Promise<void> {
  const source = storedWatchSources(findings);
  if (source) await requireWatchSourceAccess(tx, tenantId, source.clientId, userId);
}
export async function requireWatchProposalAccess(tx: Tx, tenantId: string, userId: string | undefined,
  proposal: { runId: string | null; watchKey?: string | null }): Promise<void> {
  if (!proposal.watchKey || !proposal.runId) return;
  const run = await tx.spAgentRun.findFirst({ where: { id: proposal.runId, tenantId } });
  await requireSavedWatchAccess(tx, tenantId, userId, run?.findings);
}
