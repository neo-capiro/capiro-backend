import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { publicPlaybackCoverage, type PlaybackInterval } from '../../lib/hearing-playback-coverage.js';
import { useApiScope } from '../../lib/use-api-scope.js';

interface Epoch {
  id: string;
  startMs: number;
  durableEndMs: number;
  durableBytes: number;
  state: string;
  transcriptState: string;
  expiresAt: string;
  reason: string | null;
}
interface Part {
  partId: string;
  startMs: number;
  endMs: number;
  url: string;
  expiresAt: string;
}
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value, index) => (index ? String(value).padStart(2, '0') : String(value)))
    .join(':');
};

/** Public capture playback remains separate from tenant browser recordings. */
export function PublicHearingAudioPanel({
  hearingId,
  seek,
  onCoverage,
}: {
  hearingId: string;
  seek?: { positionMs: number; request: number };
  onCoverage?: (intervals: PlaybackInterval[]) => void;
}) {
  const scope = useApiScope();
  return <Player key={scope + ':' + hearingId} hearingId={hearingId} seek={seek} onCoverage={onCoverage} />;
}

function Player({
  hearingId,
  seek,
  onCoverage,
}: {
  hearingId: string;
  seek?: { positionMs: number; request: number };
  onCoverage?: (intervals: PlaybackInterval[]) => void;
}) {
  const api = useApi(),
    scope = useApiScope();
  const base = '/intel-api/public-hearings/' + encodeURIComponent(hearingId) + '/audio';
  const audio = useRef<HTMLAudioElement>(null),
    generation = useRef(0),
    active = useRef(true);
  const requested = useRef(0),
    playIntent = useRef(false),
    refreshed = useRef(false);
  const speed = useRef(1),
    handledSeek = useRef<number>();
  const opening = useRef(false);
  const [part, setPart] = useState<Part | null>(null),
    [position, setPosition] = useState(0);
  const [status, setStatus] = useState(''),
    [loading, setLoading] = useState(false);
  const manifest = useQuery({
    queryKey: ['intel', 'public-hearing-audio', scope, hearingId],
    queryFn: async () => (await api.get<{ epochs: Epoch[] }>(base)).data,
    retry: false,
    refetchInterval: 15_000,
  });
  const epochs = manifest.data?.epochs ?? [];
  const coverage = publicPlaybackCoverage(epochs);
  const usable = manifest.isError ? [] : epochs.filter((epoch) => coverage.some((range) => range.startMs === epoch.startMs && range.endMs === epoch.durableEndMs));
  useEffect(() => {
    onCoverage?.(manifest.isError ? [] : publicPlaybackCoverage(manifest.data?.epochs ?? []));
    return () => onCoverage?.([]);
  }, [manifest.data, manifest.isError, onCoverage]);
  const end = Math.max(0, ...epochs.map((epoch) => epoch.durableEndMs));
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);

  async function load(rawPositionMs: number, play: boolean, reissue = false) {
    opening.current = true;
    // Integer-millisecond boundary: the backend validates
    // Number.isSafeInteger(positionMs) and rejects fractional input (400
    // "Valid audio position required"). HTMLMediaElement.currentTime is a
    // fractional number of seconds, so a naive `currentTime * 1000` (e.g.
    // 344.33599999999996 ms) would otherwise be posted verbatim. Round once at
    // this single API entry point so every caller (seek slider, epoch buttons,
    // Play-from-position, ended-chaining, external seek) sends a valid integer.
    // Sub-millisecond rounding preserves accuracy and the range clamp below.
    const positionMs = Math.round(rawPositionMs);
    const epoch = usable.find(
      (item) => positionMs >= item.startMs && positionMs < item.durableEndMs,
    );
    audio.current?.pause();
    const token = ++generation.current;
    if (!epoch) {
      opening.current = false;
      setLoading(false);
      setPart(null);
      playIntent.current = false;
      setStatus('No saved audio covers this position. Select another recorded interval.');
      return;
    }
    setLoading(true);
    setStatus('');
    requested.current = positionMs;
    playIntent.current = play;
    if (!reissue) refreshed.current = false;
    try {
      const result = (
        await api.post<Part>(base + '/epochs/' + encodeURIComponent(epoch.id) + '/playback', {
          positionMs,
        })
      ).data;
      if (!active.current || token !== generation.current) return;
      setPart(result);
      setPosition(positionMs);
      if (audio.current && result.url === part?.url) {
        audio.current.currentTime = (positionMs - result.startMs) / 1000;
        if (play)
          void audio.current.play().catch(() => setStatus('Press Play to start saved audio.'));
      }
    } catch {
      if (active.current && token === generation.current) {
        setPart(null);
        setStatus('Saved audio is unavailable. Refresh access and try again.');
      }
    } finally {
      if (active.current && token === generation.current) {
        opening.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    if (seek && !manifest.isPending && handledSeek.current !== seek.request) {
      handledSeek.current = seek.request;
      void load(seek.positionMs, true);
    }
  }, [seek?.request, manifest.isPending]);

  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Saved unattended audio">
      <h2 className="lw-card__title">Saved unattended audio</h2>
      <p className="lw-card__meta">
        Audio saved by the shared server capture. Separate attempts and missing intervals remain
        visible.
      </p>
      {manifest.isError ? (
        <p role="status">Saved audio access is unavailable for this workspace or source.</p>
      ) : null}
      {manifest.isLoading ? <p role="status">Loading recording coverage…</p> : null}
      {!manifest.isLoading && !manifest.isError && !epochs.length ? (
        <p>No retained server audio is available for this event.</p>
      ) : null}
      {epochs.length ? (
        <ul>
          {epochs.map((epoch) => (
            <li key={epoch.id}>
              <button
                type="button"
                className="lw-backlink"
                disabled={epoch.state === 'expired' || !epoch.durableBytes || loading}
                onClick={() => void load(epoch.startMs, true)}
              >
                {clock(epoch.startMs)}–{clock(epoch.durableEndMs)}
              </button>
              {' · '}
              {epoch.state}
              {epoch.transcriptState === 'partial' ? ' · transcript incomplete' : ''}
              {epoch.reason ? ' · interrupted attempt' : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {usable.length ? (
        <>
          <label style={{ display: 'block' }}>
            Recording position · {clock(position)}
            <input
              style={{ width: '100%' }}
              aria-label="Seek saved server audio"
              type="range"
              min={0}
              max={end}
              step={1000}
              value={position}
              onChange={(event) => setPosition(Number(event.target.value))}
              onPointerUp={(event) => void load(Number(event.currentTarget.value), true)}
              onKeyUp={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
                  void load(Number(event.currentTarget.value), true);
              }}
            />
          </label>
          <button
            type="button"
            className="lw-backlink"
            disabled={loading}
            onClick={() => void load(position, true)}
          >
            Play from position
          </button>
          <label style={{ marginLeft: 12 }}>
            Speed{' '}
            <select
              aria-label="Server audio playback speed"
              defaultValue="1"
              onChange={(event) => {
                speed.current = Number(event.target.value);
                if (audio.current) audio.current.playbackRate = speed.current;
              }}
            >
              {[0.75, 1, 1.25, 1.5, 2].map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          </label>
          <audio
            ref={audio}
            controls
            preload="metadata"
            src={part?.url}
            style={{ width: '100%', marginTop: 12 }}
            onPlay={() => {
              playIntent.current = true;
            }}
            onPause={(event) => {
              if (!opening.current && !event.currentTarget.ended) playIntent.current = false;
            }}
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = speed.current;
              event.currentTarget.currentTime = Math.max(
                0,
                (requested.current - (part?.startMs ?? 0)) / 1000,
              );
              if (playIntent.current)
                void event.currentTarget
                  .play()
                  .catch(() => setStatus('Press Play to start saved audio.'));
            }}
            onTimeUpdate={(event) => {
              // Keep the position state in integer milliseconds: currentTime is
              // fractional seconds, and this value feeds both the slider and
              // Play-from-position, which must post an integer positionMs.
              if (part)
                setPosition(Math.round(part.startMs + event.currentTarget.currentTime * 1000));
            }}
            onEnded={() => {
              if (part) void load(part.endMs, true);
            }}
            onError={() => {
              if (part && !refreshed.current) {
                refreshed.current = true;
                void load(position, playIntent.current, true);
              } else if (part) {
                setStatus(
                  'Saved audio could not play after refreshing access. Try another recorded interval.',
                );
              }
            }}
          />
        </>
      ) : null}
      {loading ? <p role="status">Opening saved audio…</p> : null}
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
