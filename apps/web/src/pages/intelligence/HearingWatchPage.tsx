import { useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Form, Input, List, Modal, Select, Spin, Tag, Typography } from 'antd';
import { AudioOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import '../radar/legiwatch.css';
import {
  isMediaUrl,
  useBrowseHearings,
  useCreateHearing,
  useHearingSessions,
  useResolveStream,
  useUpcomingHearings,
  type ResolveStreamResult,
  type UpcomingHearing,
} from '../../lib/hearing-watch-api.js';

const { Text } = Typography;

/** Compact inline icon set for the calm hearings surface (matches the prototype). */
function Ic({ n, size = 13 }: { n: string; size?: number }) {
  if (n === 'play') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M7 5l12 7-12 7z" />
      </svg>
    );
  }
  const paths: Record<string, string> = {
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.6-3.6',
    chevR: 'M9 6l6 6-6 6',
    audio: 'M12 3v12 M8 7a4 4 0 0 0 8 0 M5 19h14',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
    layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[n] ?? paths.chevR} />
    </svg>
  );
}

/** Render the upcoming-hearing date. scheduledAt is a date-only 'YYYY-MM-DD'
 *  string; parse the parts explicitly to avoid a UTC→local day shift. */
function formatHearingDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  if (Number.isNaN(d.getTime())) return v ?? '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function prettyType(type: string): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('markup')) return 'Markup';
  if (t.includes('hearing')) return 'Hearing';
  if (t.includes('meeting')) return 'Meeting';
  return type;
}

/** C-SPAN video-search query for a hearing (committee + title), for the one-click finder. */
function watchSearchQuery(r: UpcomingHearing): string {
  return [r.committee, r.title].filter(Boolean).join(' ').slice(0, 160);
}

/** Matches CreateSessionDto's `@MaxLength(300)` on `title` (intel-api). */
const HEARING_TITLE_MAX = 300;

/**
 * Preset title for the "Watch" prefill. Congress.gov titles are unbounded —
 * multi-nominee nomination hearings routinely produce a `committee — title`
 * string well past 300 chars, which the server DTO rejects with a bare 400
 * ("Request failed with status code 400", no indication why). Truncate here
 * so the common case (long real titles) never blocks session creation.
 */
function buildPresetTitle(r: UpcomingHearing): string {
  const full = `${r.committee} — ${r.title}`;
  return full.length > HEARING_TITLE_MAX ? `${full.slice(0, HEARING_TITLE_MAX - 1)}…` : full;
}

/** PRIVATE source types (P8/D11): these require a consent attestation; public
 *  hearing/markup do not. Kept in sync with intel-api's requiresConsent(). */
const PRIVATE_SOURCE_TYPES = new Set(['meeting', 'webinar', 'agency_session']);

type HearingSub = 'schedule' | 'sessions';

/**
 * Hearing Watch body — the calm LegiWatch schedule + watch history. Two views:
 * "All hearings" (an Upcoming|Archive segmented toggle over an editorial table,
 * Watch = the primary action) and "My Sessions" (the transcription history).
 * "Add hearing manually" opens the resolver modal as a fallback.
 *
 * The term-watchlist CRUD that used to live here (P4's "Watchlists" view) was
 * ABSORBED into the unified editor on the Radar Watchlist tab (TrackerConfigPanel,
 * P5). This panel is purely the hearing schedule/session surface.
 */
export function HearingWatchPanel() {
  const [sub, setSub] = useState<HearingSub>('schedule');
  const [manual, setManual] = useState<{
    presetTitle?: string;
    presetUrl?: string;
    presetSearch?: string;
    presetHearingId?: string;
  } | null>(null);

  const onWatch = (r: UpcomingHearing) =>
    setManual({
      presetTitle: buildPresetTitle(r),
      presetUrl: r.url ?? undefined,
      presetSearch: watchSearchQuery(r),
      presetHearingId: r.id,
    });

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="ctx-strip" style={{ margin: '0 0 2px' }}>
        <div className="subnav">
          <button className={sub === 'schedule' ? 'active' : ''} onClick={() => setSub('schedule')}>
            All hearings
          </button>
          <button className={sub === 'sessions' ? 'active' : ''} onClick={() => setSub('sessions')}>
            My Sessions
          </button>
        </div>
        <span className="grow" />
        <button className="link-btn" onClick={() => setManual({})}>
          Add hearing manually
        </button>
      </div>

      {sub === 'schedule' ? <ScheduleView onWatch={onWatch} /> : <SessionsView />}

      <NewHearingModal
        open={manual !== null}
        onClose={() => setManual(null)}
        presetTitle={manual?.presetTitle}
        presetUrl={manual?.presetUrl}
        presetSearchQuery={manual?.presetSearch}
        presetHearingId={manual?.presetHearingId}
      />
    </div>
  );
}

