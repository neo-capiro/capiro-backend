import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { HearingRoomViewModel } from './LiveHearingRoomController.js';
import type { HearingTranscriptItem } from '../../../../lib/hearing-watch-api.js';
import { LwButton, LwPill } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable } from '../states/SystemStates.js';
import '../legiwatch.css';

function clock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function StatusPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="lw-status__pair">
      <span className="lw-status__label">{label}</span>
      <span className="lw-status__value">{value}</span>
    </div>
  );
}

const cardLabels: Record<string, string> = {
  watchlist_match: 'Client match',
  bill_mention: 'Bill mention',
  client_mention: 'Client mention',
  opposition: 'Opposition',
  potential_ask: 'Potential ask',
};

/** No transport lives here: filtering, playback and layout cannot restart capture. */
export function HearingRoomVNextView({ room }: { room: HearingRoomViewModel }) {
  const [now, setNow] = useState(Date.now);
  const [query, setQuery] = useState('');
  const [speaker, setSpeaker] = useState('');
  const [matchedOnly, setMatchedOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jumpRevision, setJumpRevision] = useState(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const pendingJump = useRef<string | null>(null);
  const session = room.session;
  useEffect(() => {
    if (!room.captureActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [room.captureActive]);

  // Matching comes from real intelligence cards, never invented transcript flags.
  // A moment belongs to the segment it STARTS in: intervals are half-open
  // [startMs, endMs), so a moment exactly at a shared boundary lands on the
  // segment that begins there, never on the prior segment that ends there.
  const matchTimes = useMemo(
    () =>
      room.cards
        .filter((card) => card.cardType === 'watchlist_match' || card.cardType === 'client_mention')
        .flatMap((card) => (card.startMs == null ? [] : [card.startMs])),
    [room.cards],
  );
  const matchesTime = (segment: HearingTranscriptItem, time: number) =>
    time >= segment.startMs && time < segment.endMs;
  const matches = (segment: HearingTranscriptItem) =>
    matchTimes.some((time) => matchesTime(segment, time));
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return room.segments.filter(
      (segment) =>
        (!search || segment.text.toLowerCase().includes(search)) &&
        (!speaker || (segment.resolvedSpeakerName ?? segment.speakerLabel) === speaker) &&
        (!matchedOnly || matchTimes.some((time) => matchesTime(segment, time))),
    );
  }, [room.segments, query, speaker, matchedOnly, matchTimes]);
  const speakers = useMemo(
    () => [
      ...new Set(
        room.segments
          .map((segment) => segment.resolvedSpeakerName ?? segment.speakerLabel)
          .filter((name): name is string => Boolean(name)),
      ),
    ],
    [room.segments],
  );
  const virtualized = filtered.length > 200;
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => transcriptRef.current,
    getItemKey: (index) => filtered[index]!.id,
    estimateSize: () => 110,
    overscan: 8,
    enabled: virtualized,
  });
  useEffect(() => {
    const target = pendingJump.current;
    if (target) {
      const index = filtered.findIndex((segment) => segment.id === target);
      if (index >= 0) {
        if (virtualized) virtualizer.scrollToIndex(index, { align: 'start' });
        else
          transcriptRef.current
            ?.querySelectorAll('[data-segment-id]')
            [index]?.scrollIntoView({ block: 'nearest' });
        pendingJump.current = null;
      }
    } else if (follow) {
      if (virtualized && filtered.length)
        virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' });
      else if (transcriptRef.current)
        transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [filtered, room.interim, follow, selectedId, jumpRevision, virtualized, virtualizer]);

  // Resolve a cited moment to its transcript segment with correct interval
  // semantics. Prefer the finding's own cited segment id when the card carries
  // it (the authoritative mapping). Otherwise treat a timestamp as belonging
  // to the segment it STARTS in: an exact segment start wins (this is what
  // fixes a moment at a shared boundary selecting the prior segment), then the
  // segment whose half-open interval [startMs, endMs) contains it, then the
  // nearest segment that starts after it, then the final segment. No selection
  // when the transcript is empty.
  const jumpToMoment = (startMs: number, segmentId?: string) => {
    const byId = segmentId ? room.segments.find((item) => item.id === segmentId) : undefined;
    const segment =
      byId ??
      room.segments.find((item) => item.startMs === startMs) ??
      room.segments.find((item) => item.startMs <= startMs && startMs < item.endMs) ??
      room.segments.find((item) => item.startMs > startMs) ??
      room.segments.at(-1);
    if (!segment) return;
    setQuery('');
    setSpeaker('');
    setMatchedOnly(false);
    setFollow(false);
    pendingJump.current = segment.id;
    setSelectedId(segment.id);
    setJumpRevision((revision) => revision + 1);
  };
  const jumpToLive = () => {
    pendingJump.current = null;
    setQuery('');
    setSpeaker('');
    setMatchedOnly(false);
    setSelectedId(null);
    setFollow(true);
  };
  const renderSegment = (segment: HearingTranscriptItem) => (
    <div
      data-segment-id={segment.id}
      className={`lw-tseg${matches(segment) ? ' is-match' : ''}${selectedId === segment.id ? ' is-selected' : ''}`}
    >
      <span className="lw-tseg__tc">{clock(segment.startMs)}</span>
      <div className="lw-room__segment-body">
        <div className="lw-room__row">
          <span className="lw-tseg__sp">
            {segment.resolvedSpeakerName ?? segment.speakerLabel ?? 'Speaker'}
          </span>
          {matches(segment) && (
            <LwPill tone="brand" size="22">
              MATCH
            </LwPill>
          )}
          <LwPill tone="gray" size="22">
            FINAL
          </LwPill>
          {room.recordingPanel && room.playEvidence && (
            <button className="lw-btn" onClick={() => room.playEvidence?.(segment.startMs)}>
              Play audio here
            </button>
          )}
        </div>
        <div className="lw-tseg__text">{segment.text}</div>
      </div>
    </div>
  );

  if (room.loading)
    return (
      <div className="lw">
        <div className="lw-liveroom">
          <LwStateLoading rows={6} />
        </div>
      </div>
    );
  if (room.unavailable || !session)
    return (
      <div className="lw">
        <div className="lw-liveroom">
          <LwButton onClick={room.goBack}>Back to Hearings</LwButton>
          <LwStateUnavailable
            source="Live session"
            reason="This hearing session could not be loaded."
            onRetry={room.retry}
          />
        </div>
      </div>
    );

  const recoverable = Boolean(room.error) || session.status === 'failed-recoverable';
  const openSourceUrl = room.openSourceUrl ?? session.sourceUrl ?? null;
  // A session with a canonical public capture is a REVIEW of that capture: the
  // browser share-tab capture flow was never its source and cannot resume it.
  const isPublicReview = Boolean(session.publicCaptureId && session.hearingId);
  const publicDetailPath = session.hearingId
    ? `/legiwatch/hearings/${encodeURIComponent(session.hearingId)}`
    : null;
  // Return-to-detail: rooms tied to a canonical hearing link back to it.
  const detailPath = room.detailPath ?? publicDetailPath;
  const phaseLabel =
    room.phase === 'capturing'
      ? room.transcriptionDelayed
        ? 'RECORDING · TRANSCRIPT DELAYED'
        : 'TRANSCRIBING'
      : room.phase === 'stopping'
        ? 'SAVING'
        : recoverable
          ? 'RECOVERABLE'
          : room.sessionEnded
            ? 'ENDED'
            : room.phase === 'idle'
              ? 'NOT CONNECTED'
              : room.phase.replaceAll('_', ' ').toUpperCase();
  const elapsed =
    room.captureActive && room.captureStartedAt != null
      ? now - room.captureStartedAt + (room.captureOffsetMs ?? 0)
      : room.capturedElapsedMs ||
        (room.captureActive && session.startedAt
          ? now - new Date(session.startedAt).getTime()
          : (room.segments.at(-1)?.endMs ?? 0));
  const canConnect = ['idle', 'ended', 'connecting'].includes(room.phase);
  const canSave = room.segments.length > 0 && !room.captureActive;
  const hasFilters = Boolean(query || speaker || matchedOnly);

  return (
    <div className="lw">
      <div className="lw-liveroom">
        <div className="lw-liveroom__bar">
          <button
            type="button"
            className="lw-navbtn"
            aria-label="Back to Hearings"
            onClick={room.goBack}
          >
            ‹
          </button>
          <div className="lw-room__heading">
            <h1>{session.title}</h1>
            <span className="lw-mono">
              {clock(elapsed)} · {room.cards.length} intelligence moments
            </span>
          </div>
          <span className="lw-room__spacer" />
          {detailPath ? (
            <a className="lw-btn" href={detailPath}>
              Hearing details
            </a>
          ) : null}
          {room.captureActive && (
            <LwButton onClick={room.endSession} disabled={room.phase === 'stopping'}>
              {room.phase === 'stopping' ? 'Saving session…' : 'End session'}
            </LwButton>
          )}
        </div>

        {room.error && (
          <div className="lw-room__notice" role="alert">
            {room.error}
            <LwButton onClick={room.dismissError}>Dismiss</LwButton>
          </div>
        )}
        {session.status === 'failed-recoverable' && (
          <div className="lw-room__notice" role="alert">
            The session was interrupted. Saved testimony remains available. Reconnect and share the
            hearing tab to resume.
            <LwButton onClick={room.retry}>Refresh session</LwButton>
          </div>
        )}

        <div className="lw-live">
          <section className="lw-video lw-room__video" aria-label="Hearing video">
            <div className="lw-video__body">
              {room.sourcePlayer ?? (
                <div className="lw-room__video-empty">
                  <div className="lw-video__mark" aria-hidden="true">
                    ▶
                  </div>
                  <p>
                    {openSourceUrl
                      ? 'Watch the hearing in its source tab.'
                      : 'No playback source is available for this session.'}
                  </p>
                  {openSourceUrl && (
                    <a className="lw-btn" href={openSourceUrl} target="_blank" rel="noreferrer">
                      Open hearing source ↗
                    </a>
                  )}
                </div>
              )}
            </div>
            <div className="lw-video__bar">
              <span className="lw-video__clock">{clock(elapsed)}</span>
              <span className="lw-room__playback-note">
                Playback controls belong to the player.{' '}
                {isPublicReview
                  ? 'Transcription comes from the shared public capture.'
                  : 'Transcription uses the shared tab’s audio.'}
              </span>
            </div>
          </section>

          <div className="lw-live__left">
            <div className="lw-status lw-status--card" aria-label="Hearing health">
              <h2 className="lw-status__heading">Capture health</h2>
              <StatusPair label="Source" value={session.sourceType ?? 'Unavailable'} />
              <StatusPair
                label="Audio"
                value={
                  room.phase === 'capturing'
                    ? 'SHARING TAB AUDIO'
                    : isPublicReview
                      ? session.audioSource
                        ? session.audioSource.replaceAll('_', ' ').toUpperCase()
                        : 'PUBLIC CAPTURE'
                      : 'BROWSER TAB'
                }
              />
              <StatusPair
                label="Transcript"
                value={
                  room.transcriptError
                    ? 'REFRESH FAILED'
                    : room.transcriptionDelayed
                      ? 'INTERRUPTED'
                      : room.phase === 'capturing'
                        ? 'STREAMING'
                        : `${room.segments.length} SAVED SEGMENTS`
                }
              />
              <StatusPair
                label="Capture"
                value={
                  room.phase === 'capturing'
                    ? 'RECORDING'
                    : room.phase === 'stopping'
                      ? 'SAVING'
                      : 'STOPPED'
                }
              />
              <StatusPair
                label="Last final"
                value={
                  room.lastTranscriptAt
                    ? `${Math.max(0, Math.floor((now - room.lastTranscriptAt) / 1000))}s ago`
                    : '—'
                }
              />
              <LwPill
                tone={recoverable ? 'warning' : room.phase === 'capturing' ? 'error' : 'gray'}
                pulse={room.phase === 'capturing'}
              >
                {phaseLabel}
              </LwPill>
            </div>

            <section className="lw-panel lw-live__source" aria-labelledby="room-source-title">
              <div className="lw-panel__head">
                <h2 className="lw-panel__title" id="room-source-title">
                  Source &amp; capture
                </h2>
              </div>
              <div className="lw-room__panel-body">
                <LwPill tone="brand" size="26">
                  {session.sourceType ?? 'Hearing'}
                </LwPill>
                {isPublicReview ? (
                  <div className="lw-block">
                    <div className="lw-block__label">Public capture</div>
                    <p className="lw-room__copy">
                      This session reviews the shared server capture of the public hearing source.
                      The saved audio and canonical transcript below come from that capture, not
                      from this browser.
                    </p>
                    {publicDetailPath && (
                      <a className="lw-room__link" href={publicDetailPath}>
                        Open saved public audio ↗
                      </a>
                    )}
                  </div>
                ) : (
                  <div className="lw-block">
                    <div className="lw-block__label">Browser recording</div>
                    <p className="lw-room__copy">
                      Connect, play the hearing, then start transcription. Choose the playing tab and
                      enable Share tab audio in Chrome or Edge.
                    </p>
                    <div className="lw-room__row">
                      {canConnect && (
                        <LwButton
                          variant="primary"
                          onClick={room.connect}
                          disabled={room.phase === 'connecting'}
                        >
                          {room.phase === 'connecting'
                            ? 'Connecting…'
                            : room.sessionEnded
                              ? 'Connect to resume'
                              : 'Connect'}
                        </LwButton>
                      )}
                      {room.phase === 'connected' && (
                        <LwButton onClick={room.disconnect}>Disconnect</LwButton>
                      )}
                      <LwButton
                        variant="primary"
                        onClick={room.startCapture}
                        disabled={room.phase !== 'connected'}
                      >
                        Start transcription
                      </LwButton>
                      {room.captureActive && (
                        <LwButton onClick={room.endSession} disabled={room.phase === 'stopping'}>
                          Stop capture
                        </LwButton>
                      )}
                    </div>
                  </div>
                )}
                {session.consentStatus === 'needs_review' && (
                  <div className="lw-block">
                    <p className="lw-room__copy">Recording consent needs review.</p>
                    <LwButton onClick={room.confirmConsent} disabled={room.confirmingConsent}>
                      Confirm consent
                    </LwButton>
                  </div>
                )}
                {openSourceUrl && (
                  <a
                    className="lw-room__link"
                    href={openSourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open hearing source ↗
                  </a>
                )}
                {room.statusText && (
                  <p className="lw-room__copy" role="status">
                    {room.statusText}
                  </p>
                )}
                {!isPublicReview && (
                  <p className="lw-room__meta">
                    Sent {(room.bytesSent / 1024 / 1024).toFixed(2)} MB
                    {room.bytesSaved != null && (
                      <> · Saved {(room.bytesSaved / 1024 / 1024).toFixed(2)} MB</>
                    )}
                  </p>
                )}
                {!isPublicReview && (
                  <div className="lw-block">
                    <div className="lw-block__label">Keep recording</div>
                    {room.captureActive && (
                      <p className="lw-room__copy">
                        {room.wakeLock === 'active'
                          ? 'Screen wake lock active.'
                          : 'Keep this device awake while sharing audio.'}
                      </p>
                    )}
                    <p className="lw-room__copy">
                      Browser transcription needs this tab and device to stay open. Scheduled Capiro
                      attendance runs on the server.
                    </p>
                  </div>
                )}
              </div>
            </section>

            {room.serverAttendance ? (
              <section className="lw-panel" aria-label="Server attendance">
                <div className="lw-panel__head">
                  <h2 className="lw-panel__title">Server capture</h2>
                </div>
                <div className="lw-room__panel-body">
                  {room.serverAttendance.scheduled ? (
                    <div className="lw-block">
                      <LwPill
                        tone={room.serverAttendance.lifecycle === 'failed' ? 'gray' : 'brand'}
                        size="26"
                      >
                        {room.serverAttendance.lifecycle === 'capturing'
                          ? 'SERVER CAPTURING'
                          : room.serverAttendance.lifecycle === 'processing'
                            ? 'SERVER PROCESSING'
                            : room.serverAttendance.lifecycle === 'complete'
                              ? 'SERVER CAPTURE READY'
                              : room.serverAttendance.lifecycle === 'failed'
                                ? 'SERVER CAPTURE FAILED'
                                : 'SERVER SCHEDULED'}
                      </LwPill>
                      <p className="lw-room__copy">
                        {room.serverAttendance.message ??
                          (room.serverAttendance.lifecycle === 'capturing'
                            ? 'Capiro is actively capturing the official stream on the server. This is independent of your browser room — your private capture here is unaffected.'
                            : room.serverAttendance.lifecycle === 'processing'
                              ? 'Capiro is processing the captured stream on the server. Your browser capture here is unaffected.'
                              : room.serverAttendance.lifecycle === 'complete'
                                ? 'The server capture is complete and its transcript is ready. Your browser capture here is unaffected.'
                                : room.serverAttendance.lifecycle === 'failed'
                                  ? 'The server capture failed and is not retryable right now. This browser room remains available as a fallback.'
                                  : 'Server capture is scheduled but not yet capturing. This is independent of your browser room — your private capture here is unaffected.')}
                      </p>
                      {!room.serverAttendance.callerScheduled && room.serverAttendance.available ? (
                        <LwButton
                          variant="primary"
                          onClick={room.serverAttendance.onSchedule}
                          disabled={room.serverAttendance.pending}
                        >
                          {room.serverAttendance.pending
                            ? 'Scheduling…'
                            : 'Attend via server too'}
                        </LwButton>
                      ) : null}
                    </div>
                  ) : room.serverAttendance.available ? (
                    <div className="lw-block">
                      <p className="lw-room__copy">
                        Have Capiro capture the official stream on the server too. It keeps running
                        when you close this room and does not interrupt your browser capture.
                      </p>
                      <LwButton
                        variant="primary"
                        onClick={room.serverAttendance.onSchedule}
                        disabled={room.serverAttendance.pending}
                      >
                        {room.serverAttendance.pending
                          ? 'Scheduling…'
                          : 'Schedule server capture'}
                      </LwButton>
                    </div>
                  ) : (
                    <p className="lw-room__meta">
                      {room.serverAttendance.message ??
                        'Server capture is not available for this proceeding.'}
                    </p>
                  )}
                  {room.serverAttendance.confirm ? (
                    <p role="status" className="lw-room__copy">
                      {room.serverAttendance.confirm}
                    </p>
                  ) : null}
                  {room.serverAttendance.error ? (
                    <p role="alert" className="lw-room__copy" style={{ color: 'var(--lw-danger, #b42318)' }}>
                      {room.serverAttendance.error}
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}

            {room.sourceResolution ? (
              <section className="lw-panel" aria-label="Official source">
                <div className="lw-panel__head">
                  <h2 className="lw-panel__title">Official source</h2>
                </div>
                <div className="lw-room__panel-body">
                  {room.sourceResolution.status === 'resolving' ? (
                    <p role="status" className="lw-room__copy">
                      Locating the official playable source…
                    </p>
                  ) : (
                    <>
                      {room.sourceResolution.note ? (
                        <p role="status" className="lw-room__copy">
                          {room.sourceResolution.note}
                        </p>
                      ) : null}
                      {room.sourceResolution.candidates?.length ? (
                        <div className="lw-block">
                          {room.sourceResolution.candidates.map((c) => (
                            <button
                              key={c.pageUrl}
                              type="button"
                              className="lw-btn"
                              onClick={() => room.sourceResolution!.onSelectCandidate(c.pageUrl)}
                            >
                              {c.title}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <div className="lw-room__row">
                        {room.sourceResolution.referenceUrl ? (
                          <a
                            className="lw-room__link"
                            href={room.sourceResolution.referenceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open official source ↗
                          </a>
                        ) : null}
                        <LwButton onClick={room.sourceResolution.onRetry}>Retry</LwButton>
                      </div>
                    </>
                  )}
                </div>
              </section>
            ) : null}
          </div>

          <section
            className="lw-panel lw-live__transcript lw-room__transcript"
            aria-labelledby="room-transcript-title"
          >
            <div className="lw-panel__head lw-room__transcript-head">
              <h2 className="lw-panel__title" id="room-transcript-title">
                Live transcript
              </h2>
              <span className="lw-card__meta">{room.segments.length} final</span>
              <div className="lw-search">
                <input
                  aria-label="Search transcript"
                  placeholder="Search testimony"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setFollow(false);
                  }}
                />
              </div>
              <select
                aria-label="Speaker"
                className="lw-btn"
                value={speaker}
                onChange={(event) => {
                  setSpeaker(event.target.value);
                  setFollow(false);
                }}
              >
                <option value="">All speakers</option>
                {speakers.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              <button
                type="button"
                className={`lw-btn${matchedOnly ? ' lw-btn--primary' : ''}`}
                aria-pressed={matchedOnly}
                onClick={() => {
                  setMatchedOnly(!matchedOnly);
                  setFollow(false);
                }}
              >
                Matched only
              </button>
            </div>
            {room.transcriptError && (
              <div className="lw-room__notice" role="alert">
                Saved transcript could not be refreshed.
                <LwButton onClick={room.retry}>Retry transcript</LwButton>
              </div>
            )}
            {(!follow || hasFilters) && (
              <div className="lw-room__follow">
                <span>Auto-follow paused</span>
                <LwButton onClick={jumpToLive}>Jump to live</LwButton>
              </div>
            )}
            <div
              ref={transcriptRef}
              className="lw-room__transcript-scroll"
              aria-label="Transcript segments"
              onWheel={() => setFollow(false)}
              onTouchMove={() => setFollow(false)}
              onScroll={(event) => {
                const element = event.currentTarget;
                if (element.scrollHeight - element.scrollTop - element.clientHeight > 80)
                  setFollow(false);
              }}
            >
              {room.transcriptLoading && !room.segments.length ? (
                <LwStateLoading />
              ) : !filtered.length ? (
                <p className="lw-room__empty">
                  {hasFilters
                    ? 'No transcript segments match these filters.'
                    : session.publicCaptureId
                      ? 'No canonical transcript segments are saved for this hearing yet.'
                      : 'No transcript yet. Connect, play the hearing, and start transcription.'}
                </p>
              ) : virtualized ? (
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((item) => (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      {renderSegment(filtered[item.index]!)}
                    </div>
                  ))}
                </div>
              ) : (
                filtered.map((segment) => <div key={segment.id}>{renderSegment(segment)}</div>)
              )}
              {room.interim && !hasFilters && (
                <div className="lw-tseg lw-tseg__interim">
                  <span className="lw-tseg__tc">LIVE</span>
                  <div className="lw-tseg__text">{room.interim}</div>
                </div>
              )}
            </div>
          </section>

          <section className="lw-panel lw-live__intel" aria-labelledby="room-intel-title">
            <div className="lw-panel__head">
              <h2 className="lw-panel__title" id="room-intel-title">
                Intelligence
              </h2>
              <span className="lw-card__meta">{room.cards.length} moments</span>
            </div>
            {room.intelligenceError && (
              <div className="lw-room__notice" role="alert">
                Saved intelligence could not be refreshed.
                <LwButton onClick={room.retry}>Retry intelligence</LwButton>
              </div>
            )}
            <div className="lw-room__intel-scroll">
              <div className="lw-history__label lw-room__intel-label">Moments</div>
              {!room.cards.length ? (
                <p className="lw-room__empty">
                  {room.intelligenceProcessing
                    ? 'Public intelligence is still being extracted from the canonical transcript.'
                    : 'Relevant moments will appear here as the hearing is transcribed.'}
                </p>
              ) : (
                room.cards.map((card) => (
                  <article key={card.id} className="lw-room__moment">
                    <div className="lw-room__row">
                      <LwPill
                        tone={card.cardType === 'watchlist_match' ? 'brand' : 'gray'}
                        size="22"
                      >
                        {cardLabels[card.cardType] ?? card.cardType.replaceAll('_', ' ')}
                      </LwPill>
                      {card.startMs != null && (
                        <button
                          type="button"
                          className="lw-room__link"
                          disabled={!room.segments.length}
                          aria-label={`Jump to ${clock(card.startMs)}: ${card.title}`}
                          onClick={() => jumpToMoment(card.startMs!, card.segmentId)}
                        >
                          {clock(card.startMs)}
                        </button>
                      )}
                    </div>
                    <h3 className="lw-room__moment-title">{card.title}</h3>
                    {card.body && <p className="lw-room__copy">{card.body}</p>}
                  </article>
                ))
              )}
            </div>
            <div className="lw-room__panel-body lw-room__intel-actions">
              <LwButton
                variant="primary"
                onClick={room.saveRecap}
                disabled={!canSave}
                title={
                  !canSave ? 'Stop capture after testimony is saved to create a recap.' : undefined
                }
              >
                Save recap
              </LwButton>
              <p className="lw-room__meta">
                Save the hearing recap to a client’s Documents for Meri.
              </p>
            </div>
          </section>
        </div>
        {room.recordingPanel}
        {room.publicationsPanel}
      </div>
    </div>
  );
}
