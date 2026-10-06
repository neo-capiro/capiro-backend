import { useEffect, useRef, useState } from 'react';
import type { PlaybackInterval } from '../../lib/hearing-playback-coverage.js';
import { useApi } from '../../lib/use-api.js';
import {
  recordingSeek,
  recordingLoadError,
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
  onProgress,
  onCoverage,
}: {
  sessionId: string;
  live: boolean;
  canEnable: boolean;
  evidenceTime?: { ms: number; revision: number };
  onCoverage?: (intervals: PlaybackInterval[]) => void;
  onProgress?: (progress: { endMs: number; bytes: number } | null) => void;
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
    generation = useRef(0),
    handledEvidence = useRef<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [seekRetry, setSeekRetry] = useState(0);
  const recording = manifest.data?.recording;
  const expired =
    recording?.state === 'expired' ||
    recording?.playbackAvailability === 'expired' ||
    Boolean(recording && new Date(recording.expiresAt).getTime() <= Date.now());
  const permissionUnavailable = recording?.playbackAvailability === 'permission_unavailable';
  const playbackUnavailable = expired
    ? 'Saved audio retention has expired.'
    : permissionUnavailable
      ? 'Saved audio playback is unavailable because source permission has expired or changed. Ask a tenant administrator to review the source permission.'
      : null;
  useEffect(() => {
    onCoverage?.(!manifest.isError && !playbackUnavailable && recording?.playbackAvailability === 'available'
      ? recording.epochs.filter((epoch) => epoch.playable && epoch.durableBytes > 0 && epoch.decodedDurationMs != null)
        .map((epoch) => ({ startMs: epoch.startMs, endMs: Math.min(epoch.durableEndMs, epoch.startMs + epoch.decodedDurationMs!) }))
        .filter((range) => range.endMs > range.startMs)
      : []);
    return () => onCoverage?.([]);
  }, [recording, manifest.isError, playbackUnavailable, onCoverage]);
  useEffect(() => {
    onProgress?.(
      recording && !manifest.isError
        ? {
            endMs: Math.max(0, ...recording.epochs.map((epoch) => epoch.durableEndMs)),
            bytes: recording.epochs.reduce((sum, epoch) => sum + epoch.durableBytes, 0),
          }
        : null,
    );
  }, [recording, manifest.isError, onProgress]);
  useEffect(() => {
    generation.current++;
    audio.current?.pause();
    setPlayback(null);
    setError(null);
    setSpeed(1);
    handledEvidence.current = null;
    return () => {
      generation.current++;
    };
  }, [scope, sessionId]);
  useEffect(() => {
    if (!manifest.isError && !playbackUnavailable) return;
    generation.current++;
    audio.current?.pause();
    setPlayback(null);
    setError(null);
  }, [manifest.isError, playbackUnavailable]);
  async function refreshStatus() {
    const previousEvidence = handledEvidence.current;
    setError(null);
    await Promise.all([manifest.refetch(), capability.refetch()]);
    // A previously unresolved seek resumes automatically when data arrives.
    // Only retry a request already handled before this refresh; do not replay
    // a newer request (or issue two URLs when a failed initial read recovers).
    if (previousEvidence && handledEvidence.current === previousEvidence) {
      handledEvidence.current = null;
      setSeekRetry((value) => value + 1);
    }
  }
  async function play(epoch: RecordingEpoch, offset = 0) {
    const request = ++generation.current;
    audio.current?.pause();
    try {
      const result = await api.post<{ url: string }>(
        `/intel-api/hearings/${encodeURIComponent(sessionId)}/recording/epochs/${encodeURIComponent(epoch.id)}/playback`,
        {},
      );
      if (request !== generation.current) return;
      setPlayback({ url: result.data.url, epoch, offset });
      if (audio.current && result.data.url === playback?.url) {
        audio.current.currentTime = offset;
        audio.current.playbackRate = speed;
        void audio.current.play().catch(() => undefined);
      }
      setError(null);
    } catch {
      if (request === generation.current) {
        setPlayback(null);
        setError('Saved audio is unavailable or your access has changed.');
        // Refresh the manifest so a revoked permission or expired retention
        // replaces stale play controls with the current authorized state.
        void manifest.refetch();
      }
    }
  }
  useEffect(() => {
    // A missing/failed manifest says nothing about whether audio was saved.
    // Wait for a successful read, including when a seek preceded that read.
    if (!evidenceTime || !manifest.isSuccess || manifest.isError || playbackUnavailable) return;
    const requestKey = `${scope}:${sessionId}:${evidenceTime.revision}:${evidenceTime.ms}`;
    if (handledEvidence.current === requestKey) return;
    handledEvidence.current = requestKey;
    const epoch = recordingSeek(recording?.epochs ?? [], evidenceTime.ms);
    if (!epoch) {
      generation.current++;
      audio.current?.pause();
      setPlayback(null);
      const covered = recording?.epochs.find(
        (item) => evidenceTime.ms >= item.startMs && evidenceTime.ms < item.durableEndMs,
      );
      setError(
        covered
          ? ['recording', 'queued', 'processing'].includes(covered.state)
            ? 'Audio for this moment is still being saved or prepared. Refresh recording status to try again.'
            : 'Audio for this moment is not playable. Review the recording coverage and refresh its status.'
          : 'No saved audio covers this moment. The transcript remains available.',
      );
      return;
    }
    void play(epoch, (evidenceTime.ms - epoch.startMs) / 1000);
  }, [
    evidenceTime?.revision,
    evidenceTime?.ms,
    manifest.isSuccess,
    manifest.isError,
    recording,
    playbackUnavailable,
    scope,
    sessionId,
    seekRetry,
  ]);
  return (
    <section
      className="lw-panel"
      aria-label="Saved hearing audio"
      style={{ marginTop: 16, padding: 16 }}
    >
      <h2 className="lw-panel__title">Recording &amp; saved audio</h2>
      {manifest.isError ? (
        <p role="alert">{recordingLoadError(manifest.error)}</p>
      ) : manifest.isPending ? (
        <p role="status">Loading recording status…</p>
      ) : recording ? (
        <>
          {playbackUnavailable && <p role="status">{playbackUnavailable}</p>}
          <p>
            Audio: {recording.state} · Transcript: {recording.transcriptState} · Analysis:{' '}
            {recording.analysisState}
          </p>
          <p>
            Saved{' '}
            {(
              recording.epochs.reduce((sum, epoch) => sum + epoch.durableBytes, 0) / 1048576
            ).toFixed(2)}{' '}
            MB · {expired ? 'Retention ended' : 'Retained until'}{' '}
            {new Date(recording.expiresAt).toLocaleString()}
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
                {epoch.playable && !playbackUnavailable && (
                  <button className="lw-btn" onClick={() => void play(epoch)}>
                    Play saved audio
                  </button>
                )}
                {(!epoch.playable || playbackUnavailable) && (
                  <span> · {expired ? 'expired' : epoch.state}</span>
                )}
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
      <button
        className="lw-btn"
        disabled={manifest.isFetching}
        onClick={() => void refreshStatus()}
      >
        {manifest.isError ? 'Retry recording status' : 'Refresh recording status'}
      </button>
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
                audio.current.playbackRate = speed;
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
              value={speed}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSpeed(next);
                if (audio.current) audio.current.playbackRate = next;
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