/** The schedule: Upcoming|Archive segmented toggle + search over an editorial table. */
function ScheduleView({ onWatch }: { onWatch: (r: UpcomingHearing) => void }) {
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const [q, setQ] = useState('');
  const upcoming = useUpcomingHearings();
  const archive = useBrowseHearings({
    scope: 'past',
    search: q.trim() || undefined,
    limit: 50,
    offset: 0,
  });

  const loading = when === 'upcoming' ? upcoming.isLoading : archive.isLoading;
  const rows: UpcomingHearing[] =
    when === 'upcoming'
      ? (upcoming.data ?? []).filter(
          (r) => !q.trim() || `${r.title} ${r.committee}`.toLowerCase().includes(q.toLowerCase()),
        )
      : archive.data?.items ?? [];
  const archiveTotal = archive.data?.total ?? 0;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="ctx-strip" style={{ margin: 0 }}>
        <div className="seg-toggle">
          <button className={when === 'upcoming' ? 'on' : ''} onClick={() => setWhen('upcoming')}>
            Upcoming
          </button>
          <button className={when === 'past' ? 'on' : ''} onClick={() => setWhen('past')}>
            Archive
          </button>
        </div>
        <span className="grow" />
        <div
          className="row"
          style={{
            border: '1px solid var(--border-1)',
            borderRadius: 'var(--r-sm)',
            padding: '6px 11px',
            background: 'var(--bg-surface)',
            minWidth: 240,
            gap: 8,
          }}
        >
          <Ic n="search" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search hearings…"
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, flex: 1 }}
          />
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="htable">
          <thead>
            <tr>
              <th style={{ width: 130 }}>Date</th>
              <th style={{ width: 210 }}>Committee</th>
              <th style={{ width: 74 }}>Type</th>
              <th>Title</th>
              <th style={{ width: 140 }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: 28 }}>
                  <Spin />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: 28 }}>
                  <span className="muted mini">
                    {when === 'upcoming'
                      ? 'No upcoming hearings scheduled right now (Congress may be in recess). Check the archive.'
                      : 'No hearings match your search.'}
                  </span>
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                // sync-hearings prefixes a non-scheduled meetingStatus into the
                // title (e.g. "[Postponed] …"). Postponed/cancelled meetings never
                // happened — there's nothing to watch, so render the status as a
                // chip instead of a dead-end Watch button (rescheduled ones still
                // occur, so those keep the action).
                const statusMatch = /^\[([^\]]+)\]\s*/.exec(r.title);
                const statusLabel = statusMatch?.[1] ?? null;
                const cleanTitle = statusMatch ? r.title.slice(statusMatch[0].length) : r.title;
                const noRecording = !!statusLabel && /postpon|cancel/i.test(statusLabel);
                return (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      {formatHearingDate(r.scheduledAt)}
                      {r.time ? <span className="muted"> · {r.time}</span> : null}
                    </td>
                    <td>{r.committee}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        {r.type ? (
                          <span className="chip muted" style={{ fontSize: 10.5 }}>
                            {prettyType(r.type)}
                          </span>
                        ) : null}
                        {statusLabel ? (
                          <span
                            className="chip"
                            style={{
                              fontSize: 10.5,
                              border: 'none',
                              background: 'var(--notable-soft)',
                              color: 'var(--notable)',
                              fontWeight: 600,
                            }}
                          >
                            {statusLabel}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td style={{ fontWeight: 500 }}>
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {cleanTitle}
                        </a>
                      ) : (
                        cleanTitle
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {noRecording ? (
                        <span className="mini muted" title={`${statusLabel} — nothing to watch`}>
                          No recording
                        </span>
                      ) : (
                        <button className="btn btn-accent sm" onClick={() => onWatch(r)}>
                          <Ic n="play" size={12} /> {when === 'past' ? 'Watch recording' : 'Watch live'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {when === 'past' && archiveTotal > rows.length && (
        <div className="muted mini" style={{ textAlign: 'center' }}>
          Showing {rows.length} of {archiveTotal.toLocaleString()} — refine your search to narrow.
        </div>
      )}
    </div>
  );
}

/** Watch history — every hearing session (transcribed / live). */
function SessionsView() {
  const navigate = useNavigate();
  const sessions = useHearingSessions();

  if (sessions.isLoading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  if (!sessions.data || sessions.data.length === 0) {
    return (
      <div className="guide">
        <div className="gico">
          <Ic n="audio" size={20} />
        </div>
        <h4>No sessions yet</h4>
        <p>
          Watch a hearing from the schedule and it becomes a session here — your full transcription
          history.
        </p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 10, maxWidth: 820 }}>
      <span className="hint">
        <span className="hico">
          <Ic n="layers" size={13} />
        </span>
        Every hearing you’ve watched or transcribed. The recaps you save to a client live in that
        client’s profile under <b>Saved</b>.
      </span>
      {sessions.data.map((s) => {
        const live = s.status === 'live';
        return (
          <div
            key={s.id}
            className={'hsession' + (live ? ' live' : '')}
            onClick={() => navigate(`/intelligence/hearing-watch/${s.id}`)}
          >
            <span className="sico">
              <Ic n={live ? 'audio' : 'clock'} size={16} />
            </span>
            <div className="st">
              <div className="t1">{s.title}</div>
              <div className="t2">
                <span>{s.sourceType}</span>
                {s.startedAt ? (
                  <>
                    <span>·</span>
                    <span>started {new Date(s.startedAt).toLocaleDateString()}</span>
                  </>
                ) : null}
              </div>
            </div>
            {live ? (
              <span
                className="chip"
                style={{ background: 'var(--critical)', color: '#fff', border: 'none', fontSize: 10.5 }}
              >
                <span className="dot pulse" style={{ background: '#fff' }} />
                LIVE
              </span>
            ) : (
              <span className="chip muted" style={{ fontSize: 10.5 }}>
                {s.status}
              </span>
            )}
            <Ic n="chevR" size={14} />
          </div>
        );
      })}
    </div>
  );
}

export function HearingWatchPage() {
  const enabled = useIntelFeatureEnabled('hearing_watch');

  return (
    <div
      className="lw-root redesign"
      style={{ padding: '22px 32px 80px', background: 'var(--bg-canvas)', minHeight: '100%' }}
    >
      {!enabled ? (
        <div className="guide plain">
          <h4>Hearing Watch is not enabled</h4>
          <p>This workspace doesn’t have Hearing Watch turned on yet.</p>
        </div>
      ) : (
        <>
          <div className="pg-head">
            <h1 className="pg-title">
              <AudioOutlined /> Hearing Watch
            </h1>
            <p className="pg-desc">
              Client-ready intelligence from public hearings — track terms, watch hearings live, and
              get post-hearing briefs.
            </p>
          </div>
          <HearingWatchPanel />
        </>
      )}
    </div>
  );
}

function NewHearingModal({
  open,
  onClose,
  presetTitle,
  presetUrl,
  presetSearchQuery,
  presetHearingId,
}: {
  open: boolean;
  onClose: () => void;
  presetTitle?: string;
  presetUrl?: string;
  presetSearchQuery?: string;
  presetHearingId?: string;
}) {
  const [form] = Form.useForm();
  const create = useCreateHearing();
  const resolve = useResolveStream();
  const { message } = AntApp.useApp();

  // Consent (P8/D11) is shown/required only for PRIVATE source types.
  const sourceType = Form.useWatch('sourceType', form) as string | undefined;
  const needsConsent = PRIVATE_SOURCE_TYPES.has(sourceType ?? '');

  // Resolver outcome for the current hearing/paste. Cleared on reopen.
  const [resolved, setResolved] = useState<ResolveStreamResult | null>(null);
  const [provenance, setProvenance] = useState<string | undefined>();

  // A media URL (HLS/MP4/audio) can go straight into the stream field; a
  // congress.gov event page can't be ingested, so we keep it as a reference.
  const presetIsMedia = isMediaUrl(presetUrl);
  const eventPageUrl = presetUrl && !presetIsMedia ? presetUrl : undefined;
  // One-click jump to C-SPAN's video search for this hearing — the assisted-paste
  // terminal fallback when the resolver can't (or is gated from) auto-extracting.
  const cspanUrl =
    resolved?.reference && /c-span\.org\/search/i.test(resolved.reference)
      ? resolved.reference
      : presetSearchQuery
        ? `https://www.c-span.org/search/?searchtype=Videos&query=${encodeURIComponent(presetSearchQuery)}`
        : undefined;
  const referenceUrl = resolved?.reference ?? eventPageUrl;

  // The modal stays mounted across opens, so initialValues alone won't refresh
  // the preset when a different row is picked. Set fields each time it opens.
  useEffect(() => {
    if (!open) return;
    setResolved(null);
    setProvenance(undefined);
    form.setFieldsValue({
      title: presetTitle,
      sourceType: 'hearing',
      audioSource: 'stream_url',
      recordingPolicy: 'transcript_only',
      sourceUrl: presetIsMedia ? presetUrl : undefined,
      consentAttestation: undefined,
    });
    // Auto-resolve on open when launched from a hearing row ("Watch live" /
    // "Watch recording") — a first-party (.gov) stream becomes one-click, and
    // when nothing is playable the user sees WHY immediately instead of a bare
    // paste form. Manual "Add hearing" (no preset) keeps the paste-first flow;
    // an already-usable media URL needs no resolve.
    if (!presetIsMedia && (presetUrl || presetHearingId)) runResolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetTitle, presetUrl, presetHearingId]);

  const runResolve = () => {
    const pageUrl = (form.getFieldValue('sourceUrl') as string | undefined)?.trim() || presetUrl;
    if (!pageUrl && !presetHearingId) {
      message.info('Paste a page/stream URL or pick a hearing first.');
      return;
    }
    resolve.mutate(
      { pageUrl, hearingId: presetHearingId },
      {
        onSuccess: (r) => {
          setProvenance(undefined);
          // Treat empty-candidates as unresolvable so the user always gets
          // feedback + the assisted-paste reference (never a silent no-op).
          const isEmptyCandidates =
            r.status === 'candidates' && !(r.candidates && r.candidates.length);
          const normalized: ResolveStreamResult = isEmptyCandidates
            ? { ...r, status: 'unresolvable' }
            : r;
          setResolved(normalized);
          if (normalized.status === 'resolved' && normalized.media) {
            // NOTE: an IP-bound / short-lived source (YouTube-live googlevideo) is
            // NOT autofilled — it expires and is not yet wired for re-resolve at
            // connect. Show provenance only; leave the URL field untouched.
            if (normalized.media.ipBound) {
              setProvenance(
                normalized.note ??
                  `via ${normalized.media.provider} — resolves at connect time (not persisted)`,
              );
              message.warning(
                'This source is IP-bound and short-lived; it is not saved. It resolves at connect time (not yet wired) — see the note.',
              );
            } else {
              form.setFieldsValue({ sourceUrl: normalized.media.url });
              setProvenance(normalized.note ?? `via ${normalized.media.provider}`);
              message.success('Stream resolved');
            }
          } else if (normalized.status === 'candidates') {
            message.info('Pick the matching video below.');
          } else if (normalized.status === 'pending') {
            message.warning(
              normalized.note ?? 'Scheduled — the stream is not live yet. Try again once it starts.',
            );
          } else {
            // unresolvable — always surface the note; the reference link renders
            // below (assisted-paste fallback) even without an event/cspan URL.
            message.warning(normalized.note ?? 'Could not resolve a stream for this hearing.');
          }
        },
        onError: (e: unknown) => message.error(`Resolve failed: ${(e as Error).message}`),
      },
    );
  };

  const pickCandidate = (pageUrl: string) => {
    resolve.mutate(
      { pageUrl },
      {
        onSuccess: (r) => {
          setResolved(r);
          setProvenance(undefined);
          if (r.status === 'resolved' && r.media) {
            if (r.media.ipBound) {
              setProvenance(
                r.note ?? `via ${r.media.provider} — resolves at connect time (not persisted)`,
              );
              message.warning(
                'This source is IP-bound and short-lived; it is not saved. It resolves at connect time (not yet wired) — see the note.',
              );
            } else {
              form.setFieldsValue({ sourceUrl: r.media.url });
              setProvenance(r.note ?? `via ${r.media.provider}`);
              message.success('Stream resolved');
            }
          } else if (r.status === 'pending') {
            message.warning(r.note ?? 'Scheduled — the stream is not live yet.');
          } else if (r.status !== 'candidates') {
            message.warning(r.note ?? 'Could not resolve that candidate.');
          }
        },
        onError: (e: unknown) => message.error(`Resolve failed: ${(e as Error).message}`),
      },
    );
  };

  return (
    <Modal
      title="Start a hearing session"
      open={open}
      onCancel={onClose}
      okText="Create"
      confirmLoading={create.isPending}
      onOk={() => {
        form.validateFields().then((v) => {
          create.mutate(
            {
              title: v.title,
              sourceType: v.sourceType,
              audioSource: v.audioSource,
              recordingPolicy: v.recordingPolicy,
              // No ingestible media URL? Persist whatever reference link we DO
              // have (event page / C-SPAN search) so the Live Hearing Room can
              // surface it as an "open + capture" link — otherwise that link
              // only ever existed transiently in this modal.
              sourceUrl: v.sourceUrl?.trim() || referenceUrl || cspanUrl || undefined,
              consentAttestation: PRIVATE_SOURCE_TYPES.has(v.sourceType)
                ? v.consentAttestation?.trim() || undefined
                : undefined,
            },
            {
              onSuccess: () => {
                message.success('Hearing session created');
                form.resetFields();
                onClose();
              },
              onError: (e: unknown) => {
                // Surface the server's actual validation reason (class-validator
                // returns a message array, e.g. "title must be shorter than or
                // equal to 300 characters") instead of the generic axios status
                // text — a bare "Request failed with status code 400" gave no
                // way to diagnose why a create failed.
                const data = (e as { response?: { data?: { message?: string | string[] } } })
                  ?.response?.data;
                const detail = Array.isArray(data?.message) ? data.message.join('; ') : data?.message;
                message.error(`Could not create session: ${detail ?? (e as Error).message}`);
              },
            },
          );
        });
      }}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          title: presetTitle,
          sourceType: 'hearing',
          audioSource: 'stream_url',
          recordingPolicy: 'transcript_only',
        }}
      >
        {presetIsMedia && !resolved ? (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message="Stream URL pre-filled from the hearing — it will play in the Live Hearing Room, ready to transcribe."
          />
        ) : null}

        {/* Auto-resolve in flight (opened from a hearing row). */}
        {resolve.isPending ? (
          <Alert
            type="info"
            showIcon
            icon={<Spin size="small" />}
            style={{ marginBottom: 12 }}
            message="Finding a playable stream…"
            description="Checking congress.gov video links and first-party committee sources."
          />
        ) : null}

        {/* Resolver outcomes ------------------------------------------------- */}
        {resolved?.status === 'resolved' && provenance ? (
          <Alert
            // An IP-bound / short-lived source (YouTube-live) is NOT persisted and
            // resolves at connect time; surface it as a warning, not a success.
            type={resolved.media?.ipBound ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 12 }}
            message={resolved.media?.ipBound ? 'Source found — not saved' : 'Stream resolved'}
            description={
              <span>
                {provenance}
                {resolved.media?.ipBound ? (
                  <>
                    {' '}
                    <Tag color="orange">IP-bound / short-lived</Tag>
                    <br />
                    <Text type="secondary">
                      This stream URL is IP-bound and expires (~6h). It is NOT saved with
                      the session; it resolves at connect time. That path isn&apos;t wired
                      yet — this source is a known limitation while YouTube-live is gated
                      off.
                    </Text>
                  </>
                ) : null}
              </span>
            }
          />
        ) : null}

        {resolved?.status === 'pending' ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Scheduled — not live yet"
            description={
              resolved.note ?? 'The stream is not broadcasting yet. Try again once it starts.'
            }
          />
        ) : null}

        {resolved?.status === 'candidates' && resolved.candidates?.length ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Pick the matching video"
            description={
              <List
                size="small"
                dataSource={resolved.candidates}
                renderItem={(c) => (
                  <List.Item
                    actions={[
                      <Button
                        key="use"
                        size="small"
                        type="link"
                        onClick={() => pickCandidate(c.pageUrl)}
                      >
                        Use
                      </Button>,
                    ]}
                  >
                    <a href={c.pageUrl} target="_blank" rel="noreferrer">
                      {c.title}
                    </a>
                  </List.Item>
                )}
              />
            }
          />
        ) : null}

        {/* Assisted-paste terminal fallback (unresolvable / reference) --------
            Renders for EVERY unresolvable outcome (so the user always gets
            feedback), even when there's no reference link (e.g. an SSRF-blocked
            note) — in that case it shows just the note. */}
        {!resolve.isPending &&
        (resolved?.status === 'unresolvable' || (!resolved && (eventPageUrl || cspanUrl))) ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="No direct stream found — two ways to watch it anyway"
            description={
              <span>
                {resolved?.note ? (
                  <>
                    {resolved.note}
                    {referenceUrl || cspanUrl ? <br /> : null}
                  </>
                ) : (
                  <>Congress.gov doesn&apos;t publish a media URL for this one. </>
                )}
                {referenceUrl || cspanUrl ? (
                  <>
                    Open{' '}
                    {referenceUrl ? (
                      <a href={referenceUrl} target="_blank" rel="noreferrer">
                        the source page ↗
                      </a>
                    ) : null}
                    {referenceUrl && cspanUrl ? ' or ' : ' '}
                    {cspanUrl ? (
                      <a href={cspanUrl} target="_blank" rel="noreferrer">
                        C-SPAN ↗
                      </a>
                    ) : null}
                    {' — '}
                    if you find a direct <Text code>.m3u8</Text>/MP4 link there, paste it below;
                    otherwise just create the session as-is and use{' '}
                    <Text strong>&quot;Start transcription&quot;</Text> once you&apos;re in the
                    room — this link comes with you.
                  </>
                ) : null}
              </span>
            }
          />
        ) : null}

        <Form.Item
          name="title"
          label="Hearing title"
          rules={[
            { required: true },
            { max: HEARING_TITLE_MAX, message: `Title must be ${HEARING_TITLE_MAX} characters or fewer` },
          ]}
        >
          <Input
            placeholder="e.g. Senate Energy Committee — Interconnection Reform"
            maxLength={HEARING_TITLE_MAX}
            showCount
          />
        </Form.Item>
        <Form.Item name="sourceType" label="Source type" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'hearing', label: 'Hearing' },
              { value: 'markup', label: 'Markup' },
              { value: 'meeting', label: 'Meeting' },
              { value: 'webinar', label: 'Webinar' },
              { value: 'agency_session', label: 'Agency session' },
            ]}
          />
        </Form.Item>
        <Form.Item name="audioSource" label="Audio source" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'stream_url', label: 'Live stream URL' },
              { value: 'browser_mic', label: 'Microphone / device' },
              { value: 'uploaded_audio', label: 'Uploaded recording' },
              { value: 'conference_bridge', label: 'Conference bridge' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="recordingPolicy"
          label="Recording policy"
          rules={[{ required: true }]}
          tooltip="Controls what is stored. Transcript-only never persists audio."
        >
          <Select
            options={[
              { value: 'transcript_only', label: 'Transcript only (no audio stored)' },
              { value: 'audio_and_transcript', label: 'Store transcript + audio' },
              { value: 'no_storage', label: 'No storage (live only)' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="sourceUrl"
          label="Stream / recording URL (optional)"
          tooltip="Direct media URL — HLS .m3u8, MP3/AAC, or MP4 (e.g. a C-SPAN or committee stream). Or paste an event/committee page and click Resolve stream."
        >
          <Input
            placeholder="https://…/hearing.m3u8 or an event page — then Resolve"
            addonAfter={
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: 'auto' }}
                loading={resolve.isPending}
                onClick={runResolve}
              >
                Resolve stream
              </Button>
            }
          />
        </Form.Item>

        {/* Consent — PRIVATE source types only (P8/D11) --------------------- */}
        {needsConsent ? (
          <Form.Item
            name="consentAttestation"
            label="Consent"
            rules={[
              { required: true, message: 'Consent attestation is required for a private session' },
            ]}
            tooltip="Private sessions (meeting/webinar/agency session) require you to attest you're authorized to capture them. Public hearings/markups do not."
          >
            <Input.TextArea
              rows={2}
              placeholder="Confirm you're authorized to capture this session."
            />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}

export default HearingWatchPage;
