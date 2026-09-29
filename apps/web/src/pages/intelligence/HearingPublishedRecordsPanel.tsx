import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useApiScope } from '../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import '../../vnext/pages/legiwatch/hearings/hearing-published-records.css';
import { HearingSmsSetup } from './HearingPublicationsPanel.js';
import { HearingRecordCorrectionReview } from './HearingRecordCorrectionReview.js';
type Ref = { id: string; hash: string; locator: string };
type RecordItem = {
  id: string;
  identity: string;
  billId: string | null;
  kind: string;
  hash: string;
  date: string | null;
  observedAt: string;
  association: string;
  evidence: Record<string, unknown>;
};
type Claim = {
  id: string;
  parentClaimId?: string;
  text: string;
  kind: 'fact' | 'quote' | 'analysis';
  scope: 'bill_record' | 'hearing_event';
  billId: string | null;
  references: Ref[];
  section: string;
  outcome: string;
  rationale: string;
};
type Assessment = {
  id: string;
  claimId: string;
  claimHash: string;
  outcome: string;
  rationale: string;
  references: Ref[];
  supported: string[];
  unresolved: string[];
  requiresReview: boolean;
  reviews: Array<{ outcome: string; rationale: string }>;
};
type Run = {
  id: string;
  inputHash: string;
  current: boolean;
  totalAssessments?: number;
  next?: number | null;
  payload: {
    cutoff: string;
    claims: Claim[];
    originalClaims?: Claim[];
    records: RecordItem[];
    sourceHash: string;
  };
  assessments: Assessment[];
};
type Brief = {
  id: string;
  seriesId: string;
  version: number;
  contentHash: string;
  status: string;
  current: boolean;
  approvedAt: string | null;
  payload: {
    title: string;
    clientId: string | null;
    claims: Claim[];
    records: RecordItem[];
    sourceHash: string;
    cutoff: string;
    correction?: { priorId: string };
  };
};
type Check = {
  billId?: string;
  state?: string;
  checkedAt?: string;
  recordChecks?: Array<{
    kind: string;
    state: string;
    next_check_at: string | null;
    last_error: string | null;
  }>;
};
const labels: Record<string, string> = {
  supported: 'Supported',
  partially_supported: 'Partially supported',
  contradicted: 'Contradicted',
  not_addressed: 'Not addressed',
  pending_records: 'Pending records',
  needs_review: 'Needs review',
  capiro_analysis: 'Capiro analysis',
  bill_context_only: 'Bill context · event unconfirmed',
  explicit_event: 'Matched to this hearing',
  image_only_or_partial: 'Image only or partial',
  metadata_only: 'Metadata only',
};
const label = (s: string) => labels[s] ?? s.replaceAll('_', ' ');
const date = (value: string | null | undefined) =>
  value ? (value.length === 10 ? value : new Date(value).toLocaleString()) : 'Not supplied';
const toggle = (values: string[], v: string) =>
  values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
