/**
 * Live hearing room (§7.8) — a route, not a tab. Module chrome suppressed;
 * browser back returns to Hearings.
 *
 * Layout (A.8): session bar · dark status strip · video feed spanning the
 * source+transcript columns · Source & capture (left) · Live transcript
 * (centre) · Intelligence (right: Moments · Actions · Entities). No waveform
 * gadget (§4.1 #21). Pausing playback does NOT pause capture or transcription —
 * the control says so.
 *
 * Transport: the live transcript streams over the canonical socket.io gateway
 * (`/intel-api/live`) using a single-use WS ticket minted over HTTPS
 * (lib/hearing-watch-api.ts `mintWsTicket`). Persisted pages come from
 * `useHearingTranscript`. A dropped source renders RECOVERABLE (§9), never
 * "completed".
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  useHearingSession,
  useHearingTranscript,
  mintWsTicket,
  mediaKindOf,
} from '../../../../lib/hearing-watch-api.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable, LwStateRecoverable } from '../states/SystemStates.js';

/** One transcript row in the room — a persisted or live segment plus the
 *  room-only display fields. Declared independently (not extending
 *  HearingTranscriptItem) so the interim row can carry a synthetic id. */
interface LiveSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
  resolvedSpeakerName?: string;
  confidence?: number;
  interim?: boolean;
  matched?: boolean;
  tag?: string | null;
}

/** Gateway listens at /intel-api/live. A WebSocket cannot set an Authorization
 *  header, so the browser presents a single-use 60-second ticket minted over
 *  authenticated HTTPS (the same contract as the canonical room). */
