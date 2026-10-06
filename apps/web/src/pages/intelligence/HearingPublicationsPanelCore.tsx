import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useApiScope } from '../../lib/use-api-scope.js';

type Kind = 'live_update' | 'hearing_recap';
type Claim = {
  id: string;
  kind: 'quote' | 'observation' | 'analysis';
  text: string;
  evidenceIds: string[];
};
type Evidence = {
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
};
type Version = {
  id: string;
  version: number;
  status: string;
  contentHash: string;
  payload: {
    title: string;
    label: string;
    clientId: string | null;
    claims: Claim[];
    evidence: Evidence[];
    folders: Array<{ id: string }>;
    coverage: { missing: string[]; audio: string; transcript: string };
    provenance?: { clientContext?: string; folderContextHash?: string };
  };
};
type Contact = {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  verified: boolean;
  optedOut: boolean;
};
type Consent = { id: string; phone: string; contactId: string; revokedAt: string | null };
type SmsSettings = {
  consents: Consent[];
  consentText: string;
  consentVersion: string;
  providerConfigured: boolean;
  dispatchEnabled: boolean;
};
type Preview = {
  approvalHash: string;
  composition: {
    subject: string;
    plainText: string;
    smsText: string | null;
    smsSize: { encoding: string; segments: number } | null;
    recipients: Array<{ name: string; email: string; phone?: string; role: string }>;
  };
};
const time = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const toggle = (values: string[], value: string) =>
  values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
const failure = (error: unknown) => {
  const code = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message;
  const messages: Record<string, string> = {
    SOURCE_DISTRIBUTION_PERMISSION_REQUIRED:
      'This source does not have current permission for client distribution.',
    HEARING_EMAIL_DISABLED: 'Hearing email delivery is not enabled for this pilot.',
    HEARING_SMS_NOT_QUALIFIED: 'Hearing SMS delivery is awaiting provider qualification.',
    MERI_EVIDENCE_RECAP_UNAVAILABLE_CREATE_A_QUOTE_DRAFT_OR_RETRY:
      'Meri could not generate a supported draft. Retry, or compose a draft from selected evidence.',
    AUDIENCE_OR_CONTENT_CHANGED_REVIEW_AGAIN:
      'The audience or content changed. Preview the message again.',
    SMS_EXCEEDS_THREE_SEGMENTS_CREATE_A_SHORTER_REVIEWED_VERSION:
      'This message exceeds three SMS segments. Create and review a shorter version.',
    QUOTE_MUST_MATCH_PERSISTED_TRANSCRIPT:
      'A quote must match the selected final transcript verbatim.',
  };
  return typeof code === 'string' && messages[code]
    ? messages[code]
    : 'The action could not finish. Refresh to check current access, source permission and evidence.';
};

