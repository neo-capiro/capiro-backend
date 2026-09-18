import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PHASE8_FEATURES, compileNewsQuery } from '@capiro/shared';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { FOLDER_BASE, type Folder } from '../bills/folder-api.js';
import { useQuery } from '@tanstack/react-query';
import {
  EVIDENCE_BASE,
  useEvidence,
  sourceUrl,
  money,
  basketKey,
  addBasket,
  type Row,
} from './evidence-api.js';
import './evidence.css';
const option = (value: string, label = value) => ({ value, label });
const time = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : 'Date not stated');
export function EvidenceTab({ lane }: { lane: 'news' | 'budget' }) {
  const enabled = useIntelFeatureEnabled(PHASE8_FEATURES[lane]),
    apiScope = useApiScope(),
    [p] = useSearchParams();
  return enabled ? (
    <EvidenceView key={`${apiScope}:${p.get('client')}:${p.get('folder')}:${lane}`} lane={lane} />
  ) : (
    <p className="lw-evidence-empty">
      {lane === 'news' ? 'News monitoring' : 'Florida budget research'} is not enabled for this
      workspace.
    </p>
  );
}
function EvidenceView({ lane }: { lane: 'news' | 'budget' }) {
  const api = useApi(),
    scope = useApiScope(),
    qc = useQueryClient(),
    [p, setP] = useSearchParams(),
    client = p.get('client') ?? '',
    folder = p.get('folder') ?? '',
    view = p.get(lane + 'View') ?? (lane === 'news' ? 'articles' : 'projects');
  // Keep independent searches and pagination when moving between evidence views.
  // Upgrade old shared-q links in place before they can leak into another lane.
  const viewPrefix = lane + view.charAt(0).toUpperCase() + view.slice(1),
    queryKey = viewPrefix + 'Query',
    offsetKey = viewPrefix + 'Offset';
  useEffect(() => {
    if (!p.has('q') && !p.has('offset')) return;
    setP(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (next.has('q') && !next.has(queryKey)) next.set(queryKey, next.get('q')!);
        if (next.has('offset') && !next.has(offsetKey)) next.set(offsetKey, next.get('offset')!);
        next.delete('q');
        next.delete('offset');
        return next;
      },
      { replace: true },
    );
  }, [p, setP, queryKey, offsetKey]);
  const [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Row | null>(null),
    [editing, setEditing] = useState<Row | null>(null),
    [importReview, setImportReview] = useState<Row | null>(null),
    [comparison, setComparison] = useState<Row | null>(null),
    [left, setLeft] = useState(''),
    [right, setRight] = useState('');
  const set = (key: string, value: string) => {
    const n = new URLSearchParams(p);
    const scopedKey = key === 'q' ? queryKey : key === 'offset' ? offsetKey : key;
    value ? n.set(scopedKey, value) : n.delete(scopedKey);
    n.delete('q');
    n.delete('offset');
    if (key !== 'offset' && key !== lane + 'View') n.delete(offsetKey);
    if (key === 'folder') {
      for (const name of Array.from(n.keys())) {
        if (/^(news|budget).*Offset$/.test(name)) n.delete(name);
      }
    }
    setP(n);
  };
  const params = {
    clientId: client,
    folderId: folder,
    days: p.get('days') ?? '7',
    q: p.get(queryKey) ?? p.get('q') ?? '',
    monitorId: p.get('monitor') ?? '',
    publisher: p.get('publisher') ?? '',
    fiscalYear: p.get('fiscalYear') ?? '2026-27',
    sessionKey: p.get('budgetSession') ?? '',
    projectId: p.get('project') ?? '',
    offset: p.get(offsetKey) ?? p.get('offset') ?? '0',
  };
  const news = useEvidence<Row>('news', params, lane === 'news' && view === 'articles'),
    monitors = useEvidence<Row>('news/monitors', {}, lane === 'news'),
    personnel = useEvidence<Row>(
      'personnel',
      {
        clientId: client,
        folderId: folder,
        kind: view === 'registrations' ? 'registration' : 'change',
        offset: params.offset,
        q: params.q,
        branch: p.get('branch') ?? '',
        year: p.get('year') ?? String(new Date().getFullYear()),
      },
      lane === 'news' && ['personnel', 'registrations'].includes(view),
    ),
    budget = useEvidence<Row>('budget', params, lane === 'budget');
  // Comparison state belongs to the exact current scope: amount observations,
  // their source revisions, a pending request and its result are only valid for
  // the client/folder/fiscal year/session/project selection that produced them.
  // Any scope change clears them so a stale id or late response cannot surface
  // under a new selection; an unrelated refetch with an unchanged scope keeps
  // the valid result. The key is a JSON-encoded tuple, never a raw concatenation,
  // so two different scopes can never collide (e.g. ['ab','c'] vs ['a','bc']).
  const comparisonScope = JSON.stringify([
    client,
    folder,
    params.fiscalYear,
    params.sessionKey,
    params.projectId,
  ]);
  // The result and any in-flight request also belong to the chosen amount
  // observations themselves. Changing either selection after a successful compare
  // must drop the prior result, and a response that finishes after the selection
  // changed belongs to the former amounts and must not be applied. The operand
  // key is the selection state only — never live-fetched rows — so an unrelated
  // refetch that momentarily empties the amounts list cannot clear a valid result.
  const operandScope = JSON.stringify([left, right]);
  const comparisonScopeRef = useRef(comparisonScope);
  const operandScopeRef = useRef(operandScope);
  useEffect(() => {
    if (comparisonScopeRef.current !== comparisonScope) {
      comparisonScopeRef.current = comparisonScope;
      setLeft('');
      setRight('');
      setComparison(null);
      setError('');
    }
  }, [comparisonScope]);
  useEffect(() => {
    if (operandScopeRef.current === operandScope) return;
    operandScopeRef.current = operandScope;
    setComparison(null);
  }, [operandScope]);
  const folders = useQuery({
    queryKey: ['phase8-folders', scope, client],
    // The authenticated folder list already applies server scope semantics: an
    // All-clients view may still see accessible client-bound folders, and the
    // evidence endpoints resolve the folder's client when clientId is null.
    queryFn: async () =>
      (await api.get<Folder[]>(FOLDER_BASE)).data.filter(
        (f) => !f.archived && (client === '' || f.clientId === client),
      ),
  });
  const action = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError('');
    // An action started under one scope must not surface its error (or clear the
    // busy flag for a new action) after the scope has already changed underneath
    // it; that outcome belongs to the abandoned selection.
    const actionScope = comparisonScopeRef.current;
    try {
      await fn();
      setMessage(success);
      await qc.invalidateQueries({ queryKey: ['legiwatch-evidence', scope] });
    } catch (e) {
      if (comparisonScopeRef.current === actionScope)
        setError(
          e instanceof Error
            ? e.message
            : 'This action could not finish. Retry after reviewing the source and scope.',
        );
    } finally {
      setBusy(false);
    }
  };
  const save = (kind: string, row: Row) =>
    action(
      () =>
        api.post(`${EVIDENCE_BASE}/track`, {
          clientId: client || null,
          folderId: folder,
          kind,
          sourceId: row.id,
          expectedVersion: row.tracking_version ?? 0,
          removed: row.saved === true,
        }),
      row.saved ? 'Removed from this folder.' : 'Saved to this folder.',
    );
  const include = (kind: string, row: Row) => {
    if (!folder) {
      setError('Choose a folder before including evidence.');
      return;
    }
    addBasket(basketKey(scope, client, folder), {
      kind,
      id: row.id,
      revision: row.revision ?? row.content_hash,
      title: row.title ?? row.name,
    });
    setMessage('Included in the briefing selection. Open Reports to prepare the draft.');
  };
  const open = (kind: string, row: Row) =>
    action(async () => {
      setSelected({
        ...(
          await api.get<Row>(
            `${EVIDENCE_BASE}/source/${kind}/${encodeURIComponent(row.id)}?${new URLSearchParams({ clientId: client, folderId: folder })}`,
          )
        ).data,
        matchDefinition: kind === 'news' ? news.data?.matchDefinition : null,
      });
    }, '');
  const reportLink = `/legiwatch?${new URLSearchParams({ tab: 'digest', digestMode: 'bill_report', reportView: 'briefings', client, folder })}`;
  const loading =
    lane === 'budget'
      ? budget.isPending
      : view === 'articles'
        ? news.isPending
        : view === 'monitors'
          ? monitors.isPending
          : personnel.isPending;
  const failed =
    lane === 'budget'
      ? budget.isError
      : view === 'articles'
        ? news.isError
        : view === 'monitors'
          ? monitors.isError
          : personnel.isError;
  return (
    <section className="lw-evidence">
      <div className="lw-evidence-card">
        <div className="lw-evidence-toolbar">
          <CapiroSelect
            label="Folder"
            value={folder}
            options={[
              option('', 'Choose a folder'),
              ...(folders.data ?? []).map((f) => option(f.id, f.name)),
            ]}
            onChange={(e) => set('folder', e.target.value)}
          />
          <span className="lw-evidence-scope" role="status">
            Scope: {client ? 'selected client' : 'all accessible clients'}
            {folder ? ' · selected folder' : ''}
          </span>
          <Link to={reportLink}>Create a briefing in Reports →</Link>
        </div>
      </div>
      <nav className="lw-evidence-nav" aria-label={lane === 'news' ? 'News views' : 'Budget views'}>
        {(lane === 'news'
          ? [
              ['articles', 'Coverage'],
              ['monitors', 'Monitors & import'],
              ['personnel', 'Personnel changes'],
              ['registrations', 'Registrations'],
            ]
          : [
              ['projects', 'Projects'],
              ['documents', 'Documents & offers'],
              ['calendar', 'Calendar'],
              ['updates', 'Updates'],
            ]
        ).map(([id, label]) => (
          <button
            key={id}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => set(lane + 'View', id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {failed && (
        <p role="alert">
          This source view could not load.{' '}
          <button
            onClick={() => void qc.invalidateQueries({ queryKey: ['legiwatch-evidence', scope] })}
          >
            Retry
          </button>
        </p>
      )}
      {lane === 'news' && view === 'articles' && (
        <>
          <div className="lw-evidence-card">
            <div className="lw-evidence-toolbar">
              <CapiroInput
                label="Search retained coverage"
                value={params.q}
                onChange={(e) => set('q', e.target.value)}
              />
              <CapiroSelect
                label="Time window"
                value={params.days}
                options={[1, 3, 7, 14].map((n) => option(String(n), `${n} day${n === 1 ? '' : 's'}`))}
                onChange={(e) => set('days', e.target.value)}
              />
              <CapiroSelect
                label="Monitor"
                value={params.monitorId}
                options={[
                  option('', 'All retained articles'),
                  ...(monitors.data?.monitors ?? []).map((m: Row) =>
                    option(m.id, m.config.name ?? m.config.query),
                  ),
                ]}
                onChange={(e) => set('monitor', e.target.value)}
              />
              <CapiroInput
                label="Publisher"
                value={params.publisher}
                onChange={(e) => set('publisher', e.target.value)}
              />
              {(params.q || params.monitorId || params.publisher || params.days !== '7') && (
                <CapiroButton
                  size="compact"
                  onClick={() => {
                    for (const key of ['q', 'monitor', 'publisher', 'days', 'offset']) set(key, '');
                  }}
                >
                  Clear filters
                </CapiroButton>
              )}
            </div>
            <p className="lw-evidence-filter-summary">
              {params.q || params.monitorId || params.publisher || params.days !== '7'
                ? `Showing retained news for ${client ? 'the selected client' : 'all accessible clients'}.`
                : 'Showing all retained news in the last 7 days.'}
            </p>
          </div>
          <p className="lw-evidence-notice">
            {news.data?.coverageMessage ?? 'Loading source coverage…'} Sorted by publication date;
            unknown dates use first observation.
          </p>
          <div className="lw-evidence-table">
            <table>
              <thead>
                <tr>
                  <th>Story</th>
                  <th>Publisher / published</th>
                  <th>Evidence & folder</th>
                </tr>
              </thead>
              <tbody>
                {(news.data?.items ?? []).map((row: Row) => (
                  <tr key={row.id}>
                    <td>
                      <button className="lw-evidence-title" onClick={() => void open('news', row)}>
                        {row.title}
                      </button>
                      {row.summary && <p>{row.summary}</p>}
                      <small>
                        {row.body_complete ? 'Retained full text' : 'Available fields only'} ·{' '}
                        {row.saved ? 'Saved' : 'Not saved'}
                      </small>
                    </td>
                    <td>
                      {row.publisher}
                      <small>{time(row.published_at)}</small>
                    </td>
                    <td>
                      <div className="lw-evidence-actions">
                        {sourceUrl(row.source_url) && (
                          <a href={sourceUrl(row.source_url)!} target="_blank" rel="noreferrer">
                            Original
                          </a>
                        )}
                        <CapiroButton
                          size="compact"
                          disabled={!folder || busy}
                          onClick={() => void save('news', row)}
                        >
                          {row.saved ? 'Remove' : 'Save'}
                        </CapiroButton>
                        <CapiroButton size="compact" onClick={() => include('news', row)}>
                          Include in briefing
                        </CapiroButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !news.data?.items?.length && (
            <p className="lw-evidence-empty">
              No retained articles match this selection. Review source coverage before drawing
              conclusions about activity.
            </p>
          )}
          <div className="lw-evidence-actions">
            <CapiroButton
              size="compact"
              disabled={params.offset === '0'}
              onClick={() => set('offset', String(Math.max(0, Number(params.offset) - 50)))}
            >
              Previous
            </CapiroButton>
            <CapiroButton
              size="compact"
              disabled={news.data?.nextOffset == null}
              onClick={() => set('offset', String(news.data!.nextOffset))}
            >
              Next
            </CapiroButton>
          </div>
          <details>
            <summary>Publisher coverage ({news.data?.coverage?.length ?? 0})</summary>
            {(news.data?.coverage ?? []).map((r: Row) => (
              <p key={r.id}>
                {r.publisher} · {r.source_group} · {r.status}
              </p>
            ))}
          </details>
        </>
      )}
      {lane === 'news' && view === 'monitors' && (
        <>
          <p>
            Raw captured expressions remain separate from their Capiro interpretation. Recent
            matches do not activate a subscription.
          </p>
          <label className="lw-evidence-import">
            Stage reviewed capture JSON
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void action(async () => {
                    if (f.size > 1000000) throw Error('Import file exceeds 1 MB');
                    const payload = JSON.parse(await f.text());
                    setImportReview({
                      payload: {
                        ...payload,
                        requestKey: payload.requestKey ?? crypto.randomUUID(),
                      },
                      preview: (await api.post<Row>(`${EVIDENCE_BASE}/imports/preview`, payload))
                        .data,
                    });
                  }, 'Review the import preview before staging.');
              }}
            />
          </label>
          <div className="lw-evidence-table">
            <table>
              <thead>
                <tr>
                  <th>Imported expression</th>
                  <th>Capiro interpretation</th>
                  <th>State</th>
                  <th>Configuration</th>
                </tr>
              </thead>
              <tbody>
                {(monitors.data?.monitors ?? []).map((row: Row) => (
                  <tr key={row.id}>
                    <td>
                      {row.source.raw}
                      <small>Source {row.source.sourceId}</small>
                    </td>
                    <td>
                      {row.interpretation.interpretation ?? row.interpretation.reasons.join(', ')}
                      <small>Source scope {row.config.sources?.join(', ') || 'Not selected'}</small>
                    </td>
                    <td>
                      {row.state}
                      <small>Last complete window {time(row.checkpoint)}</small>
                      <small>{row.last_error}</small>
                    </td>
                    <td>
                      <CapiroButton size="compact" onClick={() => setEditing(row)}>
                        Review
                      </CapiroButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {lane === 'news' && ['personnel', 'registrations'].includes(view) && (
        <>
          <div className="lw-evidence-card">
            <div className="lw-evidence-toolbar">
              <CapiroInput
                label="Person, firm or principal"
                value={params.q}
                onChange={(e) => set('q', e.target.value)}
              />
              <CapiroInput
                label="Registration year"
                value={p.get('year') ?? String(new Date().getFullYear())}
                onChange={(e) => set('year', e.target.value)}
              />
              <CapiroSelect
                label="Branch"
                value={p.get('branch') ?? ''}
                options={[
                  option('', 'Both branches'),
                  option('legislative', 'Legislative'),
                  option('executive', 'Executive'),
                ]}
                onChange={(e) => set('branch', e.target.value)}
              />
            </div>
          </div>
          <p className="lw-evidence-notice">{personnel.data?.notice}</p>
          <div className="lw-evidence-table">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Change / registration</th>
                  <th>Source & dates</th>
                </tr>
              </thead>
              <tbody>
                {(personnel.data?.items ?? []).map((row: Row) => (
                  <tr key={row.id}>
                    <td>
                      {row.name}
                      {row.directory_url && (
                        <Link to={row.directory_url}>Open directory profile</Link>
                      )}
                      <small>
                        {row.canonical_person_id
                          ? 'Identity supported'
                          : 'Identity requires review'}
                      </small>
                    </td>
                    <td>
                      {row.new_role ?? row.principal}
                      <small>
                        {row.old_role ?? row.firm} · {row.branch} {row.registration_year}
                      </small>
                      <small>{row.confirmation}</small>
                    </td>
                    <td>
                      {sourceUrl(row.source_url) && (
                        <a href={sourceUrl(row.source_url)!} target="_blank" rel="noreferrer">
                          Original source
                        </a>
                      )}
                      <small>Effective: {row.effective_date ?? 'Not stated'}</small>
                      <small>Withdrawal: {row.withdrawal_date ?? 'Not stated'}</small>
                      <small>Observed: {time(row.observed_at)}</small>
                      <CapiroButton
                        size="compact"
                        disabled={!folder || busy}
                        onClick={() => void save('personnel', row)}
                      >
                        {row.saved ? 'Remove' : 'Save'}
                      </CapiroButton>
                      <CapiroButton size="compact" onClick={() => include('personnel', row)}>
                        Include in briefing
                      </CapiroButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !personnel.data?.items?.length && (
            <p className="lw-evidence-empty">
              No qualified personnel observations are retained for this scope.{' '}
              <a
                href="https://floridalobbyist.gov/LobbyistInformation/DownloadData"
                target="_blank"
                rel="noreferrer"
              >
                Open the official registry
              </a>
              .
            </p>
          )}
          <div className="lw-evidence-actions">
            <CapiroButton
              size="compact"
              disabled={params.offset === '0'}
              onClick={() => set('offset', String(Math.max(0, Number(params.offset) - 100)))}
            >
              Previous
            </CapiroButton>
            <CapiroButton
              size="compact"
              disabled={personnel.data?.nextOffset == null}
              onClick={() => set('offset', String(personnel.data!.nextOffset))}
            >
              Next
            </CapiroButton>
          </div>
        </>
      )}
      {lane === 'budget' && (
        <>
          <div className="lw-evidence-card">
            <div className="lw-evidence-toolbar">
              <CapiroInput
                label="Fiscal year"
                value={params.fiscalYear}
                placeholder="2026-27"
                onChange={(e) => set('fiscalYear', e.target.value)}
              />
              <CapiroSelect
                label="Legislative session"
                value={params.sessionKey}
                options={[
                  option('', 'All sessions'),
                  option('2026'),
                  option('2026E'),
                  option('2025'),
                ]}
                onChange={(e) => set('budgetSession', e.target.value)}
              />
              <CapiroInput
                label="Search project title or request identity"
                value={params.q}
                onChange={(e) => set('q', e.target.value)}
              />
              {(params.q || params.sessionKey || params.fiscalYear !== '2026-27' || params.projectId) && (
                <CapiroButton
                  size="compact"
                  onClick={() => {
                    for (const key of ['q', 'budgetSession', 'fiscalYear', 'project', 'offset']) set(key, '');
                  }}
                >
                  Clear filters
                </CapiroButton>
              )}
            </div>
            <p className="lw-evidence-filter-summary">
              Budget figures are shown for the selected fiscal year and session. Requests are not awards.
            </p>
          </div>
          <p className="lw-evidence-notice">{budget.data?.notice}</p>
          {view === 'calendar' ? (
            <p>
              <Link to={`/legiwatch?tab=hearings&client=${encodeURIComponent(client)}`}>
                Open the legislative calendar and hearing workflow
              </Link>
              . Following a project creates no recording.
            </p>
          ) : view === 'projects' ? (
            <>
              <div className="lw-evidence-table">
                <table>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Request identities</th>
                      <th>Tracking</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(budget.data?.projects ?? []).map((row: Row) => (
                      <tr key={row.id}>
                        <td>
                          <button
                            className="lw-evidence-title"
                            onClick={() => set('project', row.id)}
                          >
                            {row.title}
                          </button>
                          <small>
                            {row.agency} · FY {row.fiscal_year}
                          </small>
                        </td>
                        <td>
                          {(row.identities ?? []).map((x: Row) => (
                            <small key={`${x.chamber}:${x.id}`}>
                              {sourceUrl(x.sourceUrl) ? (
                                <a href={sourceUrl(x.sourceUrl)!} target="_blank" rel="noreferrer">
                                  {x.chamber} {x.kind} {x.id}
                                </a>
                              ) : (
                                `${x.chamber} ${x.kind} ${x.id}`
                              )}{' '}
                              · {x.fiscalYear}
                            </small>
                          ))}
                        </td>
                        <td>
                          <CapiroButton
                            size="compact"
                            disabled={!folder || busy}
                            onClick={() => void save('budget', row)}
                          >
                            {row.saved ? 'Remove tracking' : 'Track project'}
                          </CapiroButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!params.projectId && (
                <div className="lw-evidence-actions">
                  <CapiroButton
                    size="compact"
                    disabled={params.offset === '0'}
                    onClick={() => set('offset', String(Math.max(0, Number(params.offset) - 100)))}
                  >
                    Previous
                  </CapiroButton>
                  <CapiroButton
                    size="compact"
                    disabled={budget.data?.nextOffset == null}
                    onClick={() => set('offset', String(budget.data!.nextOffset))}
                  >
                    Next
                  </CapiroButton>
                </div>
              )}
              {params.projectId && (
                <div className="lw-evidence-comparison">
                  <CapiroButton
                    size="compact"
                    onClick={() => {
                      set('project', '');
                    }}
                  >
                    All projects
                  </CapiroButton>
                  <h3>Compare exact source observations</h3>
                  <div className="lw-evidence-toolbar">
                    {[
                      ['Left observation', left, setLeft],
                      ['Right observation', right, setRight],
                    ].map(([label, value, choose]) => (
                      <CapiroSelect
                        key={String(label)}
                        label={String(label)}
                        value={String(value)}
                        options={[
                          option('', 'Choose an amount'),
                          ...(budget.data?.amounts ?? []).map((r: Row) =>
                            option(
                              r.id,
                              `${r.observation.chamber} · ${r.observation.stage} · ${r.observation.fund} · ${r.observation.basis} · ${r.observation.state === 'amount' ? money(r.observation.minorUnits) : r.observation.state}`,
                            ),
                          ),
                        ]}
                        onChange={(e) => (choose as (s: string) => void)(e.target.value)}
                      />
                    ))}
                    <CapiroButton
                      disabled={
                        busy ||
                        !(
                          left &&
                          right &&
                          left !== right &&
                          (budget.data?.amounts ?? []).some(
                            (r: Row) => r.id === left && r.observation?.sourceRevision,
                          ) &&
                          (budget.data?.amounts ?? []).some(
                            (r: Row) => r.id === right && r.observation?.sourceRevision,
                          )
                        )
                      }
                      onClick={() => {
                        const amounts = budget.data?.amounts ?? [];
                        const leftRow = amounts.find((r: Row) => r.id === left),
                          rightRow = amounts.find((r: Row) => r.id === right);
                        if (
                          !leftRow?.observation?.sourceRevision ||
                          !rightRow?.observation?.sourceRevision ||
                          left === right
                        )
                          return;
                        const requestScope = comparisonScope;
                        const requestOperand = operandScope;
                        void action(async () => {
                          const result = (
                            await api.post<Row>(`${EVIDENCE_BASE}/budget/compare`, {
                              clientId: client || null,
                              folderId: folder || null,
                              leftId: left,
                              rightId: right,
                              leftRevision: leftRow.observation.sourceRevision,
                              rightRevision: rightRow.observation.sourceRevision,
                            })
                          ).data;
                          // A result that finishes after the scope or the amount
                          // selection changed belongs to the former operands and
                          // must not surface under the new one.
                          if (
                            comparisonScopeRef.current === requestScope &&
                            operandScopeRef.current === requestOperand
                          )
                            setComparison(result);
                        }, '');
                      }}
                    >
                      Compare
                    </CapiroButton>
                  </div>
                  {comparison && (
                    <div role="status">
                      <p>
                        {comparison.comparable
                          ? `Change: ${money(comparison.deltaMinorUnits)} · ${comparison.percentage ?? 'Percentage unavailable from zero baseline'}`
                          : `Numerical comparison unavailable: ${comparison.reasons.join(', ')}`}
                      </p>
                      {[comparison.left, comparison.right].map((a: Row) => (
                        <p key={a.id}>
                          {a.chamber} · {a.stage} · FY {a.fiscalYear} · {a.fund} · {a.basis} ·{' '}
                          {a.locator}{' '}
                          <CapiroButton
                            size="compact"
                            onClick={() => void open('budget', { id: a.documentId })}
                          >
                            Open this source
                          </CapiroButton>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : view === 'updates' ? (
            <div className="lw-evidence-table">
              <table>
                <thead>
                  <tr>
                    <th>Development</th>
                    <th>Evidence</th>
                    <th>Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {(budget.data?.events ?? []).map((e: Row) => (
                    <tr key={e.id}>
                      <td>
                        {e.kind.replace(/_/g, ' ')}
                        <small>{e.payload.summary ?? e.payload.title ?? e.title}</small>
                      </td>
                      <td>
                        {e.stage}
                        <small>{e.payload.locator}</small>
                        {sourceUrl(e.source_url) && (
                          <a href={sourceUrl(e.source_url)!} target="_blank" rel="noreferrer">
                            Original record
                          </a>
                        )}
                      </td>
                      <td>{time(e.observed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="lw-evidence-table">
              <table>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Stage & scope</th>
                    <th>Coverage</th>
                    <th>Briefing</th>
                  </tr>
                </thead>
                <tbody>
                  {(budget.data?.documents ?? []).map((row: Row) => (
                    <tr key={row.id}>
                      <td>
                        <button
                          className="lw-evidence-title"
                          onClick={() => void open('budget', row)}
                        >
                          {row.title}
                        </button>
                        <small>{row.publication_date ?? 'Publication date not stated'}</small>
                        {sourceUrl(row.metadata?.billSourceUrl) && (
                          <a
                            href={sourceUrl(row.metadata.billSourceUrl)!}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Related bill history
                          </a>
                        )}
                      </td>
                      <td>
                        {row.chamber} · {row.stage}
                        <small>
                          FY {row.fiscal_year} · Session {row.session_key} · {row.role}
                        </small>
                      </td>
                      <td>{row.complete ? 'Complete selected document' : 'Partial extraction'}</td>
                      <td>
                        <CapiroButton size="compact" onClick={() => include('budget', row)}>
                          Include
                        </CapiroButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !budget.data?.projects?.length && !budget.data?.documents?.length && (
            <p className="lw-evidence-empty">
              No qualified fiscal documents are retained for this scope. Source qualification is
              required before a project comparison can be shown.
            </p>
          )}
        </>
      )}
      {loading && <p role="status">Loading source evidence…</p>}
      {selected && (
        <CapiroModal open onClose={() => setSelected(null)} title={selected.title}>
          <p>
            {selected.authority} · observed {time(selected.observedAt)}
          </p>
          <p>{selected.complete ? 'Complete source' : 'Available source fields only'}</p>
          {sourceUrl(selected.sourceUrl) && (
            <a href={sourceUrl(selected.sourceUrl)!} target="_blank" rel="noreferrer">
              Original source
            </a>
          )}
          <>
            {selected.matchDefinition && (
              <p>
                Literal match: {selected.matchDefinition.query} · {selected.matchDefinition.fields}.{' '}
                {selected.matchDefinition.interpretation}. This is distinct from a client relevance
                judgment.
              </p>
            )}
          </>
          <pre className="lw-evidence-text">{selected.text}</pre>
          <small>Version {selected.revision}</small>
        </CapiroModal>
      )}
      {importReview && (
        <CapiroModal open onClose={() => setImportReview(null)} title="Review captured definitions">
          <p>
            {importReview.preview.definitions.length} news definitions and{' '}
            {importReview.preview.families.length} separate alert families. Staging activates no
            monitoring or sending.
          </p>
          <div className="lw-evidence-text">
            {importReview.preview.definitions.map((d: Row) => (
              <p key={d.sourceKey}>
                {d.raw}
                <small> → {d.compiled.interpretation ?? d.compiled.reasons.join(', ')}</small>
              </p>
            ))}
            {importReview.preview.families.map((f: Row) => (
              <p key={f.key}>
                {f.family.displayName} · cadence unspecified · current audience unresolved
              </p>
            ))}
          </div>
          <CapiroButton
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api.post(`${EVIDENCE_BASE}/imports/stage`, importReview.payload);
                setImportReview(null);
              }, 'Capture staged with monitoring and sending paused.')
            }
          >
            Stage these definitions
          </CapiroButton>
        </CapiroModal>
      )}
      {editing && (
        <MonitorEditor
          row={editing}
          onClose={() => setEditing(null)}
          save={(config, state) =>
            void action(async () => {
              await api.post(`${EVIDENCE_BASE}/news/monitors/${editing.id}/configure`, {
                clientId: client || null,
                folderId: folder || null,
                expectedVersion: editing.version,
                config: { ...config, clientId: client || null, folderId: folder || null },
                state,
              });
              setEditing(null);
            }, 'Monitor configuration saved.')
          }
        />
      )}
    </section>
  );
}
function MonitorEditor({
  row,
  onClose,
  save,
}: {
  row: Row;
  onClose: () => void;
  save: (config: Row, state: string) => void;
}) {
  const [query, setQuery] = useState(row.config.query),
    [provider, setProvider] = useState(row.config.provider ?? 'newscatcher'),
    [sources, setSources] = useState((row.config.sources ?? []).join(', ')),
    [accepted, setAccepted] = useState(row.config.scopeAccepted === true),
    [fields, setFields] = useState(row.config.fields ?? 'available_text');
  return (
    <CapiroModal open onClose={onClose} title="Review news monitor">
      <p>
        Imported expression: <strong>{row.source.raw}</strong>
      </p>
      <CapiroInput label="Capiro query" value={query} onChange={(e) => setQuery(e.target.value)} />
      <CapiroSelect
        label="News source"
        value={provider}
        options={[
          option('rss', 'Retained RSS feeds'),
          option('newscatcher', 'NewsCatcher account'),
        ]}
        onChange={(e) => setProvider(e.target.value)}
      />
      <p>{compileNewsQuery(query).interpretation ?? 'This expression requires review.'}</p>
      <CapiroTextarea
        label="Publishers (domains separated by commas; empty means available provider sources)"
        value={sources}
        onChange={(e) => setSources(e.target.value)}
      />
      <CapiroSelect
        label="Search fields"
        value={fields}
        options={[
          option('title', 'Headline'),
          option('title_summary', 'Headline and retained summary'),
          option('available_text', 'Available text; missing bodies remain unknown'),
        ]}
        onChange={(e) => setFields(e.target.value)}
      />
      <label>
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        Use the selected client/folder and publisher scope for this monitor
      </label>
      <div className="lw-evidence-actions">
        {['paused', 'active', 'excluded'].map((state) => (
          <CapiroButton
            key={state}
            disabled={state === 'active' && !accepted}
            onClick={() =>
              save(
                {
                  ...row.config,
                  query,
                  provider,
                  fields,
                  sources: sources
                    .split(',')
                    .map((s: string) => s.trim())
                    .filter(Boolean),
                  scopeAccepted: accepted,
                },
                state,
              )
            }
          >
            {state === 'active'
              ? 'Activate from now'
              : state === 'paused'
                ? 'Save paused'
                : 'Exclude'}
          </CapiroButton>
        ))}
      </div>
    </CapiroModal>
  );
}
