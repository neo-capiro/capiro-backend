import type { MeriConversation } from '../../components/chat/chat-store.js';
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
  metadata?: { attachments?: unknown[] } | null;
  artifacts?: unknown[];
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

  const outgoing = new URLSearchParams();
  const prompt = incoming.get(MERI_WINDOW_PROMPT_QUERY);
  const clientId = incoming.get(MERI_WINDOW_CLIENT_QUERY);
  if (prompt) outgoing.set(MERI_WINDOW_PROMPT_QUERY, prompt);
  if (clientId) outgoing.set(MERI_WINDOW_CLIENT_QUERY, clientId);

  const base = prompt || clientId ? '/meri/new' : '/meri';
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