export function HearingPublicationsPanel({
  sessionId,
  eventId,
  title,
  defaultClientId,
  clients,
  updatesEnabled,
  recapsEnabled,
  smsEnabled,
  recapRequested,
  onRecapOpened,
  playEvidence,
  canPlayEvidence,
}: {
  sessionId: string;
  eventId?: string;
  title: string;
  defaultClientId?: string;
  clients: Array<{ id: string; name: string }>;
  updatesEnabled: boolean;
  recapsEnabled: boolean;
  smsEnabled: boolean;
  recapRequested: boolean;
  onRecapOpened: () => void;
  playEvidence: (ms: number) => void;
  canPlayEvidence?: (ms: number) => boolean;
}) {
  const api = useApi(),
    scope = useApiScope(),
    root = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<Kind>(updatesEnabled ? 'live_update' : 'hearing_recap'),
    [clientId, setClientId] = useState(defaultClientId ?? '');
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]),
    [folderIds, setFolderIds] = useState<string[]>([]),
    [search, setSearch] = useState('');
  const [claims, setClaims] = useState<Claim[]>([]),
    [draftTitle, setDraftTitle] = useState(title),
    [currentId, setCurrentId] = useState(''),
    [supersedesId, setSupersedesId] = useState<string>();
  const [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [channel, setChannel] = useState<'email' | 'sms' | 'in_app'>('email'),
    [contactIds, setContactIds] = useState<string[]>([]),
    [consentIds, setConsentIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const base = `/intel-api/hearings/${encodeURIComponent(sessionId)}/publications`,
    key = ['hearing-publications', scope, sessionId, kind];
  const linkedId = new URLSearchParams(window.location.search).get('publication') ?? '';
  const openedLink = useRef('');
  const linked = useQuery({
    queryKey: ['hearing-publication-link', scope, sessionId, linkedId],
    queryFn: async () =>
      (await api.get<Version & { kind: Kind }>(base + '/' + encodeURIComponent(linkedId))).data,
    enabled: Boolean(linkedId),
    retry: false,
  });
  useEffect(() => {
    const value = linked.data,
      linkKey = scope + ':' + sessionId + ':' + linkedId;
    if (!value || openedLink.current === linkKey) return;
    if (value.kind === 'hearing_recap' ? !recapsEnabled : !updatesEnabled) return;
    openedLink.current = linkKey;
    setKind(value.kind);
    setClientId(value.payload.clientId ?? '');
    setCurrentId(value.id);
    root.current?.scrollIntoView({ block: 'start' });
  }, [linked.data, scope, sessionId, linkedId, updatesEnabled, recapsEnabled]);
  const versions = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<Version[]>(base + '?kind=' + kind)).data,
    retry: false,
  });
  const candidates = useQuery({
    queryKey: [...key, 'candidates'],
    queryFn: async () =>
      (
        await api.get<{
          evidence: Evidence[];
          candidates: Array<{ id: string; text: string; evidenceIds: string[] }>;
        }>(base + '/candidates?kind=' + kind)
      ).data,
    retry: false,
    refetchInterval: 15000,
  });
  const folders = useQuery({
    queryKey: ['hearing-publication-folders', scope],
    queryFn: async () =>
      (
        await api.get<
          Array<{ id: string; name: string; clientId: string | null; archived: boolean }>
        >('/intel-api/legiwatch/folders')
      ).data,
    retry: false,
  });
  const directory = useQuery({
    queryKey: ['hearing-publication-directory', scope],
    queryFn: async () =>
      (await api.get<{ contacts: Contact[] }>('/intel-api/legiwatch/reports/recipients')).data,
    retry: false,
  });
  const sms = useQuery({
    queryKey: ['hearing-sms', scope, clientId],
    queryFn: async () =>
      (await api.get<SmsSettings>(`/intel-api/clients/${encodeURIComponent(clientId)}/hearing-sms`))
        .data,
    enabled: smsEnabled && Boolean(clientId),
    retry: false,
  });
  const current = versions.data?.find(
    (v) => v.id === currentId && v.payload.clientId === (clientId || null),
  );
  const history = useQuery({
    queryKey: [...key, 'deliveries', currentId],
    queryFn: async () =>
      (
        await api.get<
          Array<{
            id: string;
            recipients: Array<{
              id: string;
              name: string;
              destination: string;
              channel: string;
              state: string;
              acceptedAt: string | null;
              error: string | null;
            }>;
          }>
        >(base + '/' + encodeURIComponent(currentId) + '/deliveries')
      ).data,
    enabled: Boolean(current),
    retry: false,
    refetchInterval: current ? 15000 : false,
  });
  const evidence = useMemo(
    () =>
      [
        ...new Map(
          [...(candidates.data?.evidence ?? []), ...(current?.payload.evidence ?? [])].map((e) => [
            e.segmentId,
            e,
          ]),
        ).values(),
      ].sort((a, b) => a.startMs - b.startMs),
    [candidates.data, current],
  );
  useEffect(() => {
    if (recapRequested && recapsEnabled) {
      changeKind('hearing_recap');
      root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      onRecapOpened();
    }
  }, [recapRequested, recapsEnabled]);
  useEffect(() => {
    setReviewed(false);
    setPreview(null);
  }, [currentId, channel, contactIds, consentIds]);
  function clearDraft() {
    setClaims([]);
    setSelectedEvidence([]);
    setFolderIds([]);
    setCurrentId('');
    setSupersedesId(undefined);
    setPreview(null);
    setError(null);
    setNotice(null);
  }
  function changeKind(value: Kind) {
    if (value !== kind) {
      setKind(value);
      clearDraft();
    }
  }
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  function draftInput() {
    return {
      kind,
      clientId: clientId || undefined,
      title: draftTitle,
      folderIds,
      evidenceIds: [...new Set(claims.flatMap((c) => c.evidenceIds))],
      claims,
      ...(supersedesId ? { supersedesId } : {}),
    };
  }
  async function create(generate = false) {
    await act(async () => {
      const body = generate
        ? {
            kind,
            clientId: clientId || undefined,
            title: draftTitle,
            folderIds,
            evidenceIds: selectedEvidence,
            ...(supersedesId ? { supersedesId } : {}),
          }
        : draftInput();
      const result = (await api.post<Version>(base + (generate ? '/generate' : ''), body)).data;
      await versions.refetch();
      setCurrentId(result.id);
      setClaims([]);
      setSupersedesId(undefined);
      setNotice('Draft saved. Review every claim and evidence link before approving.');
    });
  }
  function addClaim(quote = false) {
    if (!selectedEvidence.length) return;
    const refs = selectedEvidence.slice(0, 20),
      first = evidence.find((e) => e.segmentId === refs[0]);
    setClaims((rows) => [
      ...rows,
      {
        id: crypto.randomUUID(),
        kind: quote ? 'quote' : 'observation',
        text: quote ? (first?.text.slice(0, 2500) ?? '') : '',
        evidenceIds: quote ? refs.slice(0, 1) : refs,
      },
    ]);
  }
  const audience =
    channel === 'sms'
      ? { channel, consentIds }
      : channel === 'in_app'
        ? { channel }
        : { channel, selection: contactIds.map((id) => ({ kind: 'contact', id, role: 'to' })) };
  const previewScope = useRef('');
  previewScope.current = JSON.stringify([
    scope,
    sessionId,
    clientId,
    kind,
    currentId,
    current?.contentHash,
    audience,
  ]);
  async function previewDelivery() {
    const expected = previewScope.current;
    await act(async () => {
      const result = (
        await api.post<Preview>(base + '/' + currentId + '/delivery-preview', audience)
      ).data;
      if (expected === previewScope.current) setPreview(result);
    });
  }
  async function exportDoc() {
    if (!current || !clientId) return;
    await act(async () => {
      const result = await api.post<Blob>(
        `/api/intelligence/clients/${encodeURIComponent(clientId)}/hearing-recaps/approved/export`,
        { sessionId, publicationId: current.id, contentHash: current.contentHash },
        { responseType: 'blob' },
      );
      const url = URL.createObjectURL(result.data),
        link = document.createElement('a');
      link.href = url;
      link.download = `Hearing recap v${current.version}.docx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  return (
    <section
      ref={root}
      className="hearing-publications"
      aria-label="Reviewed hearing updates and recaps"
    >
      <header>
        <div>
          <p className="hp-eyebrow">UNOFFICIAL HEARING INTELLIGENCE</p>
          <h2>Reviewed updates &amp; recaps</h2>
          {eventId && current ? (
            <p>
              <a
                href={`/legiwatch/hearings/${encodeURIComponent(eventId)}?session=${encodeURIComponent(sessionId)}&publication=${encodeURIComponent(current.id)}${clientId ? '&client=' + encodeURIComponent(clientId) : ''}#published-records`}
              >
                Compare this unofficial version with published records
              </a>
            </p>
          ) : null}
        </div>
        <nav aria-label="Publication type">
          {updatesEnabled && (
            <button aria-pressed={kind === 'live_update'} onClick={() => changeKind('live_update')}>
              Live updates
            </button>
          )}
          {recapsEnabled && (
            <button
              aria-pressed={kind === 'hearing_recap'}
              onClick={() => changeKind('hearing_recap')}
            >
              Recaps
            </button>
          )}
        </nav>
      </header>
      <p>
        Use saved final testimony as evidence. Speaker labels are provisional; these versions do not
        establish official legislative actions.
      </p>
      {error && (
        <p role="alert" className="hp-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="hp-notice">
          {notice}
        </p>
      )}
      <div className="hp-context">
        <label>
          Client
          <select
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              clearDraft();
              setContactIds([]);
              setConsentIds([]);
            }}
            disabled={busy}
          >
            <option value="">Internal review</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Private folder context
          <select
            multiple
            value={folderIds}
            onChange={(e) => setFolderIds([...e.target.selectedOptions].map((o) => o.value))}
            disabled={busy}
          >
            {(folders.data ?? [])
              .filter((folder) => !folder.archived && folder.clientId === (clientId || null))
              .map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="hp-columns">
        <section>
          <h3>1. Select final evidence</h3>
          <label>
            Find testimony
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search saved passages"
            />
          </label>
          {candidates.isError && <p role="alert">Saved evidence could not be loaded.</p>}
          <div className="hp-evidence">
            {evidence
              .filter((e) => e.text.toLowerCase().includes(search.toLowerCase()))
              .map((e) => (
                <article key={e.segmentId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedEvidence.includes(e.segmentId)}
                      onChange={() => setSelectedEvidence((values) => toggle(values, e.segmentId))}
                    />
                    <span>
                      <b>
                        {time(e.startMs)}–{time(e.endMs)}
                      </b>
                      <br />
                      {e.text}
                    </span>
                  </label>
                  {canPlayEvidence?.(e.startMs) ? <button onClick={() => playEvidence(e.startMs)}>Play evidence audio</button> : <span className="lw-card__meta">No retained audio for this passage</span>}
                </article>
              ))}
            {!evidence.length && <p>Final testimony will appear here after it is saved.</p>}
          </div>
          <p>
            {selectedEvidence.length} selected · Latest 100 saved passages plus this version’s
            evidence.
          </p>
          <div className="hp-actions">
            <button disabled={busy || !selectedEvidence.length} onClick={() => addClaim(true)}>
              Add transcript quote
            </button>
            <button disabled={busy || !selectedEvidence.length} onClick={() => addClaim()}>
              Compose observation
            </button>
            <button disabled={busy || !selectedEvidence.length} onClick={() => void create(true)}>
              Generate evidence-based draft
            </button>
          </div>
          {!!candidates.data?.candidates.length && (
            <details>
              <summary>Persisted analysis candidates ({candidates.data.candidates.length})</summary>
              {candidates.data.candidates.map((candidate) => (
                <article key={candidate.id}>
                  <p>Analysis: {candidate.text}</p>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setSelectedEvidence(candidate.evidenceIds);
                      setClaims((rows) => [
                        ...rows,
                        {
                          id: crypto.randomUUID(),
                          kind: 'analysis',
                          text: candidate.text,
                          evidenceIds: candidate.evidenceIds,
                        },
                      ]);
                    }}
                  >
                    Review as a draft claim
                  </button>
                </article>
              ))}
            </details>
          )}
        </section>
        <section>
          <h3>2. Compose a saved version</h3>
          <label>
            Title
            <input
              value={draftTitle}
              maxLength={200}
              onChange={(e) => setDraftTitle(e.target.value)}
            />
          </label>
          {supersedesId && (
            <p>
              A correction creates a new version. Earlier approvals and deliveries stay in history.
            </p>
          )}
          {claims.map((claim, index) => (
            <article className="hp-claim" key={claim.id}>
              <label>
                Claim {index + 1} type
                <select
                  value={claim.kind}
                  onChange={(e) =>
                    setClaims((rows) =>
                      rows.map((row) =>
                        row.id === claim.id
                          ? { ...row, kind: e.target.value as Claim['kind'] }
                          : row,
                      ),
                    )
                  }
                >
                  <option value="quote">Transcript quote</option>
                  <option value="observation">Observation</option>
                  <option value="analysis">Analysis / inference</option>
                </select>
              </label>
              <label>
                Claim text
                <textarea
                  value={claim.text}
                  maxLength={2500}
                  onChange={(e) =>
                    setClaims((rows) =>
                      rows.map((row) =>
                        row.id === claim.id ? { ...row, text: e.target.value } : row,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Supporting final evidence
                <select
                  multiple
                  value={claim.evidenceIds}
                  onChange={(e) => {
                    const ids = [...e.target.selectedOptions].map((o) => o.value);
                    setClaims((rows) =>
                      rows.map((row) => (row.id === claim.id ? { ...row, evidenceIds: ids } : row)),
                    );
                  }}
                >
                  {evidence.map((e) => (
                    <option key={e.segmentId} value={e.segmentId}>
                      {time(e.startMs)} · {e.text.slice(0, 65)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => setClaims((rows) => rows.filter((row) => row.id !== claim.id))}
              >
                Remove claim
              </button>
            </article>
          ))}
          {!claims.length && (
            <p>Select evidence to compose a claim or generate a draft for review.</p>
          )}
          <button
            className="hp-primary"
            disabled={
              busy || !claims.length || claims.some((c) => !c.text.trim() || !c.evidenceIds.length)
            }
            onClick={() => void create()}
          >
            Save draft version
          </button>
        </section>
      </div>
      <section className="hp-review">
        <h3>3. Review an immutable version</h3>
        {versions.isError && <p role="alert">Saved versions could not be loaded.</p>}
        <label>
          Saved version
          <select value={currentId} onChange={(e) => setCurrentId(e.target.value)}>
            <option value="">Choose a version</option>
            {(versions.data ?? [])
              .filter((v) => v.payload.clientId === (clientId || null))
              .map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version} · {v.status} · {v.payload.title}
                </option>
              ))}
          </select>
        </label>
        {current && (
          <>
            <h4>
              {current.payload.label} · v{current.version} · {current.status}
            </h4>
            <p>
              Transcript: {current.payload.coverage.transcript} · Audio:{' '}
              {current.payload.coverage.audio}
            </p>
            {current.payload.provenance?.clientContext && (
              <p>
                Client context: {current.payload.provenance.clientContext}
                {current.payload.folders.length
                  ? ' · ' + current.payload.folders.length + ' selected folders'
                  : ''}
              </p>
            )}
            {!!current.payload.coverage.missing.length && (
              <ul>
                {current.payload.coverage.missing.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
            {current.payload.claims.map((claim) => (
              <article className="hp-claim" key={claim.id}>
                <b>
                  {claim.kind === 'analysis'
                    ? 'Analysis / inference'
                    : claim.kind === 'quote'
                      ? 'Transcript quote'
                      : 'Observation'}
                </b>
                <p>{claim.text}</p>
                <details>
                  <summary>Supporting evidence ({claim.evidenceIds.length})</summary>
                  {claim.evidenceIds.map((id) => {
                    const e = current.payload.evidence.find((item) => item.segmentId === id);
                    return (
                      e && (
                        <blockquote key={id}>
                          <p>{e.text}</p>
                          {canPlayEvidence?.(e.startMs) ? <button onClick={() => playEvidence(e.startMs)}>
                            Play {time(e.startMs)}–{time(e.endMs)}
                          </button> : <span className="lw-card__meta">No retained audio for this passage</span>}
                        </blockquote>
                      )
                    );
                  })}
                </details>
              </article>
            ))}
            <button
              disabled={busy}
              onClick={() => {
                setClaims(
                  current.payload.claims.map((c) => ({ ...c, evidenceIds: [...c.evidenceIds] })),
                );
                setSelectedEvidence(current.payload.evidence.map((e) => e.segmentId));
                setDraftTitle(current.payload.title);
                setFolderIds(current.payload.folders.map((f) => f.id));
                setSupersedesId(current.id);
                setNotice('Edit the claims above and save a new correction version.');
              }}
            >
              Create correction
            </button>
            {current.status === 'draft' && (
              <div className="hp-approval">
                <label>
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />{' '}
                  I reviewed every claim, its evidence, provisional speakers and coverage
                  limitations.
                </label>
                <button
                  className="hp-primary"
                  disabled={busy || !reviewed}
                  onClick={() =>
                    void act(async () => {
                      await api.post(base + '/' + current.id + '/approve', {
                        contentHash: current.contentHash,
                        attestSupported: true,
                      });
                      await versions.refetch();
                    })
                  }
                >
                  Approve this version
                </button>
              </div>
            )}
            {current.status === 'approved' && (
              <div className="hp-distribution">
                <h3>4. Preview delivery</h3>
                {kind === 'hearing_recap' && clientId && (
                  <div className="hp-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.post(
                            `/api/intelligence/clients/${encodeURIComponent(clientId)}/hearing-recaps/approved`,
                            {
                              sessionId,
                              publicationId: current.id,
                              contentHash: current.contentHash,
                            },
                          );
                          setNotice(
                            'Approved recap saved to Documents. Meri indexing status is shown in Documents.',
                          );
                        })
                      }
                    >
                      Save approved recap to Documents
                    </button>
                    <button disabled={busy} onClick={() => void exportDoc()}>
                      Export approved DOCX
                    </button>
                  </div>
                )}
                <label>
                  Channel
                  <select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as 'email' | 'sms' | 'in_app')}
                  >
                    <option value="email">Email</option>
                    <option value="in_app">My LegiWatch inbox</option>
                    {smsEnabled && clientId && <option value="sms">SMS</option>}
                  </select>
                </label>
                {channel === 'email' ? (
                  <fieldset>
                    <legend>Explicit email recipients</legend>
                    {(directory.data?.contacts ?? [])
                      .filter((c) => c.active && c.verified && !c.optedOut && c.email)
                      .map((c) => (
                        <label key={c.id}>
                          <input
                            type="checkbox"
                            checked={contactIds.includes(c.id)}
                            onChange={() => setContactIds((ids) => toggle(ids, c.id))}
                          />
                          {c.name} · {c.email}
                        </label>
                      ))}
                  </fieldset>
                ) : channel === 'in_app' ? (
                  <p>Save this reviewed version to your own LegiWatch inbox.</p>
                ) : (
                  <fieldset>
                    <legend>Verified hearing-update SMS consents</legend>
                    {(sms.data?.consents ?? [])
                      .filter((c) => !c.revokedAt)
                      .map((c) => (
                        <label key={c.id}>
                          <input
                            type="checkbox"
                            checked={consentIds.includes(c.id)}
                            onChange={() => setConsentIds((ids) => toggle(ids, c.id))}
                          />
                          ••• ••• {c.phone.slice(-4)}
                        </label>
                      ))}
                    {!sms.data?.dispatchEnabled && (
                      <p>SMS delivery is dormant until provider qualification is complete.</p>
                    )}
                  </fieldset>
                )}
                <button
                  disabled={
                    busy ||
                    (channel !== 'in_app' && !(channel === 'sms' ? consentIds : contactIds).length)
                  }
                  onClick={() => void previewDelivery()}
                >
                  Preview exact message and audience
                </button>
                {preview && (
                  <article className="hp-preview">
                    <h4>{preview.composition.subject}</h4>
                    <pre>{preview.composition.smsText ?? preview.composition.plainText}</pre>
                    <p>
                      Recipients:{' '}
                      {preview.composition.recipients
                        .map((r) => `${r.name} ${r.phone ? '••• ' + r.phone.slice(-4) : r.email}`)
                        .join('; ')}
                    </p>
                    {preview.composition.smsSize && (
                      <p>
                        {preview.composition.smsSize.encoding} ·{' '}
                        {preview.composition.smsSize.segments} SMS segments
                      </p>
                    )}
                    <button
                      className="hp-primary"
                      disabled={busy || (channel === 'sms' && !sms.data?.dispatchEnabled)}
                      onClick={() =>
                        void act(async () => {
                          await api.post(base + '/' + current.id + '/deliveries', {
                            ...audience,
                            approvalHash: preview.approvalHash,
                          });
                          setPreview(null);
                          await history.refetch();
                          setNotice(
                            'Delivery queued. Check history for provider acceptance, failure or uncertainty.',
                          );
                        })
                      }
                    >
                      Queue this reviewed message
                    </button>
                  </article>
                )}
                <h4>Delivery history</h4>
                {history.data?.flatMap((d) =>
                  d.recipients.map((r) => (
                    <p key={r.id}>
                      {r.channel} · {r.name} {r.destination} · {r.state}
                      {r.acceptedAt
                        ? ' · Provider accepted at ' + new Date(r.acceptedAt).toLocaleTimeString()
                        : ''}
                    </p>
                  )),
                )}
                {!history.data?.length && <p>No delivery has been queued for this version.</p>}
                <p>Provider acceptance does not confirm an inbox or handset receipt.</p>
              </div>
            )}
          </>
        )}
      </section>
      {smsEnabled && clientId && (
        <HearingSmsSetup
          key={scope + clientId}
          clientId={clientId}
          contacts={directory.data?.contacts ?? []}
          settings={sms.data}
          refresh={() => void sms.refetch()}
        />
      )}
    </section>
  );
}

