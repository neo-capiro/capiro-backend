import type {
  ChatMessageRetrieval,
  GroundingCaveat,
  MeriCitation,
  MeriConversation,
  MeriVerification,
} from '../../components/chat/chat-store.js';
import {
  MERI_WINDOW_CLIENT_QUERY,
  MERI_WINDOW_PROMPT_QUERY,
  MERI_WINDOW_QUERY,
} from '../../components/chat/meri-window.js';

export interface PersistedAttachment {
  id: string;
  filename: string;
  kind: string;
  status: string;
}

export interface PersistedChartArtifact {
  id: string;
  title: string;
}

export interface PersistedMessage {
  id?: string;
  role?: string;
  body?: string;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
  artifacts?: unknown[];
}

export interface MeriContextRequest {
  prompt: string;
  clientId: string | null;
}

/**
 * Read the documented one-time vNext launch context from a route query.
 *
 * A client-only request is valid: it opens a record-free `/meri/new` landing
 * page with that client selected but does not create a conversation until the
 * user sends. Empty values are treated as absent so a stale `?meriPrompt=` URL
 * cannot accidentally create a blank turn.
 */
export function meriContextRequest(search: string): MeriContextRequest | null {
  const incoming = new URLSearchParams(search);
  const prompt = incoming.get(MERI_WINDOW_PROMPT_QUERY)?.trim() ?? '';
  const clientId = incoming.get(MERI_WINDOW_CLIENT_QUERY)?.trim() || null;
  return prompt || clientId ? { prompt, clientId } : null;
}

/** Remove one-time Meri launch context while preserving unrelated route state. */
export function withoutMeriContext(search: string): string {
  const outgoing = new URLSearchParams(search);
  outgoing.delete(MERI_WINDOW_PROMPT_QUERY);
  outgoing.delete(MERI_WINDOW_CLIENT_QUERY);
  const query = outgoing.toString();
  return query ? `?${query}` : '';
}

/**
 * Canonicalize the legacy vNext popup URL (`?meriWindow=1`) onto the addressable
 * Meri routes. Plain launches resolve `/meri`; contextual launches resolve
 * record-free `/meri/new` so the one-time prompt/client context cannot be lost
 * while `/meri` resolves the newest durable thread.
 */
export function legacyMeriWindowRedirect(search: string): string | null {
  const incoming = new URLSearchParams(search);
  if (incoming.get(MERI_WINDOW_QUERY) !== '1') return null;

  const context = meriContextRequest(search);
  const outgoing = new URLSearchParams();
  if (context?.prompt) outgoing.set(MERI_WINDOW_PROMPT_QUERY, context.prompt);
  if (context?.clientId) outgoing.set(MERI_WINDOW_CLIENT_QUERY, context.clientId);

  const base = context ? '/meri/new' : '/meri';
  const query = outgoing.toString();
  return query ? `${base}?${query}` : base;
}