function wsUrl(sessionId: string, ticket: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/intel-api/live?sessionId=${encodeURIComponent(
    sessionId,
  )}&ticket=${encodeURIComponent(ticket)}`;
}

export function LiveHearingRoomVNext({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const api = useApi();
  const qc = useQueryClient();
  const session = useHearingSession(sessionId);
  const transcript = useHearingTranscript(sessionId);

  const [playing, setPlaying] = useState(true);
  const [query, setQuery] = useState('');
  const [speaker, setSpeaker] = useState('');
  const [matchedOnly, setMatchedOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [liveSegs, setLiveSegs] = useState<LiveSegment[]>([]);
  const [interim, setInterim] = useState<LiveSegment | null>(null);
  const [clock, setClock] = useState('00:00:00');
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const s = session.data;
  const startedAt = s?.startedAt ? new Date(s.startedAt).getTime() : null;

  // session clock
  useEffect(() => {
    if (startedAt == null) return;
    const start = startedAt;
    const tick = () => {
      const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const pad = (n: number) => String(n).padStart(2, '0');
      setClock(`${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`);
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);

  // live transcript transport — a single-use WS ticket over HTTPS, then a raw
  // WebSocket to the canonical gateway (the same contract as the canonical
  // room; no socket.io-client dependency in apps/web).
  useEffect(() => {
    if (!sessionId || s?.status !== 'live') return;
    let cancelled = false;
    (async () => {
      try {
        const { ticket } = await mintWsTicket(api, sessionId);
        if (cancelled) return;
        const ws = new WebSocket(wsUrl(sessionId, ticket));
        wsRef.current = ws;
        ws.onmessage = (ev) => {
          if (wsRef.current !== ws) return;
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg.type === 'interim') {
              setInterim({
                id: 'interim',
                startMs: msg.segment?.startMs ?? 0,
                endMs: msg.segment?.endMs ?? 0,
                text: msg.segment?.text ?? '',
                speakerLabel: msg.segment?.speakerLabel,
                interim: true,
              });
            } else if (msg.type === 'final' && msg.segment) {
              setInterim(null);
              setLiveSegs((prev) => [
                ...prev,
                { id: msg.segmentId || `${msg.segment.startMs}:${msg.segment.endMs}`, ...msg.segment },
              ]);
            }
          } catch {
            // malformed frame — ignore
          }
        };
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
        };
      } catch {
        // transport failure is surfaced by the status strip's Transcript value
      }
    })();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [sessionId, s?.status, api]);

  const persisted: LiveSegment[] = useMemo(
    () => (transcript.data?.pages ?? []).flatMap((p) => p.items),
    [transcript.data],
  );
  const all = useMemo(() => {
    const merged = [...persisted, ...liveSegs];
    const q = query.trim().toLowerCase();
    return merged.filter((seg) => {
      if (matchedOnly && !seg.matched) return false;
      if (speaker && (seg.resolvedSpeakerName ?? seg.speakerLabel) !== speaker) return false;
      if (q && !seg.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [persisted, liveSegs, query, speaker, matchedOnly]);

  const speakers = useMemo(
    () => Array.from(new Set(persisted.map((x) => x.resolvedSpeakerName ?? x.speakerLabel).filter(Boolean))) as string[],
    [persisted],
  );

  // auto-follow
  useEffect(() => {
    if (follow && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [all.length, interim?.text, follow]);

  const moments = useMemo(() => all.filter((x) => x.matched), [all]);

  const endSession = useCallback(async () => {
    // The canonical session lifecycle ends over the WebSocket (`capture_stop`);
    // there is no REST /end. Send the stop, then invalidate My Sessions so the
    // card flips to the next-session state in the same transition (§3.3).
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'capture_stop' }));
      }
    } catch {
      // the server finalizes on socket close regardless
    }
    wsRef.current?.close();
    wsRef.current = null;
    void qc.invalidateQueries({ queryKey: ['intel', 'hearings'] });
    void qc.invalidateQueries({ queryKey: ['intel', 'upcoming-hearings'] });
    navigate('/legiwatch?tab=hearings');
  }, [qc, navigate]);

  if (session.isLoading) {
    return (
      <div className="lw lw-liveroom">
        <LwStateLoading rows={4} />
      </div>
    );
  }
  if (session.isError || !s) {
    return (
      <div className="lw lw-liveroom">
        <LwStateUnavailable
          source="Live session"
          reason="This hearing session could not be loaded."
          onRetry={() => void session.refetch()}
        />
      </div>
    );
  }

  const recoverable = s.status === 'failed-recoverable';
  const kind = mediaKindOf(s.sourceUrl);

  return (
    <div className="lw lw-liveroom">
      {/* session bar */}
      <div className="lw-liveroom__bar">
        <button type="button" className="lw-navbtn" aria-label="Back to Hearings" onClick={() => navigate('/legiwatch?tab=hearings')}>
          ‹
        </button>
        <span className="lw-mono" style={{ fontSize: 12, fontWeight: 600 }}>{clock}</span>
        <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
          {s.watchlistMatchCount ?? 0} CLIENTS · {moments.length} MOMENTS
        </span>
        <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
          {s.consentStatus ? `CONSENT ${String(s.consentStatus).toUpperCase()}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <LwButton onClick={() => void endSession()}>End session</LwButton>
      </div>

      {/* status strip (dark) — live health values; degradation shows here */}
      <div className="lw-status">
        <StatusPair label="Source" value={s.sourceType ?? '—'} />
        <StatusPair label="Audio" value={s.audioSource ?? '—'} />
        <StatusPair label="Transcript" value={s.status === 'live' ? 'STREAMING' : s.status?.toUpperCase() ?? '—'} />
        <StatusPair label="Capture" value={s.recordingPolicy ?? '—'} />
        <StatusPair label="Last final" value={persisted.length ? `${persisted.length} segs` : '—'} />
        <span style={{ flex: 1 }} />
        <LwPill tone={recoverable ? 'warning' : s.status === 'live' ? 'error' : 'gray'}>
          {recoverable ? 'RECOVERABLE' : (s.status ?? 'unknown').toUpperCase()}
        </LwPill>
      </div>

      {recoverable ? (
        <LwStateRecoverable
          reason="The source URL drifted"
          onResume={() => void session.refetch()}
          onEnd={() => void endSession()}
        />
      ) : null}

      <div className="lw-live">
        {/* video feed — spans source+transcript columns at ≥1280 */}
        <section className="lw-video" aria-label="Committee video feed">
          <div className="lw-video__body">
            <span className="lw-video__badge lw-video__badge--live">
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--lw-error-dot)', animation: 'lwPulse 1.6s ease-in-out infinite' }} aria-hidden="true" />
              LIVE
            </span>
            <span className="lw-video__badge lw-video__badge--src">OFFICIAL COMMITTEE LIVESTREAM</span>
            {playing && s.sourceUrl && kind !== 'unknown' ? (
              kind === 'hls' ? (
                <video style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} src={s.sourceUrl} autoPlay muted controls={false} />
              ) : (
                <video style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} src={s.sourceUrl} autoPlay muted controls={false} />
              )
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div className="lw-video__mark">{(s.committeeId ?? 'LW').slice(0, 2).toUpperCase()}</div>
                <div className="lw-video__caption">COMMITTEE VIDEO FEED</div>
              </div>
            )}
          </div>
          <div className="lw-video__bar">
            <button
              type="button"
              className="lw-video__play"
              aria-label={playing ? 'Pause playback' : 'Play'}
              title="Pausing playback does not pause capture or transcription"
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <span className="lw-video__clock">{clock}</span>
            <div className="lw-video__progress"><div className="lw-video__fill" /></div>
            <span className="lw-video__quality">1080p · {kind === 'hls' ? 'DIRECT HLS' : kind.toUpperCase()}</span>
            <button type="button" className="lw-video__fs" aria-label="Full screen">⤢</button>
          </div>
        </section>

        {/* source & capture (left, under the feed) */}
        <section className="lw-panel" style={{ gridColumn: 1, gridRow: 2 }}>
          <div className="lw-panel__head"><h3 className="lw-panel__title">Source &amp; capture</h3></div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <LwPill tone="brand" size="26">{(s.sourceType ?? 'committee').toUpperCase()}</LwPill>
            <div className="lw-block">
              <div className="lw-block__label">Capture</div>
              <div className="lw-block__body" style={{ marginTop: 6 }}>
                Mode {s.audioSource ?? 'browser_tab'} · {s.recordingPolicy ?? 'record_and_transcribe'}
              </div>
              <div style={{ marginTop: 10 }}>
                <LwButton onClick={() => void endSession()}>Stop capture</LwButton>
              </div>
            </div>
            <div>
              <div className="lw-block__label" style={{ marginBottom: 8 }}>Client impact</div>
              {(s.watchlistMatchCount ?? 0) > 0 ? (
                <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                  {s.watchlistMatchCount} client{s.watchlistMatchCount === 1 ? '' : 's'} with matched moments.
                </p>
              ) : (
                <p className="lw-state__body" style={{ maxWidth: 'none' }}>
                  No clients have matched moments yet — stated as such, never as zero-with-coverage.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* live transcript (centre) */}
        <section className="lw-panel" style={{ gridColumn: 2, gridRow: 2, display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          <div className="lw-panel__head" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h3 className="lw-panel__title">Live transcript</h3>
            <span className="lw-card__meta">{persisted.length} final</span>
            <div className="lw-search" style={{ flex: '0 1 200px', minWidth: 140, height: 32 }}>
              <input aria-label="Search transcript" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <select aria-label="Speaker" className="lw-btn" style={{ height: 32 }} value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
              <option value="">All speakers</option>
              {speakers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
            </select>
            <button type="button" className={`lw-btn${matchedOnly ? ' lw-btn--primary' : ''}`} style={{ height: 32 }} onClick={() => setMatchedOnly((v) => !v)} aria-pressed={matchedOnly}>
              Matched only
            </button>
          </div>
          {!follow ? (
            <div style={{ padding: '8px 16px', background: 'var(--lw-warn-card)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--lw-warn-fg)' }}>Auto-follow paused</span>
              <button type="button" className="lw-btn" style={{ height: 28 }} onClick={() => setFollow(true)}>Jump to live</button>
            </div>
          ) : null}
          <div
            ref={transcriptRef}
            style={{ flex: 1, overflowY: 'auto', maxHeight: 520 }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (!atBottom && follow) setFollow(false);
            }}
          >
            {all.map((seg) => (
              <div key={seg.id} className={`lw-tseg${seg.matched ? ' is-match' : ''}`}>
                <span className="lw-tseg__tc">{fmtMs(seg.startMs)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="lw-tseg__sp">{seg.resolvedSpeakerName ?? seg.speakerLabel ?? 'SPEAKER'}</span>
                    {seg.matched ? <LwPill tone="brand" size="22">MATCH</LwPill> : null}
                    <LwPill tone="gray" size="22">FINAL</LwPill>
                  </div>
                  <div className="lw-tseg__text">{seg.text}</div>
                </div>
              </div>
            ))}
            {interim ? (
              <div className="lw-tseg lw-tseg__interim">
                <span className="lw-tseg__tc">{fmtMs(interim.startMs)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="lw-tseg__sp">{interim.resolvedSpeakerName ?? interim.speakerLabel ?? 'SPEAKER'}</div>
                  <div className="lw-tseg__text">{interim.text}</div>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        {/* intelligence (right): Moments · Actions · Entities */}
        <section className="lw-panel" style={{ gridColumn: 3, gridRow: '1 / span 2' }}>
          <div className="lw-panel__head"><h3 className="lw-panel__title">Intelligence</h3></div>
          <div style={{ maxHeight: 560, overflowY: 'auto' }}>
            <div className="lw-history__label" style={{ padding: '12px 16px 6px' }}>Moments</div>
            {moments.length === 0 ? (
              <p className="lw-state__body" style={{ padding: '0 16px 12px', maxWidth: 'none' }}>
                No matched moments yet. Matches against the client watchlist land here.
              </p>
            ) : (
              moments.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="lw-mrow"
                  style={{ width: '100%', border: 0, background: 'none', textAlign: 'left' }}
                  onClick={() => setFollow(false)}
                >
                  <span className="lw-mrow__tc">{fmtMs(m.startMs)}</span>
                  <div>
                    <LwPill tone="brand" size="22">{m.tag ?? 'CLIENT MATCH'}</LwPill>
                    <div className="lw-mrow__body" style={{ marginTop: 6 }}>{m.text}</div>
                  </div>
                </button>
              ))
            )}
          </div>
          <div style={{ padding: 16, borderTop: '1px solid var(--lw-line)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <LwButton variant="primary" onClick={() => { /* create brief via Workspace */ }}>Create brief</LwButton>
            <LwButton onClick={() => { /* save moment */ }}>Save moment</LwButton>
            <LwButton onClick={() => { /* Ask Meri with session context (§12.5) */ }}>Ask Meri</LwButton>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="lw-status__pair">
      <span className="lw-status__label">{label}</span>
      <span className="lw-status__value">{value}</span>
    </div>
  );
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