export function HearingSmsSetup({
  clientId,
  contacts,
  settings,
  refresh,
  purpose = 'hearing_updates',
}: {
  clientId: string;
  contacts: Contact[];
  settings?: SmsSettings;
  refresh: () => void;
  purpose?: 'hearing_updates' | 'hearing_records';
}) {
  const api = useApi(),
    [phone, setPhone] = useState(''),
    [code, setCode] = useState(''),
    [contactId, setContactId] = useState(''),
    [consented, setConsented] = useState(false);
  const [pending, setPending] = useState(false),
    [sent, setSent] = useState(false),
    [message, setMessage] = useState('');
  const base = `/intel-api/clients/${encodeURIComponent(clientId)}/hearing-sms`;
  const consentLabel = purpose === 'hearing_records' ? 'Published-record brief' : 'Hearing-update';
  async function submit(confirm = false) {
    setPending(true);
    setMessage('');
    try {
      await api.post(
        base +
          (purpose === 'hearing_records' ? '/records' : '') +
          (confirm ? '/verify/confirm' : '/verify/start'),
        confirm ? { phone, code } : { phone, contactId, consentVersion: settings?.consentVersion },
      );
      setSent(!confirm);
      setMessage(
        confirm
          ? `${consentLabel} consent verified.`
          : 'Verification code sent. Enter the code received on this phone.',
      );
      if (confirm) {
        setCode('');
        refresh();
      }
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <details className="hp-sms">
      <summary>{consentLabel} SMS consent</summary>
      <p>
        Verification and consent apply to this client and{' '}
        {purpose === 'hearing_records'
          ? 'published-record briefs and corrections'
          : 'hearing updates'}
        .
      </p>
      {!settings?.providerConfigured && (
        <p>SMS verification is unavailable until the provider is configured.</p>
      )}
      <label>
        Existing directory contact
        <select
          disabled={sent || pending}
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
        >
          <option value="">Choose contact</option>
          {contacts
            .filter((c) => c.active && !c.optedOut)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Phone number, with country code
        <input
          type="tel"
          value={phone}
          disabled={sent || pending}
          onChange={(e) => {
            setPhone(e.target.value);
            setConsented(false);
          }}
          placeholder="+1…"
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={consented}
          disabled={sent || pending}
          onChange={(e) => setConsented(e.target.checked)}
        />
        {settings?.consentText ?? 'Consent text is unavailable.'}
      </label>
      {!sent ? (
        <button
          disabled={pending || !consented || !contactId || !phone || !settings?.providerConfigured}
          onClick={() => void submit()}
        >
          Send verification code
        </button>
      ) : (
        <>
          <label>
            Six-digit code
            <input
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <button disabled={pending || code.length !== 6} onClick={() => void submit(true)}>
            Verify {consentLabel.toLowerCase()} consent
          </button>
          <button
            disabled={pending}
            onClick={() => {
              setSent(false);
              setCode('');
            }}
          >
            Change phone or contact
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {settings?.consents
        .filter((c) => !c.revokedAt)
        .map((consent) => (
          <p key={consent.id}>
            Verified ••• ••• {consent.phone.slice(-4)}{' '}
            <button
              disabled={pending}
              onClick={() => {
                setPending(true);
                void api
                  .post(base + '/' + consent.id + '/revoke', {})
                  .then(() => {
                    setMessage('Consent revoked. Unsent deliveries will be held.');
                    refresh();
                  })
                  .catch((error) => setMessage(failure(error)))
                  .finally(() => setPending(false));
              }}
            >
              Revoke consent
            </button>
          </p>
        ))}
    </details>
  );
}
