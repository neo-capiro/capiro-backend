import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../lib/use-api.js';
import {
  recordingSeek,
  useHearingRecording,
  type RecordingEpoch,
} from '../../lib/hearing-recording-api.js';

function clock(ms: number) {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 3600)
    .toString()
    .padStart(2, '0')}:${Math.floor((sec / 60) % 60)
    .toString()
    .padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;
}

export function HearingRecordingPanel({
  sessionId,
  live,
  canEnable,
  evidenceTime,
}: {
  sessionId: string;
  live: boolean;
  canEnable: boolean;
  evidenceTime?: { ms: number; revision: number };
}) {
  const api = useApi(),
    { manifest, capability, enable, scope } = useHearingRecording(sessionId, live);
  const [error, setError] = useState<string | null>(null),
    [playback, setPlayback] = useState<{
      url: string;
      epoch: RecordingEpoch;
      offset: number;
    } | null>(null);
  const audio = useRef<HTMLAudioElement>(null),
    generation = useRef(0);
  const recording = manifest.data?.recording;
  useEffect(() => {
    generation.current++;
    setPlayback(null);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [scope, sessionId]);
  async function play(epoch: RecordingEpoch, offset = 0) {
    const request = ++generation.current;
    try {
      const result = await api.post<{ url: string }>(
        `/intel-api/hearings/${encodeURIComponent(sessionId)}/recording/epochs/${encodeURIComponent(epoch.id)}/playback`,
        {},
      );
      if (request !== generation.current) return;
      setPlayback({ url: result.data.url, epoch, offset });
      setError(null);
    } catch {
      if (request === generation.current)
        setError('Saved audio is unavailable or your access has changed.');
    }
  }
  useEffect(() => {
    if (!evidenceTime) return;
    const epoch = recordingSeek(recording?.epochs ?? [], evidenceTime.ms);
    if (!epoch) {
      setError('No saved audio covers this moment. The transcript remains available.');
      return;
    }
    void play(epoch, (evidenceTime.ms - epoch.startMs) / 1000);
  }, [evidenceTime?.revision]);
  return (
    <section
      className="lw-panel"
      aria-label="Saved hearing audio"
      style={{ marginTop: 16, padding: 16 }}
    >
      <h2 className="lw-panel__title">Recording &amp; saved audio</h2>
      {manifest.isError ? (
        <p role="alert">Recording status could not be loaded.</p>
      ) : recording ? (
        <>
          <p>
            Audio: {recording.state} · Transcript: {recording.transcriptState} · Analysis:{' '}
            {recording.analysisState}
          </p>
          <p>
            Saved{' '}
            {(
              recording.epochs.reduce((sum, epoch) => sum + epoch.durableBytes, 0) / 1048576
            ).toFixed(2)}{' '}
            MB · Retained until {new Date(recording.expiresAt).toLocaleString()}
          </p>
          <ol aria-label="Recording coverage">
            {recording.epochs.map((epoch, index) => (
              <li key={epoch.id}>
                {index > 0 && epoch.startMs > recording.epochs[index - 1]!.durableEndMs && (
                  <p>
                    Gap: {clock(recording.epochs[index - 1]!.durableEndMs)}–{clock(epoch.startMs)}
                  </p>
                )}
                {clock(epoch.startMs)}–{clock(epoch.durableEndMs)} ·{' '}
                {epoch.complete ? 'Final audio saved' : 'Partial recording'}
                {epoch.playable && (
                  <button className="lw-btn" onClick={() => void play(epoch)}>
                    Play saved audio
                  </button>
                )}
                {!epoch.playable && <span> · {epoch.state}</span>}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <p>
            {manifest.data?.recordingPolicy === 'no_storage'
              ? 'No audio, transcript or recap is retained.'
              : 'This session has no saved audio.'}
          </p>
          {canEnable &&
            capability.data?.available &&
            manifest.data?.recordingPolicy !== 'audio_and_transcript' && (
              <>
                <p>
                  Retain permitted audio for {capability.data.retentionDays} days. Saved audio
                  survives browser closure; future capture requires this browser and device to stay
                  active.
                </p>
                <button
                  className="lw-btn lw-btn--primary"
                  disabled={enable.isPending}
                  onClick={() => enable.mutate()}
                >
                  Enable saved audio
                </button>
              </>
            )}
          {manifest.data?.recordingPolicy === 'audio_and_transcript' && (
            <p>Audio retention is selected. Start capture to save audio.</p>
          )}
          {!capability.data?.available && <p>{capability.data?.reason}</p>}
        </>
      )}
      {enable.isError && (
        <p role="alert">Audio retention could not be enabled. Refresh to check permissions.</p>
      )}
      {playback && (
        <>
          <audio
            ref={audio}
            src={playback.url}
            controls
            preload="metadata"
            aria-label="Retained hearing audio"
            onLoadedMetadata={() => {
              if (audio.current) {
                audio.current.currentTime = playback.offset;
                void audio.current.play().catch(() => undefined);
              }
            }}
            onError={() =>
              setError('Playback access may have expired. Refresh playback to continue.')
            }
          />
          <label>
            Playback speed{' '}
            <select
              defaultValue="1"
              onChange={(event) => {
                if (audio.current) audio.current.playbackRate = Number(event.target.value);
              }}
            >
              <option value="0.75">0.75×</option>
              <option value="1">1×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
          </label>
          <button
            className="lw-btn"
            onClick={() => void play(playback.epoch, audio.current?.currentTime ?? playback.offset)}
          >
            Refresh playback
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