const safeUrl = (value: unknown) => {
  try {
    const u = new URL(String(value));
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};
const errorText = (error: unknown) => {
  const response = (error as { response?: { data?: { message?: unknown; code?: string } } })
    .response?.data;
  const code = typeof response?.message === 'string' ? response.message : response?.code;
  const messages: Record<string, string> = {
    SOURCE_CHANGED_START_NEW_RECONCILIATION:
      'Published records changed. Start a new reconciliation before generating a brief.',
    CURRENT_APPROVED_BRIEF_REQUIRED:
      'This brief needs current approval. Open the latest version and review its sources.',
    RECORD_JOB_PENDING_OR_BACKOFF:
      'This work is already running or waiting to retry. Its status appears in version history.',
    UNRESOLVED_ASSERTION_MUST_BE_REVIEWED_OR_OMITTED:
      'Review or omit unresolved factual assertions before approval. Describe uncertainty separately.',
    HEARING_EVENT_ASSOCIATION_REQUIRED:
      'A bill record alone cannot establish what happened in this hearing. Review the claim scope and its evidence.',
    RECORD_DELIVERY_CHANNEL_DISABLED: 'This channel is not enabled for published-record briefs.',
    CORRECTION_AUDIENCE_MUST_BE_AFFECTED_PRIOR_RECIPIENTS:
      'Select only eligible recipients of the affected prior version.',
    RECORD_PILOT_REQUIRES_1_TO_25_RECIPIENTS: 'Select between 1 and 25 eligible recipients.',
    FACT_REQUIRES_RECORD_REFERENCES: 'Every factual statement needs a published-record citation.',
    BRIEF_REQUIRES_REVIEWED_CLAIM_SELECTION:
      'Choose up to 100 statements in Reconciliation for this brief.',
    NARROW_DOCUMENT_SCOPE_REQUIRED:
      'Open published evidence and select the source series or passages to assess before starting a new reconciliation.',
    SOURCE_SNAPSHOT_REQUIRES_SELECTION:
      'This event exceeds the bounded evidence window. Open sources and choose the series or passages to assess.',
    PUBLISHED_RECORD_CHECK_REQUIRES_REFRESH:
      'The published sources need a fresh check before sending.',
  };
  return code && messages[code]
    ? messages[code]
    : 'This action is unavailable. Refresh to check current access, source status and the latest version.';
};
export function HearingPublishedRecordsPanel(props: {
  eventId: string;
  sessionId?: string;
  clientId?: string;
}) {
  const scope = useApiScope(),
    enabled = useIntelFeatureEnabled('legiwatch_published_records_v1');
  return enabled ? <RecordWorkspace key={`${scope}:${props.eventId}`} {...props} /> : null;
}
function RecordWorkspace({
  eventId,
  sessionId,
  clientId: initialClient,
}: {
  eventId: string;
  sessionId?: string;
  clientId?: string;
}) {
  const api = useApi(),
    scope = useApiScope(),
    briefsEnabled = useIntelFeatureEnabled('legiwatch_record_briefs_v1'),
    deliveryEnabled = useIntelFeatureEnabled('legiwatch_record_delivery_v1'),
    smsEnabled = useIntelFeatureEnabled('legiwatch_hearing_sms_v1');
  const base = `/intel-api/hearing-events/${encodeURIComponent(eventId)}/published-records`,
    params = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState(
      params.has('brief') ? 'brief' : params.has('reconciliation') ? 'reconciliation' : 'records',
    ),
    [offset, setOffset] = useState(0),
    [kind, setKind] = useState(''),
    [search, setSearch] = useState('');
  const [runId, setRunId] = useState(params.get('reconciliation') ?? ''),
    [briefId, setBriefId] = useState(params.get('brief') ?? ''),
    [publicationId, setPublicationId] = useState(params.get('publication') ?? '');
  const observationSession = sessionId ?? params.get('session') ?? '';
  const [clientId, setClientId] = useState(initialClient ?? params.get('client') ?? ''),
    [folderIds, setFolderIds] = useState<string[]>(
      params.get('folder') ? [params.get('folder')!] : [],
    );
  const [runOffset, setRunOffset] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reviewed, setReviewed] = useState(false);
  const [sourceSelections, setSourceSelections] = useState<
    Array<{ identity: string; locators: string[] | null }>
  >([]);
  const [briefClaimIds, setBriefClaimIds] = useState<string[]>([]);
  const [editClaims, setEditClaims] = useState<Claim[]>([]),
    [editReason, setEditReason] = useState('');
  const [reviewTarget, setReviewTarget] = useState<Assessment | null>(null),
    [reviewOutcome, setReviewOutcome] = useState('needs_review'),
    [reviewRationale, setReviewRationale] = useState(''),
    [reviewRefs, setReviewRefs] = useState<Ref[]>([]);
  const [recordId, setRecordId] = useState(''),
    [locator, setLocator] = useState(''),
    [citationTarget, setCitationTarget] = useState('');
  const dialog = useRef<HTMLDialogElement>(null),
    [channel, setChannel] = useState('email'),
    [contactIds, setContactIds] = useState<string[]>([]);
  const [consentIds, setConsentIds] = useState<string[]>([]),
    [deliveryOffset, setDeliveryOffset] = useState(0);
  const [preview, setPreview] = useState<{
    approvalHash: string;
    composition: {
      subject: string;
      plainText: string;
      smsText?: string | null;
      recipients: Array<{ name: string; email: string; phone?: string }>;
    };
    unreachable: Array<{ reason: string }>;
  } | null>(null);
  const records = useQuery({
    queryKey: ['hearing-records', scope, eventId, offset],
    queryFn: async () =>
      (
        await api.get<{
          records: RecordItem[];
          next: number | null;
          checks: Check[];
          missing: string[];
        }>(`${base}?offset=${offset}`)
      ).data,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['hearing-record-history', scope, eventId, historyOffset],
    queryFn: async () =>
      (
        await api.get<{
          next?: number | null;
          runs: Array<{ id: string; createdAt: string }>;
          briefs: Array<{ id: string; version: number; createdAt: string }>;
          jobs: Array<{ id: string; kind: string; state: string; nextAttemptAt: string }>;
        }>(base + '/history?offset=' + historyOffset)
      ).data,
    retry: false,
    refetchInterval: busy ? 10000 : false,
  });
  const run = useQuery({
    queryKey: ['hearing-record-run', scope, eventId, runId, runOffset],
    queryFn: async () =>
      (
        await api.get<Run>(
          base + '/reconciliations/' + encodeURIComponent(runId) + '?offset=' + runOffset,
        )
      ).data,
    enabled: !!runId,
    retry: false,
  });
  const brief = useQuery({
    queryKey: ['hearing-record-brief', scope, eventId, briefId],
    queryFn: async () =>
      (await api.get<Brief>(base + '/briefs/' + encodeURIComponent(briefId))).data,
    enabled: !!briefId,
    retry: false,
  });
  const evidence = useQuery({
    queryKey: ['hearing-record-evidence', scope, eventId, recordId, locator],
    queryFn: async () =>
      (
        await api.get<{
          record: RecordItem;
          locators?: Array<{ locator: string; characters: number }>;
          locator: string | null;
          text: string | null;
        }>(
          base +
            '/evidence/' +
            encodeURIComponent(recordId) +
            (locator ? '?locator=' + encodeURIComponent(locator) : ''),
        )
      ).data,
    enabled: !!recordId,
    retry: false,
  });
  const clients = useQuery({
    queryKey: ['record-brief-clients', scope],
    queryFn: async () => (await api.get<Array<{ id: string; name: string }>>('/api/clients')).data,
    enabled: briefsEnabled,
    retry: false,
  });
  const folders = useQuery({
    queryKey: ['record-brief-folders', scope],
    queryFn: async () =>
      (
        await api.get<
          Array<{ id: string; name: string; clientId: string | null; archived: boolean }>
        >('/intel-api/legiwatch/folders')
      ).data,
    enabled: briefsEnabled,
    retry: false,
  });
  const publications = useQuery({
    queryKey: ['record-observations', scope, observationSession],
    queryFn: async () =>
      (
        await api.get<Array<{ id: string; version: number; payload: { title: string } }>>(
          `/intel-api/hearings/${encodeURIComponent(observationSession)}/publications?kind=hearing_recap`,
        )
      ).data,
    enabled: !!observationSession,
    retry: false,
  });
  const directory = useQuery({
    queryKey: ['record-brief-recipients', scope],
    queryFn: async () =>
      (
        await api.get<{
          contacts: Array<{
            id: string;
            name: string;
            email: string;
            active: boolean;
            verified: boolean;
            optedOut: boolean;
          }>;
        }>('/intel-api/legiwatch/reports/recipients')
      ).data,
    enabled: deliveryEnabled,
    retry: false,
  });
  const deliveryClient = brief.data?.payload.clientId;
  const sms = useQuery({
    queryKey: ['record-sms-settings', scope, deliveryClient],
    queryFn: async () =>
      (
        await api.get<{
          consents: Array<{
            id: string;
            phone: string;
            contactId: string;
            revokedAt: string | null;
          }>;
          consentText: string;
          consentVersion: string;
          providerConfigured: boolean;
          dispatchEnabled: boolean;
        }>(`/intel-api/clients/${encodeURIComponent(deliveryClient!)}/hearing-sms/records`)
      ).data,
    enabled: deliveryEnabled && smsEnabled && !!deliveryClient,
    retry: false,
  });
  const deliveries = useQuery({
    queryKey: ['record-deliveries', scope, eventId, briefId, deliveryOffset],
    queryFn: async () =>
      (
        await api.get<{
          items: Array<{
            id: string;
            deliveryId: string;
            channel: string;
            state: string;
            name: string;
            destination: string;
            error: string | null;
          }>;
          next: number | null;
        }>(`${base}/briefs/${briefId}/deliveries?offset=${deliveryOffset}`)
      ).data,
    enabled: deliveryEnabled && !!briefId,
    retry: false,
    refetchInterval: 30000,
  });
  const priorAudience = useQuery({
    queryKey: ['record-prior-audience', scope, eventId, briefId],
    queryFn: async () =>
      (
        await api.get<
          Array<{
            id: string;
            channel: string;
            state: string;
            recipient: { name?: string; email?: string; phone?: string };
          }>
        >(`${base}/briefs/${briefId}/prior-audience`)
      ).data,
    enabled: deliveryEnabled && !!brief.data?.payload.correction,
    retry: false,
  });
  useEffect(() => {
    setEditClaims(brief.data?.payload.claims ?? []);
    setReviewed(false);
    setPreview(null);
  }, [brief.data]);
  useEffect(() => {
    if (recordId && !dialog.current?.open) dialog.current?.showModal();
  }, [recordId]);
  useEffect(() => {
    setPreview(null);
  }, [channel, contactIds, consentIds]);
  useEffect(() => {
    setDeliveryOffset(0);
    setConsentIds([]);
    setContactIds([]);
  }, [briefId]);
  useEffect(() => {
    setRunOffset(0);
    setReviewTarget(null);
    setBriefClaimIds([]);
  }, [runId]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await history.refetch();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const link = (key: string, value: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(key, value);
    url.hash = 'published-records';
    window.history.replaceState(null, '', url);
  };
  const start = () =>
    act(async () => {
      const result = (
        await api.post<Run>(base + '/reconciliations', {
          sourceSelections,
          ...(publicationId ? { publicationId, sessionId: observationSession } : {}),
        })
      ).data;
      setRunId(result.id);
      link('reconciliation', result.id);
      setTab(publicationId ? 'reconciliation' : 'brief');
      setNotice('Evidence snapshot saved. The earlier unofficial recap remains unchanged.');
    });
  const openEvidence = (id: string, loc = '') => {
    setRecordId(id);
    setLocator(loc);
  };
  const refs = (values: Ref[]) => (
    <div className="hr-citations">
      {values.map((r) => (
        <button key={`${r.id}:${r.locator}`} onClick={() => openEvidence(r.id, r.locator)}>
          Source · {r.locator}
        </button>
      ))}
    </div>
  );
  const selection = contactIds.map((id) => ({ kind: 'contact', id, role: 'to' }));
  const exportOrSave = (save: boolean) =>
    act(async () => {
      if (!brief.data?.payload.clientId) return;
      const path = `/api/intelligence/clients/${encodeURIComponent(brief.data.payload.clientId)}/record-briefs/approved${save ? '' : '/export'}`;
      const response = await api.post(
        path,
        { eventId, briefId: brief.data.id, contentHash: brief.data.contentHash },
        save ? {} : { responseType: 'blob' },
      );
      if (save) setNotice('Approved version saved to Documents.');
      else {
        const url = URL.createObjectURL(response.data as Blob),
          a = document.createElement('a');
        a.href = url;
        a.download = `Capiro published-record brief v${brief.data.version}.docx`;
        a.click();
        URL.revokeObjectURL(url);
        setNotice('Approved DOCX exported.');
      }
    });
  return (
    <section
      className="hearing-records"
      id="published-records"
      aria-label="Published records and briefs"
    >
      <header>
        <div>
          <p className="hr-eyebrow">LEGIWATCH / PUBLISHED EVIDENCE</p>
          <h2>Published records</h2>
          <p>
            Compare the captured account with published evidence, then review a separate Capiro
            brief.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await records.refetch();
              await history.refetch();
              await run.refetch();
              await brief.refetch();
              setNotice('Loaded current stored source checks and versions.');
            })
          }
        >
          Reload records
        </button>
      </header>
      <nav aria-label="Published-record workspace">
        {['records', 'reconciliation', ...(briefsEnabled ? ['brief'] : []), 'history'].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === 'brief' ? 'Brief based on published records' : label(t)}
          </button>
        ))}
      </nav>
      {error ? (
        <p className="hr-callout hr-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="hr-callout" role="status">
          {notice}
        </p>
      ) : null}
      {busy ? <p role="status">Saving or generating the selected version…</p> : null}
      {records.isError ? (
        <p role="alert" className="hr-callout hr-error">
          Published records are unavailable for this event or your current access.{' '}
          <button onClick={() => void records.refetch()}>Try again</button>
        </p>
      ) : null}
      {(run.data && !run.data.current) || (brief.data && !brief.data.current) ? (
        <p className="hr-callout hr-warning">
          Sources or context changed. This version is superseded. Start a new reconciliation and
          review the resulting brief.
        </p>
      ) : null}
      {tab === 'records' ? (
        <>
          {sourceSelections.length ? (
            <div className="hr-callout">
              <p>
                Next reconciliation is limited to these selected source series or passages. Other
                evidence is outside its scope.
              </p>
              {sourceSelections.map((s) => (
                <p key={s.identity}>
                  {s.identity} · {s.locators?.join(', ') ?? 'All available versions and passages'}
                  <button
                    onClick={() =>
                      setSourceSelections(sourceSelections.filter((x) => x.identity !== s.identity))
                    }
                  >
                    Remove source selection
                  </button>
                </p>
              ))}
              <button onClick={() => setSourceSelections([])}>Use all available records</button>
            </div>
          ) : (
            <p>
              Using all available records. For a large document, open its evidence and select the
              passages to assess.
            </p>
          )}
          <div className="hr-toolbar">
            <label>
              Find on this page
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Bill, record or source"
              />
            </label>
            <label>
              Record type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All types</option>
                {['action', 'vote', 'amendment', 'document', 'official_transcript'].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="hr-callout">
            {records.data?.missing?.[0] ??
              'Coverage depends on the publisher. Missing records do not establish that no action occurred.'}
          </div>
          {records.isPending ? <p role="status">Loading published records…</p> : null}
          <div className="hr-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Published record</th>
                  <th>Source and scope</th>
                  <th>Record date / observed</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {records.data?.records
                  .filter(
                    (r) =>
                      (!kind || r.kind === kind) &&
                      JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button className="hr-link" onClick={() => openEvidence(r.id)}>
                          {String(
                            r.evidence.title ??
                              r.evidence.motion ??
                              r.evidence.text ??
                              label(r.kind),
                          ).slice(0, 180)}
                        </button>
                        <small>
                          {label(r.kind)}{' '}
                          {r.billId ? (
                            <a href={'/bills/' + encodeURIComponent(r.billId)}>{r.billId}</a>
                          ) : null}
                        </small>
                      </td>
                      <td>
                        {String(r.evidence.publisher ?? r.evidence.provider ?? 'Published source')}
                        <small>{label(r.association)}</small>
                        {r.evidence.extractionState ? (
                          <span className="hr-badge">
                            {label(String(r.evidence.extractionState))}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {date(r.date)}
                        <small>Observed {date(r.observedAt)}</small>
                      </td>
                      <td>
                        <code title={r.hash}>{r.hash.slice(0, 10)}</code>
                        <button onClick={() => openEvidence(r.id)}>View evidence</button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {records.data?.records.length === 0 ? (
            <p className="hr-callout">
              No published records are linked yet. This says nothing about whether a vote or other
              action occurred.
            </p>
          ) : null}
          <div className="hr-toolbar">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
              Previous records
            </button>
            <span>Page {Math.floor(offset / 50) + 1}</span>
            <button
              disabled={records.data?.next == null}
              onClick={() => setOffset(records.data!.next!)}
            >
              Next records
            </button>
          </div>
          <details>
            <summary>Source coverage and next checks</summary>
            {records.data?.checks.map((c, i) => (
              <div key={c.billId ?? i} className="hr-check">
                <strong>{c.billId ?? 'Published transcript'}</strong> ·{' '}
                {label(c.state ?? 'unknown')}
                <p>Last successful check: {date(c.checkedAt)}</p>
                {c.recordChecks?.map((s, j) => (
                  <p key={j}>
                    {label(s.kind)}: {label(s.state)} · Next check {date(s.next_check_at)}
                    {s.last_error ? ' · Retrieval needs attention' : ''}
                  </p>
                ))}
              </div>
            ))}
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.post(base + '/refresh', {});
                  await records.refetch();
                  setNotice(
                    'A bounded source check was requested. Existing source workers own the refresh; missing records remain unresolved.',
                  );
                })
              }
            >
              Request a published-source check
            </button>
          </details>
          <div className="hr-toolbar">
            {observationSession ? (
              <label>
                Earlier unofficial recap
                <select value={publicationId} onChange={(e) => setPublicationId(e.target.value)}>
                  <option value="">Use published records only</option>
                  {publications.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      v{p.version} · {p.payload.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p>A recording is optional. Create a brief from the available published records.</p>
            )}
            <button
              className="hr-primary"
              disabled={busy || !records.data?.records.length}
              onClick={() => void start()}
            >
              {publicationId ? 'Reconcile this recap' : 'Prepare record-based brief'}
            </button>
          </div>
        </>
      ) : null}
      {tab === 'reconciliation' ? (
        <>
          <h3>What was reported · what the record supports</h3>
          <p>
            Each statement has its own assessment. Review identity, motion and version before
            accepting an interpretation.
          </p>
          {!runId ? (
            <p className="hr-callout">
              Choose an accessible unofficial recap in Published records, or open a reconciliation
              from version history.
            </p>
          ) : null}
          {run.isError ? (
            <p role="alert">
              The selected reconciliation is unavailable. Check current permission and its
              observation version.
            </p>
          ) : null}
          {run.data?.assessments.map((a) => {
            const claim = run.data.payload.claims.find((c) => c.id === a.claimId),
              review = a.reviews.at(-1),
              parent = run.data.payload.originalClaims?.find((c) => c.id === claim?.parentClaimId);
            return (
              <article key={a.id} className="hr-comparison">
                <div>
                  <small>REPORTED STATEMENT</small>
                  <label className="hr-inline">
                    <input
                      type="checkbox"
                      checked={briefClaimIds.includes(a.claimId)}
                      disabled={!briefClaimIds.includes(a.claimId) && briefClaimIds.length >= 100}
                      onChange={() => setBriefClaimIds(toggle(briefClaimIds, a.claimId))}
                    />
                    Include in selected brief scope
                  </label>
                  <p>{claim?.text}</p>
                  {parent ? (
                    <details>
                      <summary>Preserved original statement</summary>
                      <p>{parent.text}</p>
                    </details>
                  ) : null}
                  {a.unresolved.length ? (
                    <p className="hr-muted">Unresolved: {a.unresolved.join(' ')}</p>
                  ) : null}
                </div>
                <div>
                  <small>PUBLISHED EVIDENCE</small>
                  {refs(a.references)}
                  <p>{review?.rationale ?? a.rationale}</p>
                </div>
                <div>
                  <span className={'hr-badge hr-' + (review?.outcome ?? a.outcome)}>
                    {label(review?.outcome ?? a.outcome)}
                  </span>
                  <p>
                    {review
                      ? 'Staff review recorded'
                      : a.requiresReview
                        ? 'Staff review required'
                        : 'Exact structured comparison'}
                  </p>
                  <button
                    disabled={!run.data.current || busy}
                    onClick={() => {
                      setReviewTarget(a);
                      setReviewOutcome(review?.outcome ?? a.outcome);
                      setReviewRationale(review?.rationale ?? a.rationale);
                      setReviewRefs(a.references);
                    }}
                  >
                    Review assessment
                  </button>
                </div>
              </article>
            );
          })}
          {run.data ? (
            <div className="hr-toolbar">
              <button
                disabled={runOffset === 0}
                onClick={() => {
                  setRunOffset(Math.max(0, runOffset - 50));
                  setReviewTarget(null);
                }}
              >
                Previous statements
              </button>
              <span>
                {run.data.totalAssessments ?? run.data.assessments.length} statements · Page{' '}
                {Math.floor(runOffset / 50) + 1}
              </span>
              <button
                disabled={run.data.next == null}
                onClick={() => {
                  setRunOffset(run.data!.next!);
                  setReviewTarget(null);
                }}
              >
                Next statements
              </button>
            </div>
          ) : null}
          {reviewTarget ? (
            <section className="hr-review">
              <h3>Review this statement</h3>
              <label>
                Assessment
                <select value={reviewOutcome} onChange={(e) => setReviewOutcome(e.target.value)}>
                  {Object.keys(labels)
                    .filter((k) =>
                      [
                        'supported',
                        'partially_supported',
                        'contradicted',
                        'not_addressed',
                        'pending_records',
                        'needs_review',
                        'capiro_analysis',
                      ].includes(k),
                    )
                    .map((k) => (
                      <option key={k} value={k}>
                        {label(k)}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Rationale
                <textarea
                  value={reviewRationale}
                  onChange={(e) => setReviewRationale(e.target.value)}
                />
              </label>
              <p>{reviewRefs.length} exact citation(s) selected.</p>
              {refs(reviewRefs)}
              <p>
                Open a record to add its exact locator. Saving attests that you checked the subject,
                body, motion and version.
              </p>
              <button
                disabled={busy || !reviewRationale.trim()}
                onClick={() =>
                  void act(async () => {
                    await api.post(
                      `${base}/reconciliations/${runId}/assessments/${reviewTarget.id}/reviews`,
                      {
                        claimHash: reviewTarget.claimHash,
                        inputHash: run.data!.inputHash,
                        outcome: reviewOutcome,
                        rationale: reviewRationale,
                        references: reviewRefs,
                        attestIdentity: true,
                      },
                    );
                    setReviewTarget(null);
                    await run.refetch();
                    setNotice('Review recorded without changing source evidence.');
                  })
                }
              >
                Save assessment review
              </button>
            </section>
          ) : null}
        </>
      ) : null}
      {tab === 'brief' ? (
        <>
          <h3>Brief based on published records</h3>
          <p>
            Capiro analysis with source-linked factual claims. The earlier unofficial recap remains
            a separate publication.
          </p>
          <div className="hr-toolbar">
            <label>
              Client
              <select
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setFolderIds([]);
                }}
              >
                <option value="">Internal review · no client</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="hr-primary"
              disabled={busy || !run.data?.current}
              onClick={() =>
                void act(async () => {
                  const value = (
                    await api.post<Brief>(`${base}/reconciliations/${runId}/briefs`, {
                      clientId: clientId || null,
                      folderIds,
                      ...(briefClaimIds.length ? { claimIds: briefClaimIds } : {}),
                    })
                  ).data;
                  setBriefId(value.id);
                  link('brief', value.id);
                  setNotice(
                    'Draft generated. Review every factual claim and source before approval.',
                  );
                })
              }
            >
              Generate draft
            </button>
          </div>
          {briefClaimIds.length ? (
            <p className="hr-callout">
              Brief scope: {briefClaimIds.length} selected reconciled statements.{' '}
              <button onClick={() => setBriefClaimIds([])}>Clear statement selection</button>
            </p>
          ) : (
            <p>
              Using all reconciled statements, up to 100. For a larger comparison, select statements
              in Reconciliation.
            </p>
          )}
          <fieldset>
            <legend>Client folders</legend>
            {folders.data
              ?.filter((f) => !f.archived && f.clientId === (clientId || null))
              .map((f) => (
                <label key={f.id} className="hr-inline">
                  <input
                    type="checkbox"
                    checked={folderIds.includes(f.id)}
                    onChange={() => setFolderIds(toggle(folderIds, f.id))}
                  />
                  {f.name}
                </label>
              ))}
          </fieldset>
          {!runId ? (
            <p className="hr-callout">Prepare an evidence snapshot from Published records first.</p>
          ) : null}
          {brief.isError ? (
            <p role="alert">
              This brief is unavailable with your current client, folder or observation access.
            </p>
          ) : null}
          {brief.data ? (
            <>
              <div className="hr-brief-head">
                <h3>{brief.data.payload.title}</h3>
                <span className="hr-badge">
                  v{brief.data.version} · {label(brief.data.status)}
                </span>
                <p>Evidence cutoff {date(brief.data.payload.cutoff)} · Authored by Capiro</p>
              </div>
              {editClaims.map((c, i) => (
                <article key={c.id} className="hr-claim">
                  <div className="hr-toolbar">
                    <strong>{label(c.section)}</strong>
                    <span>{c.kind === 'analysis' ? 'Capiro analysis' : 'Factual claim'}</span>
                    <button
                      onClick={() => {
                        setEditClaims(editClaims.filter((x) => x.id !== c.id));
                        setReviewed(false);
                      }}
                    >
                      Omit statement
                    </button>
                  </div>
                  <label>
                    Statement
                    <textarea
                      value={c.text}
                      disabled={!brief.data!.current}
                      onChange={(e) => {
                        setEditClaims(
                          editClaims.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                        );
                        setReviewed(false);
                      }}
                    />
                  </label>
                  {refs(c.references)}
                  <button
                    onClick={() => {
                      setCitationTarget(c.id);
                      setTab('records');
                    }}
                  >
                    Choose published citation
                  </button>
                  <div className="hr-toolbar">
                    <label>
                      Claim type
                      <select
                        value={c.kind}
                        onChange={(e) =>
                          setEditClaims(
                            editClaims.map((x, j) =>
                              j === i ? { ...x, kind: e.target.value as Claim['kind'] } : x,
                            ),
                          )
                        }
                      >
                        <option value="fact">Factual claim</option>
                        <option value="quote">Exact source quote</option>
                        <option value="analysis">Capiro analysis / stated uncertainty</option>
                      </select>
                    </label>
                    <label>
                      Scope
                      <select
                        value={c.scope}
                        onChange={(e) =>
                          setEditClaims(
                            editClaims.map((x, j) =>
                              j === i ? { ...x, scope: e.target.value as Claim['scope'] } : x,
                            ),
                          )
                        }
                      >
                        <option value="bill_record">Bill record</option>
                        <option value="hearing_event">This hearing event</option>
                      </select>
                    </label>
                    <label>
                      Assessment
                      <select
                        value={c.outcome}
                        onChange={(e) =>
                          setEditClaims(
                            editClaims.map((x, j) =>
                              j === i ? { ...x, outcome: e.target.value } : x,
                            ),
                          )
                        }
                      >
                        {[
                          'supported',
                          'needs_review',
                          'partially_supported',
                          'contradicted',
                          'not_addressed',
                          'pending_records',
                          'capiro_analysis',
                        ].map((o) => (
                          <option key={o} value={o}>
                            {label(o)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    Review rationale
                    <textarea
                      value={c.rationale}
                      onChange={(e) =>
                        setEditClaims(
                          editClaims.map((x, j) =>
                            j === i ? { ...x, rationale: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </label>
                </article>
              ))}
              <label>
                Reason for this revision
                <input value={editReason} onChange={(e) => setEditReason(e.target.value)} />
              </label>
              <button
                disabled={busy || !brief.data.current || !editReason.trim()}
                onClick={() =>
                  void act(async () => {
                    const value = (
                      await api.post<Brief>(base + '/briefs/' + briefId + '/versions', {
                        contentHash: brief.data!.contentHash,
                        claims: editClaims,
                        rationale: editReason,
                      })
                    ).data;
                    setBriefId(value.id);
                    link('brief', value.id);
                    setEditReason('');
                    setNotice(
                      'New draft version saved. Approval must be recorded for this version.',
                    );
                  })
                }
              >
                Save new draft version
              </button>
              <div className="hr-review">
                <label className="hr-inline">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed the saved version, its factual support, source scope and stated
                  uncertainties.
                </label>
                <button
                  className="hr-primary"
                  disabled={
                    busy ||
                    !reviewed ||
                    !brief.data.current ||
                    JSON.stringify(editClaims) !== JSON.stringify(brief.data.payload.claims)
                  }
                  onClick={() =>
                    void act(async () => {
                      await api.post(base + '/briefs/' + briefId + '/approve', {
                        contentHash: brief.data!.contentHash,
                        attestSupported: true,
                      });
                      await brief.refetch();
                      setNotice('Exact brief version reviewed and approved.');
                    })
                  }
                >
                  Approve saved version
                </button>
              </div>
              <div className="hr-toolbar">
                <button
                  disabled={
                    busy ||
                    !brief.data.approvedAt ||
                    !brief.data.current ||
                    !brief.data.payload.clientId
                  }
                  onClick={() => void exportOrSave(true)}
                >
                  Save to Documents
                </button>
                <button
                  disabled={
                    busy ||
                    !brief.data.approvedAt ||
                    !brief.data.current ||
                    !brief.data.payload.clientId
                  }
                  onClick={() => void exportOrSave(false)}
                >
                  Export approved DOCX
                </button>
              </div>
              {brief.data.current ? (
                <HearingRecordCorrectionReview
                  key={briefId}
                  base={base}
                  briefId={briefId}
                  contentHash={brief.data.contentHash}
                  claims={brief.data.payload.claims}
                  priorBriefs={history.data?.briefs ?? []}
                  sessionId={observationSession}
                  publicationId={publicationId}
                  busy={busy}
                  act={act}
                  onSaved={(id) => {
                    setBriefId(id);
                    link('brief', id);
                    setNotice(
                      'Correction draft saved. Review the new version before choosing eligible prior recipients.',
                    );
                  }}
                />
              ) : null}
              {brief.data.payload.correction ? (
                <p className="hr-callout hr-warning">
                  Correction / follow-up to exact earlier version{' '}
                  {brief.data.payload.correction.priorId}. Delivery is limited to eligible
                  recipients affected by that version.
                </p>
              ) : null}
              {deliveryEnabled && brief.data.approvedAt ? (
                <section className="hr-review">
                  <h3>Review client delivery</h3>
                  <label>
                    Channel
                    <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                      <option value="email">Email</option>
                      <option value="in_app">My LegiWatch inbox</option>
                      {smsEnabled && deliveryClient ? <option value="sms">SMS</option> : null}
                    </select>
                  </label>
                  {channel === 'email' ? (
                    <fieldset>
                      <legend>Eligible email recipients</legend>
                      {directory.data?.contacts
                        .filter((c) => c.active && c.verified && !c.optedOut && c.email)
                        .map((c) => (
                          <label className="hr-inline" key={c.id}>
                            <input
                              type="checkbox"
                              checked={contactIds.includes(c.id)}
                              onChange={() => setContactIds(toggle(contactIds, c.id))}
                            />
                            {c.name} · {c.email}
                          </label>
                        ))}
                      {directory.data?.contacts.filter(
                        (c) => c.active && c.verified && !c.optedOut && c.email,
                      ).length === 0 ? (
                        <p>
                          No eligible recipients. Review the existing directory and consent
                          settings.
                        </p>
                      ) : null}
                    </fieldset>
                  ) : channel === 'sms' ? (
                    <fieldset>
                      <legend>Verified consent for published-record briefs</legend>
                      {sms.data?.consents
                        .filter((c) => !c.revokedAt)
                        .map((c) => (
                          <label key={c.id} className="hr-inline">
                            <input
                              type="checkbox"
                              checked={consentIds.includes(c.id)}
                              onChange={() => setConsentIds(toggle(consentIds, c.id))}
                            />
                            ••• {c.phone.slice(-4)}
                          </label>
                        ))}
                      {!sms.data?.dispatchEnabled ? (
                        <p>SMS dispatch awaits provider qualification.</p>
                      ) : null}
                      {deliveryClient ? (
                        <HearingSmsSetup
                          purpose="hearing_records"
                          clientId={deliveryClient}
                          contacts={directory.data?.contacts ?? []}
                          settings={sms.data}
                          refresh={() => void sms.refetch()}
                        />
                      ) : null}
                    </fieldset>
                  ) : (
                    <p>Visible only in your own LegiWatch inbox.</p>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        setPreview(
                          (
                            await api.post(base + '/briefs/' + briefId + '/delivery-preview', {
                              channel,
                              selection,
                              consentIds,
                            })
                          ).data,
                        ),
                      )
                    }
                  >
                    Preview exact message and audience
                  </button>
                  {preview ? (
                    <>
                      <h4>{preview.composition.subject}</h4>
                      <p>
                        {preview.composition.recipients
                          .map(
                            (r) => r.name + ' ' + (r.phone ? '••• ' + r.phone.slice(-4) : r.email),
                          )
                          .join(', ')}
                      </p>
                      <pre className="hr-document">
                        {preview.composition.smsText ?? preview.composition.plainText}
                      </pre>
                      {preview.unreachable.map((r, i) => (
                        <p key={i}>{r.reason}</p>
                      ))}
                      <button
                        className="hr-primary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api.post(base + '/briefs/' + briefId + '/deliveries', {
                              channel,
                              selection,
                              consentIds,
                              approvalHash: preview.approvalHash,
                            });
                            setPreview(null);
                            await deliveries.refetch();
                            setNotice(
                              'Approved delivery queued. Provider acceptance and delivery are tracked separately.',
                            );
                          })
                        }
                      >
                        Approve audience and queue delivery
                      </button>
                    </>
                  ) : null}
                </section>
              ) : null}
              {brief.data.payload.correction ? (
                <details>
                  <summary>
                    Affected earlier audience · {priorAudience.data?.length ?? 0} accepted,
                    delivered or uncertain
                  </summary>
                  {priorAudience.isError ? <p>Earlier recipient status is unavailable.</p> : null}
                  {priorAudience.data?.map((r) => (
                    <p key={r.id}>
                      {r.recipient.name ?? 'Recipient'} · {r.channel} · {label(r.state)} ·{' '}
                      {r.recipient.phone ? '••• ' + r.recipient.phone.slice(-4) : r.recipient.email}
                    </p>
                  ))}
                  <p>
                    Provider acceptance and uncertain outcomes do not prove delivery. The preview
                    rechecks each selected destination and current consent.
                  </p>
                </details>
              ) : null}
              {deliveryEnabled ? (
                <details>
                  <summary>Delivery status for this exact version</summary>
                  {deliveries.isError ? <p>Delivery history is unavailable.</p> : null}
                  {deliveries.data?.items.map((r) => (
                    <p key={r.id}>
                      {r.name} · {r.destination} · {r.channel} · {label(r.state)}
                      {r.error ? ' · ' + label(r.error) : ''}
                    </p>
                  ))}
                  {deliveries.data?.items.length === 0 ? (
                    <p>No delivery attempts for this version.</p>
                  ) : null}
                  <div className="hr-toolbar">
                    <button
                      disabled={deliveryOffset === 0}
                      onClick={() => setDeliveryOffset(Math.max(0, deliveryOffset - 50))}
                    >
                      Previous deliveries
                    </button>
                    <button
                      disabled={deliveries.data?.next == null}
                      onClick={() => setDeliveryOffset(deliveries.data!.next!)}
                    >
                      Next deliveries
                    </button>
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {tab === 'history' ? (
        <>
          <h3>Preserved versions</h3>
          <p>Historical content remains unchanged. Current permissions apply when you open it.</p>
          <div className="hr-columns">
            <div>
              <h4>Reconciliations</h4>
              {history.data?.runs.map((r) => (
                <p key={r.id}>
                  <button
                    onClick={() => {
                      setRunId(r.id);
                      link('reconciliation', r.id);
                      setTab('reconciliation');
                    }}
                  >
                    {date(r.createdAt)}
                  </button>
                </p>
              ))}
            </div>
            <div>
              <h4>Briefs</h4>
              {history.data?.briefs.map((b) => (
                <p key={b.id}>
                  <button
                    onClick={() => {
                      setBriefId(b.id);
                      link('brief', b.id);
                      setTab('brief');
                    }}
                  >
                    Version {b.version} · {date(b.createdAt)}
                  </button>
                </p>
              ))}
            </div>
            <div>
              <h4>Processing</h4>
              {history.data?.jobs.map((j) => (
                <p key={j.id}>
                  {label(j.kind)} · {label(j.state)}
                  {j.state === 'failed' ? ' · Retry after ' + date(j.nextAttemptAt) : ''}
                </p>
              ))}
            </div>
          </div>
          <div className="hr-toolbar">
            <button
              disabled={historyOffset === 0}
              onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))}
            >
              Previous history
            </button>
            <span>Page {Math.floor(historyOffset / 50) + 1}</span>
            <button
              disabled={history.data?.next == null}
              onClick={() => setHistoryOffset(history.data!.next!)}
            >
              Next history
            </button>
          </div>
        </>
      ) : null}
      <dialog
        ref={dialog}
        className="hr-evidence"
        onClose={() => {
          setRecordId('');
          setLocator('');
        }}
      >
        <header>
          <h3>Exact published evidence</h3>
          <button aria-label="Close evidence" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </header>
        {evidence.isPending ? <p role="status">Loading source version…</p> : null}
        {evidence.isError ? (
          <p role="alert">This source version or locator is unavailable.</p>
        ) : null}
        {evidence.data ? (
          <>
            <p>
              {label(evidence.data.record.kind)} · {label(evidence.data.record.association)}
            </p>
            <p>
              Record date {date(evidence.data.record.date)} · Observed{' '}
              {date(evidence.data.record.observedAt)}
            </p>
            <code className="hr-hash">{evidence.data.record.hash}</code>
            {safeUrl(evidence.data.record.evidence.url) ? (
              <p>
                <a
                  href={safeUrl(evidence.data.record.evidence.url)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open original source
                </a>
              </p>
            ) : (
              <p>No exact original-source link was supplied.</p>
            )}
            {evidence.data.locators ? (
              <label>
                Source locator
                <select
                  value={evidence.data.locator ?? ''}
                  onChange={(e) => setLocator(e.target.value)}
                >
                  {evidence.data.locators.map((l) => (
                    <option key={l.locator} value={l.locator}>
                      {l.locator}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p>{evidence.data.locator}</p>
            )}
            <div className="hr-toolbar">
              <button
                onClick={() => {
                  setSourceSelections([
                    ...sourceSelections.filter(
                      (s) => s.identity !== evidence.data!.record.identity,
                    ),
                    { identity: evidence.data!.record.identity, locators: null },
                  ]);
                  dialog.current?.close();
                }}
              >
                Use this source series for next reconciliation
              </button>
              {evidence.data.locator ? (
                <button
                  onClick={() => {
                    const identity = evidence.data!.record.identity,
                      locator = evidence.data!.locator!;
                    setSourceSelections([
                      ...sourceSelections.filter((s) => s.identity !== identity),
                      {
                        identity,
                        locators: [
                          ...new Set([
                            ...(sourceSelections.find((s) => s.identity === identity)?.locators ??
                              []),
                            locator,
                          ]),
                        ],
                      },
                    ]);
                    dialog.current?.close();
                  }}
                >
                  Use this passage for next reconciliation
                </button>
              ) : null}
            </div>
            <pre className="hr-document">
              {evidence.data.text ??
                'Metadata only. Document content is not available for factual citation.'}
            </pre>
            {(reviewTarget || citationTarget) && evidence.data.locator ? (
              <button
                onClick={() => {
                  const ref = {
                    id: evidence.data!.record.id,
                    hash: evidence.data!.record.hash,
                    locator: evidence.data!.locator!,
                  };
                  if (citationTarget) {
                    setEditClaims(
                      editClaims.map((c) =>
                        c.id === citationTarget
                          ? {
                              ...c,
                              references: [
                                ...c.references.filter(
                                  (r) => r.id !== ref.id || r.locator !== ref.locator,
                                ),
                                ref,
                              ],
                            }
                          : c,
                      ),
                    );
                    setTab('brief');
                    setCitationTarget('');
                  } else {
                    setReviewRefs([
                      ...reviewRefs.filter((r) => r.id !== ref.id || r.locator !== ref.locator),
                      ref,
                    ]);
                    setTab('reconciliation');
                  }
                  dialog.current?.close();
                }}
              >
                Use this exact citation
              </button>
            ) : null}
          </>
        ) : null}
      </dialog>
    </section>
  );
}