export function threadIdFromPath(pathname: string): string | null {
  const match = /^\/meri\/t\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function mapPersistedAttachments(message: PersistedMessage): PersistedAttachment[] {
  const raw = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  return raw
    .filter(
      (item: unknown): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object',
    )
    .map((item) => ({
      id: String(item.id ?? ''),
      filename: String(item.filename ?? ''),
      kind: String(item.kind ?? 'text'),
      status: String(item.status ?? 'parsed'),
    }))
    .filter((item) => Boolean(item.id));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mapPersistedCitations(message: PersistedMessage): MeriCitation[] {
  const raw = Array.isArray(message.metadata?.citations) ? message.metadata.citations : [];
  return raw
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => typeof item.n === 'number' && typeof item.id === 'string' && typeof item.title === 'string')
    .map((item) => ({
      n: Number(item.n),
      type: typeof item.type === 'string' ? item.type : 'source',
      id: String(item.id),
      title: String(item.title),
      url: typeof item.url === 'string' ? item.url : null,
      snippet: typeof item.snippet === 'string' ? item.snippet : null,
      tool: typeof item.tool === 'string' ? item.tool : 'unknown',
    }));
}

export function mapPersistedVerification(message: PersistedMessage): MeriVerification | undefined {
  const raw = asRecord(message.metadata?.verification);
  if (!raw || typeof raw.totalCount !== 'number' || typeof raw.unsupportedCount !== 'number') return undefined;
  const claims = Array.isArray(raw.claims)
    ? raw.claims
        .map(asRecord)
        .filter((claim): claim is Record<string, unknown> => Boolean(claim))
        .filter((claim) => typeof claim.claim === 'string' && typeof claim.supported === 'boolean')
        .map((claim) => ({
          claim: String(claim.claim),
          supported: Boolean(claim.supported),
          sourceIds: Array.isArray(claim.sourceIds)
            ? claim.sourceIds.filter((id): id is number => typeof id === 'number')
            : [],
        }))
    : [];
  const totalCount = raw.totalCount;
  const unsupportedCount = raw.unsupportedCount;
  return {
    claims,
    totalCount,
    unsupportedCount,
    unsupportedRatio: typeof raw.unsupportedRatio === 'number'
      ? raw.unsupportedRatio
      : totalCount > 0 ? unsupportedCount / totalCount : 0,
    lowConfidence: Boolean(raw.lowConfidence),
  };
}

export function mapPersistedGroundingCaveat(message: PersistedMessage): GroundingCaveat | undefined {
  const raw = asRecord(message.metadata?.groundingCaveat);
  const findings = Array.isArray(raw?.findings)
    ? raw.findings
        .map(asRecord)
        .filter((finding): finding is Record<string, unknown> => Boolean(finding))
        .filter((finding) => typeof finding.check === 'string' && typeof finding.severity === 'string' && typeof finding.detail === 'string')
        .map((finding) => ({ check: String(finding.check), severity: String(finding.severity), detail: String(finding.detail) }))
    : [];
  return findings.length ? { topSeverity: typeof raw?.topSeverity === 'string' ? raw.topSeverity : null, findings } : undefined;
}

export function mapPersistedRetrieval(message: PersistedMessage): ChatMessageRetrieval | undefined {
  const raw = asRecord(message.metadata?.retrieval);
  const plan = asRecord(raw?.plan);
  const coverage = asRecord(raw?.coverage);
  if (!plan || !coverage || typeof plan.subjectScope !== 'string' || typeof coverage.complete !== 'boolean') return undefined;
  return {
    plan: {
      subjectScope: plan.subjectScope,
      targetHint: typeof plan.targetHint === 'string' ? plan.targetHint : null,
      recipeTool: typeof plan.recipeTool === 'string' ? plan.recipeTool : null,
      queryClass: typeof plan.queryClass === 'string' ? plan.queryClass : 'unknown',
    },
    coverage: {
      complete: coverage.complete,
      stopReason: typeof coverage.stopReason === 'string' ? coverage.stopReason : 'unknown',
    },
  };
}

export function mapPersistedCharts(message: PersistedMessage): PersistedChartArtifact[] {
  const raw = Array.isArray(message.artifacts) ? message.artifacts : [];
  return raw
    .filter(
      (item: unknown): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object',
    )
    .filter((item) => item.kind === 'analysis_chart' && typeof item.id === 'string')
    .map((item) => ({
      id: String(item.id),
      title: String(item.title ?? '').trim() || 'Analysis chart',
    }));
}

export function normalizeConversation(value: unknown): MeriConversation | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id) return null;

  const rawClient =
    raw.client && typeof raw.client === 'object' ? (raw.client as Record<string, unknown>) : null;
  const client =
    rawClient && typeof rawClient.id === 'string' && typeof rawClient.name === 'string'
      ? { id: rawClient.id, name: rawClient.name }
      : null;

  const rawLatest =
    raw.latestMessage && typeof raw.latestMessage === 'object'
      ? (raw.latestMessage as Record<string, unknown>)
      : null;
  const latestMessage =
    rawLatest && typeof rawLatest.body === 'string' && typeof rawLatest.createdAt === 'string'
      ? { body: rawLatest.body, createdAt: rawLatest.createdAt }
      : null;

  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled thread',
    clientId: typeof raw.clientId === 'string' ? raw.clientId : null,
    client,
    latestMessage,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    ...(typeof raw.workspaceId === 'string' ? { workspaceId: raw.workspaceId } : {}),
    ...(raw.workspace && typeof raw.workspace === 'object' &&
    typeof (raw.workspace as Record<string, unknown>).id === 'string' &&
    typeof (raw.workspace as Record<string, unknown>).name === 'string'
      ? {
          workspace: {
            id: String((raw.workspace as Record<string, unknown>).id),
            name: String((raw.workspace as Record<string, unknown>).name),
            clientId: typeof (raw.workspace as Record<string, unknown>).clientId === 'string'
              ? String((raw.workspace as Record<string, unknown>).clientId)
              : null,
          },
        }
      : {}),
  };
}

export function newestConversation(conversations: MeriConversation[]): MeriConversation | null {
  return (
    [...conversations].sort((a, b) => {
      const bTime = Date.parse(b.updatedAt) || 0;
      const aTime = Date.parse(a.updatedAt) || 0;
      return bTime - aTime;
    })[0] ?? null
  );
}
