import { Alert, Button, Spin } from 'antd';
import { LinkOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { liveHearingApiError } from './live-hearings-api.js';

type UnknownRecord = Record<string, unknown>;

interface BroadcastCandidate {
  provider: string;
  officialPageUrl: string;
  resolutionState: string;
  capturePolicy: string;
  priority: number;
}

interface BroadcastView {
  hearingId: string;
  title: string;
  officialEventPage?: string;
  candidate?: BroadcastCandidate;
  embedUrl?: string;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 999;
}

function safeHttpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Inline playback is intentionally allowlisted. A resolved media transport is
 * never exposed to the browser; only a known first-party public EMBED PAGE may
 * be framed. Everything else is an official-source link.
 */
export function safeOfficialEmbedUrl(value?: string): string | undefined {
  const safe = safeHttpUrl(value);
  if (!safe) return undefined;
  const url = new URL(safe);
  const host = url.hostname.toLowerCase();
  const senate = host === 'senate.gov' || host.endsWith('.senate.gov');
  if (senate && /(^|\/)isvp(\/|$)/i.test(url.pathname)) return url.toString();
  return undefined;
}

function normalizeBroadcast(value: unknown): BroadcastView {
  const row = record(value);
  const hearingId = stringValue(row.id, row.hearingId) ?? '';
  const rawCandidates = Array.isArray(row.streamCandidates) ? row.streamCandidates : [];
  const candidates = rawCandidates
    .map((value): BroadcastCandidate | undefined => {
      const item = record(value);
      const officialPageUrl = safeHttpUrl(stringValue(item.officialPageUrl));
      if (!officialPageUrl) return undefined;
      return {
        provider: stringValue(item.provider) ?? 'official_source',
        officialPageUrl,
        resolutionState: stringValue(item.resolutionState) ?? 'NOT_CHECKED',
        capturePolicy: stringValue(item.capturePolicy) ?? 'REVIEW_REQUIRED',
        priority: numberValue(item.priority),
      };
    })
    .filter((item): item is BroadcastCandidate => Boolean(item))
    .sort((left, right) => {
      const stateRank = (state: string) => {
        const normalized = state.toUpperCase();
        if (normalized === 'LIVE') return 0;
        if (normalized === 'READY') return 1;
        if (normalized === 'WAITING_FOR_STREAM') return 2;
        if (normalized === 'ENDED') return 3;
        return 4;
      };
      return stateRank(left.resolutionState) - stateRank(right.resolutionState) || left.priority - right.priority;
    });
  const candidate = candidates[0];
  return {
    hearingId,
    title: stringValue(row.title) ?? 'Congressional proceeding',
    officialEventPage: safeHttpUrl(stringValue(row.officialPageUrl, row.url)),
    candidate,
    embedUrl: safeOfficialEmbedUrl(candidate?.officialPageUrl),
  };
}

function titleCase(value?: string): string {
  return (value ?? 'Unknown')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function LiveHearingsV2BroadcastPanel({ hearingId }: { hearingId: string }) {
  const api = useApi();
  const query = useQuery<BroadcastView>({
    queryKey: ['legiwatch', 'live-hearings', 'broadcast', hearingId],
    enabled: Boolean(hearingId),
    queryFn: async () =>
      normalizeBroadcast(
        (await api.get<unknown>(`/api/legiwatch/live-hearings/events/${encodeURIComponent(hearingId)}`)).data,
      ),
    retry: false,
    refetchInterval: 15_000,
  });

  if (!hearingId) return null;
  if (query.isLoading) {
    return (
      <div style={{ minHeight: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <Spin size="small" /> Resolving official broadcast…
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Official broadcast metadata is temporarily unavailable"
        description={liveHearingApiError(query.error)}
        style={{ marginBottom: 14 }}
      />
    );
  }

  const broadcast = query.data;
  if (!broadcast) return null;
  const link = broadcast.candidate?.officialPageUrl ?? broadcast.officialEventPage;
  if (!link) {
    return (
      <Alert
        type="info"
        showIcon
        message="Official broadcast not posted yet"
        description="The Hearing Room remains available while Capiro continues source resolution. No stream URL is guessed or fabricated."
        style={{ marginBottom: 14 }}
      />
    );
  }

  return (
    <section
      aria-label="Official hearing broadcast"
      style={{
        marginBottom: 14,
        padding: 14,
        border: '1px solid #e2e6ea',
        borderRadius: 14,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: broadcast.embedUrl ? 12 : 0 }}>
        <div style={{ display: 'grid', gap: 3 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: '#727b86' }}>
            Official broadcast
          </span>
          <strong>{broadcast.title}</strong>
          {broadcast.candidate ? (
            <small style={{ color: '#68717d' }}>
              {titleCase(broadcast.candidate.provider)} · {titleCase(broadcast.candidate.resolutionState)} · {titleCase(broadcast.candidate.capturePolicy)}
            </small>
          ) : null}
        </div>
        <Button href={link} target="_blank" icon={<LinkOutlined />}>
          Open official source
        </Button>
      </div>
      {broadcast.embedUrl ? (
        <div style={{ position: 'relative', width: '100%', paddingTop: '56.25%', overflow: 'hidden', borderRadius: 10, background: '#111' }}>
          <iframe
            title={`Official broadcast — ${broadcast.title}`}
            src={broadcast.embedUrl}
            allow="autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 9, alignItems: 'center', marginTop: 10, padding: 12, borderRadius: 10, background: '#f6f7f8', color: '#5f6975' }}>
          <VideoCameraOutlined />
          <span>This official source is not on the inline-embed allowlist. Open it directly; Capiro will not expose or frame an unverified media transport.</span>
        </div>
      )}
    </section>
  );
}

export default LiveHearingsV2BroadcastPanel;
