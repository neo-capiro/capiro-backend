import { useEffect, useRef, useState } from 'react';
import { KeywordDeliveryHistory } from './KeywordDeliveryHistory.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { CapiroDrawer } from '../../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableWrap,
  CapiroTableHead,
  CapiroTableBody,
  CapiroTableHeaderCell as TH,
  CapiroTableCell as TD,
} from '../../../components/tables/index.js';
import { FOLDER_BASE, folderKey, folderError, type Folder } from '../bills/folder-api.js';
import './keyword-review.css';
import { KeywordImportReview, ImportedMappings, type ImportLedger } from './KeywordImportReview.js';
export const KEYWORD_BASE = '/intel-api/legiwatch/keyword-rules';
export const KEYWORD_FEATURE = 'legiwatch_keyword_discovery_v1';
type Rule = {
  id: string;
  name: string;
  version: number;
  state: string;
  issues: string[];
  config: {
    scope: { jurisdiction: string; sessionKey: string; fields: string[] };
    folderIds: string[];
    definitions: Array<{ id: string; raw: string }>;
    aggregation: string;
    semanticsReviewed: boolean;
    mode: string;
    cadence: string;
    source: Record<string, any> | null;
    timezone?: string | null;
    localMinutes?: number | null;
    deliveryEnabled?: boolean;
  };
  compiled: Array<{
    id: string;
    compiled: { raw: string; status: string; interpretation: string | null; reasons: string[] };
  }>;
};
type Suggestion = {
  id: string;
  version: number;
  state: string;
  rule_id: string;
  payload: {
    origin?: 'deterministic' | 'semantic';
    explanation?: string;
    bill: { id: string; number: string; title: string };
    folderVersion: number;
    coverage: { complete: boolean; missing: string[] };
    sourceScope: { jurisdiction: string; sessionKey: string };
    matches: Array<{
      document: { id: string; kind: string; revision: string; sourceUrl: string | null };
      evaluation: {
        results: Array<{
          id: string;
          outcome: string;
          evidence: Array<{ quote: string; expression: string; start: number; end: number }>;
        }>;
      };
    }>;
  };
};
type Scan = {
  id: string;
  state: string;
  reason: string | null;
  rule_version: number;
  counts: { evaluated?: number; matched?: number; incomplete?: number; suggestions?: number };
  input: { mode: string };
};
const label = (s: string) => s.toLowerCase().replaceAll('_', ' ');
const option = (value: string, text = value) => ({ value, label: text });
const safeUrl = (url: string | null) => {
  try {
    const u = new URL(url ?? '');
    return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
};
export function KeywordReview(props: {
  folderId?: string;
  jurisdiction?: string;
  sessionKey?: string;
  initialView?: 'suggestions' | 'rules';
}) {
  const identity = useApiScope(),
    enabled = useIntelFeatureEnabled(KEYWORD_FEATURE);
  if (!enabled) return null;
  return (
    <Review
      key={[identity, props.folderId, props.jurisdiction, props.sessionKey].join(':')}
      {...props}
      identity={identity}
    />
  );
}
function Review({
  identity,
  folderId: initialFolder = '',
  jurisdiction: initialJurisdiction = 'FL',
  sessionKey: initialSession = '',
  initialView = 'suggestions',
}: {
  identity: string;
  folderId?: string;
  jurisdiction?: string;
  sessionKey?: string;
  initialView?: 'suggestions' | 'rules';
}) {
  const api = useApi(),
    qc = useQueryClient(),
    [params, setParams] = useSearchParams(),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [view, setView] = useState(initialView),
    [folderId, setFolderId] = useState(initialFolder),
    [jurisdiction, setJurisdiction] = useState(initialJurisdiction),
    [sessionKey, setSession] = useState(initialSession);
  const [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<Array<{ id: string; expectedVersion: number }>>([]),
    [detail, setDetail] = useState<Suggestion | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [raw, setRaw] = useState(''),
    [field, setField] = useState('bill_text');
  const [aggregation, setAggregation] = useState('unqualified'),
    [reviewed, setReviewed] = useState(false),
    [mode, setMode] = useState('suggest');
  const [editingId, setEditingId] = useState<string | null>(null),
    [cadence, setCadence] = useState('realtime'),
    [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [cutoff, setCutoff] = useState('17:00');
  const [deliveryReview, setDeliveryReview] = useState<{
    issues: string[];
    previewHash: string;
    recipientCount: number;
  } | null>(null);
  const ruleId = params.get('keywordRule') ?? '',
    runId = params.get('keywordRun') ?? '';
  const key = ['lw-keywords', identity, folderId, jurisdiction, sessionKey];
  const folders = useQuery({
    queryKey: [...folderKey(identity), 'list'],
    queryFn: async () => (await api.get<Folder[]>(FOLDER_BASE)).data,
  });
  const rules = useQuery({
    queryKey: ['lw-keywords', identity, 'rules'],
    queryFn: async () => (await api.get<Rule[]>(KEYWORD_BASE)).data,
    retry: false,
  });
  const suggestions = useQuery({
    queryKey: [...key, 'suggestions', cursor],
    enabled: !!folderId && !!sessionKey,
    queryFn: async () =>
      (
        await api.get<{ rows: Suggestion[]; next: string | null }>(
          `${KEYWORD_BASE}/suggestions/${encodeURIComponent(folderId)}?${new URLSearchParams({ jurisdiction, sessionKey, ...(cursor ? { cursor } : {}) })}`,
        )
      ).data,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['lw-keywords', identity, 'history', ruleId],
    enabled: !!ruleId,
    queryFn: async () =>
      (await api.get<Scan[]>(`${KEYWORD_BASE}/${encodeURIComponent(ruleId)}/history`)).data,
    retry: false,
  });
  const run = useQuery({
    queryKey: ['lw-keywords', identity, 'run', runId],
    enabled: !!runId,
    queryFn: async () =>
      (await api.get<Scan>(`${KEYWORD_BASE}/scans/${encodeURIComponent(runId)}`)).data,
    retry: false,
  });
  const rule = rules.data?.find((r) => r.id === ruleId);
  const imported = useQuery({
    queryKey: ['lw-keywords', identity, 'staged'],
    enabled: view === 'rules' && !!rule?.config.source?.stagedId,
    queryFn: async () =>
      (
        await api.get<ImportLedger>(
          KEYWORD_BASE + '/staged?sourceAccount=' + encodeURIComponent('lobbytools:rubin-turnbull'),
        )
      ).data,
    retry: false,
  });
  const currentSelection = useRef('');
  currentSelection.current = [identity, folderId, jurisdiction, sessionKey, ruleId].join(':');
  useEffect(() => {
    setDeliveryReview(null);
    setError('');
    setNotice('');
  }, [ruleId]);
  const navigate = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(values).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next);
  };
  useEffect(() => {
    setSelected([]);
    setDetail(null);
    setCursor(null);
  }, [folderId, jurisdiction, sessionKey]);
  async function perform<T>(work: () => Promise<T>, done?: (value: T) => void) {
    const selectedScope = currentSelection.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await work();
      if (!alive.current || selectedScope !== currentSelection.current) return;
      done?.(value);
      await qc.invalidateQueries({ queryKey: ['lw-keywords', identity] });
      await qc.invalidateQueries({ queryKey: folderKey(identity) });
    } catch (e) {
      if (alive.current && selectedScope === currentSelection.current) setError(folderError(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const decision = (s: Suggestion, action: string) =>
    perform(
      async () =>
        (
          await api.post<{ outcome: string }>(`${KEYWORD_BASE}/suggestions/${s.id}/decision`, {
            action,
            expectedVersion: s.version,
            requestKey: crypto.randomUUID(),
          })
        ).data,
      (r) => {
        setNotice(label(r.outcome));
        setDetail(null);
        setSelected([]);
      },
    );
  const currentFolder = folders.data?.find((f) => f.id === folderId);
  return (
    <section className="lw-keywords" aria-label="Suggested bills and keyword rules">
      <div className="lw-keywords-heading">
        <div>
          <h3>Suggested bills &amp; rules</h3>
          <p>Review the source, then choose the next step for this folder.</p>
        </div>
        <div className="lw-keywords-actions">
          <CapiroButton
            size="compact"
            aria-pressed={view === 'suggestions'}
            onClick={() => setView('suggestions')}
          >
            Suggested bills
          </CapiroButton>
          <CapiroButton
            size="compact"
            aria-pressed={view === 'rules'}
            onClick={() => setView('rules')}
          >
            Keyword rules
          </CapiroButton>
        </div>
      </div>
      <div className="lw-keywords-controls">
        <CapiroSelect
          label="Folder"
          value={folderId}
          options={[
            option('', 'Select a folder'),
            ...(folders.data ?? []).map((f) =>
              option(f.id, `${f.name}${!f.canEdit ? ' · Read only' : ''}`),
            ),
          ]}
          onChange={(e) => setFolderId(e.target.value)}
        />
        <CapiroInput
          label="Jurisdiction"
          value={jurisdiction}
          maxLength={2}
          onChange={(e) => setJurisdiction(e.target.value.toUpperCase())}
        />
        <CapiroInput
          label="Session"
          value={sessionKey}
          maxLength={60}
          onChange={(e) => setSession(e.target.value)}
        />
      </div>
      {error || rules.error || suggestions.error ? (
        <p role="alert">{error || folderError(rules.error || suggestions.error)}</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {view === 'rules' ? (
        <>
          <div className="lw-keywords-actions">
            <CapiroButton
              size="compact"
              onClick={() => {
                setEditingId(null);
                setCreating(!creating);
              }}
            >
              New rule
            </CapiroButton>
            <span>Imported notification settings remain under separate review.</span>
          </div>
          {creating ? (
            <form
              className="lw-keywords-create"
              onSubmit={(e) => {
                e.preventDefault();
                void perform(
                  async () =>
                    (
                      await (editingId ? api.put : api.post)<Rule>(
                        KEYWORD_BASE + (editingId ? '/' + editingId : ''),
                        {
                          name,
                          expectedVersion: editingId
                            ? rules.data?.find((r) => r.id === editingId)?.version
                            : undefined,
                          config: {
                            scope: { jurisdiction, sessionKey, fields: [field] },
                            folderIds: folderId ? [folderId] : [],
                            definitions: editingId
                              ? rules.data?.find((r) => r.id === editingId)?.config.definitions
                              : raw
                                  .split('\n')
                                  .map((line) => ({ id: crypto.randomUUID(), raw: line })),
                            aggregation,
                            semanticsReviewed: reviewed,
                            mode,
                            cadence,
                            timezone: cadence === 'end_of_day' ? timezone : null,
                            localMinutes:
                              cadence === 'end_of_day'
                                ? Number(cutoff.split(':')[0]) * 60 + Number(cutoff.split(':')[1])
                                : null,
                          },
                        },
                      )
                    ).data,
                  (r) => {
                    setCreating(false);
                    navigate({ keywordRule: r.id, keywordRun: '' });
                  },
                );
              }}
            >
              <CapiroInput
                label="Rule name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <CapiroTextarea
                label="Search definitions — one per line"
                value={raw}
                readOnly={!!editingId}
                onChange={(e) => setRaw(e.target.value)}
              />
              <CapiroSelect
                label="Search scope"
                value={field}
                options={[
                  option('bill_text', 'Retained bill text'),
                  option('amendment_text', 'Retained amendment text'),
                  option('title', 'Canonical bill titles'),
                ]}
                onChange={(e) => setField(e.target.value)}
              />
              <CapiroSelect
                label="Across definitions"
                value={aggregation}
                options={[
                  option('unqualified', 'Needs review'),
                  option('any-v1', 'Match any definition'),
                  option('all-v1', 'Match all in one document'),
                ]}
                onChange={(e) => setAggregation(e.target.value)}
              />
              <CapiroSelect
                label="After activation"
                value={mode}
                options={[
                  option('suggest', 'Suggest for review'),
                  option('auto_add', 'Automatically add to this folder'),
                ]}
                onChange={(e) => setMode(e.target.value)}
              />
              <CapiroSelect
                label="Staff delivery cadence"
                value={cadence}
                options={[option('realtime', 'Real time'), option('end_of_day', 'End of day')]}
                onChange={(e) => setCadence(e.target.value)}
              />
              {cadence === 'end_of_day' ? (
                <>
                  <CapiroInput
                    label="Timezone"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                  <CapiroInput
                    label="Local cutoff"
                    type="time"
                    value={cutoff}
                    onChange={(e) => setCutoff(e.target.value)}
                  />
                </>
              ) : null}
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{' '}
                I reviewed this Capiro interpretation and source scope.
              </label>
              <CapiroButton
                type="submit"
                size="compact"
                disabled={busy || !name || !folderId || !sessionKey}
              >
                Save inactive rule
              </CapiroButton>
            </form>
          ) : null}
          <KeywordImportReview
            identity={identity}
            jurisdiction={jurisdiction}
            sessionKey={sessionKey}
            onInspect={(id) => navigate({ keywordRule: id, keywordRun: '' })}
            onPromote={(row) =>
              void perform(
                async () =>
                  (
                    await api.post<{ id: string }>(KEYWORD_BASE + '/promote/' + row.id, {
                      expectedVersion: row.version,
                      sourceHash: row.sourceHash,
                      scope: { jurisdiction, sessionKey, fields: ['bill_text'] },
                    })
                  ).data,
                (r) => navigate({ keywordRule: r.id, keywordRun: '' }),
              )
            }
          />
          <CapiroTableWrap role="region" aria-label="Keyword rules table" tabIndex={0}>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <TH>Rule</TH>
                  <TH>Definitions / scope</TH>
                  <TH>State</TH>
                  <TH>Review</TH>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {rules.data?.map((r) => (
                  <tr key={r.id}>
                    <TD>{r.name}</TD>
                    <TD>
                      {r.config.definitions.length} · {r.config.scope.jurisdiction}{' '}
                      {r.config.scope.sessionKey}
                      <br />
                      {r.config.scope.fields.map(label).join(', ')}
                    </TD>
                    <TD>
                      {label(r.state)}
                      <br />
                      {r.issues.map(label).join(' · ')}
                    </TD>
                    <TD>
                      <CapiroButton
                        size="compact"
                        onClick={() => navigate({ keywordRule: r.id, keywordRun: '' })}
                      >
                        Inspect rule
                      </CapiroButton>
                    </TD>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          {!rules.data?.length ? (
            <p>
              No keyword rules configured in your scope. Import review preserves incomplete rules
              until their mappings are resolved.
            </p>
          ) : null}
          {rule ? (
            <div className="lw-keywords-rule">
              <h4>{rule.name}</h4>
              <KeywordDeliveryHistory
                key={identity + ':' + rule.id}
                identity={identity}
                ruleId={rule.id}
              />
              <CapiroButton
                size="compact"
                onClick={() => {
                  setEditingId(rule.id);
                  setName(rule.name);
                  setRaw(rule.config.definitions.map((d) => d.raw).join('\n'));
                  setField(rule.config.scope.fields[0]!);
                  setAggregation(rule.config.aggregation);
                  setMode(rule.config.mode);
                  setCadence(rule.config.cadence);
                  setTimezone(
                    rule.config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
                  );
                  setReviewed(false);
                  setCreating(true);
                }}
              >
                Edit scope and interpretation
              </CapiroButton>
              {imported.data && rule.config.source?.stagedId ? (
                <ImportedMappings
                  key={rule.id + ':' + rule.version}
                  ledger={imported.data}
                  stagedId={String(rule.config.source.stagedId)}
                  onReview={(userMappings) =>
                    void perform(
                      async () =>
                        api.post(KEYWORD_BASE + '/' + rule.id + '/mappings', {
                          expectedVersion: rule.version,
                          reviewedOwnerId: imported.data!.actorId,
                          ownerReviewed: true,
                          userMappings,
                        }),
                      () => setNotice('Mappings saved. Preview this rule again before activation.'),
                    )
                  }
                />
              ) : null}
              <p>
                {label(rule.config.mode)} · {label(rule.config.cadence)} · version {rule.version}
              </p>
              {rule.compiled.map((d) => (
                <div key={d.id}>
                  <pre>{d.compiled.raw}</pre>
                  <p>
                    {d.compiled.interpretation ?? d.compiled.reasons.map(label).join(', ')} ·{' '}
                    {d.compiled.status}
                  </p>
                </div>
              ))}
              <div className="lw-keywords-actions">
                <CapiroButton
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      async () =>
                        (
                          await api.get<{
                            issues: string[];
                            previewHash: string;
                            recipientCount: number;
                          }>(KEYWORD_BASE + '/' + rule.id + '/delivery-preview')
                        ).data,
                      setDeliveryReview,
                    )
                  }
                >
                  Review staff delivery
                </CapiroButton>
                <CapiroButton
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      async () =>
                        (
                          await api.post<Scan>(`${KEYWORD_BASE}/${rule.id}/scans`, {
                            expectedVersion: rule.version,
                            requestKey: crypto.randomUUID(),
                            mode: 'preview',
                          })
                        ).data,
                      (r) => navigate({ keywordRun: r.id }),
                    )
                  }
                >
                  Start preview scan
                </CapiroButton>
                <CapiroButton
                  size="compact"
                  disabled={
                    busy ||
                    !run.data ||
                    run.data.state !== 'complete' ||
                    !!run.data.counts.incomplete
                  }
                  onClick={() =>
                    void perform(
                      async () =>
                        api.post(`${KEYWORD_BASE}/${rule.id}/activation`, {
                          expectedVersion: rule.version,
                          action: 'activate',
                          previewRunId: runId,
                          baseline: 'from_now',
                        }),
                      () => setNotice('Rule activated for new source changes.'),
                    )
                  }
                >
                  Activate from now
                </CapiroButton>
                <CapiroButton
                  size="compact"
                  disabled={busy || rule.state === 'paused'}
                  onClick={() =>
                    void perform(
                      async () =>
                        api.post(`${KEYWORD_BASE}/${rule.id}/activation`, {
                          expectedVersion: rule.version,
                          action: 'pause',
                        }),
                      () => setNotice('Rule paused. Completed work is preserved.'),
                    )
                  }
                >
                  Pause
                </CapiroButton>
              </div>
              {deliveryReview ? (
                <div>
                  <p>
                    {deliveryReview.recipientCount} staff subscriptions ·{' '}
                    {deliveryReview.issues.map(label).join(' · ') ||
                      'Ready for explicit channel activation'}
                  </p>
                  <CapiroButton
                    size="compact"
                    disabled={
                      busy || (!rule.config.deliveryEnabled && !!deliveryReview.issues.length)
                    }
                    onClick={() =>
                      void perform(
                        async () =>
                          api.post(KEYWORD_BASE + '/' + rule.id + '/delivery', {
                            expectedVersion: rule.version,
                            enabled: !rule.config.deliveryEnabled,
                            previewHash: deliveryReview.previewHash,
                          }),
                        () => {
                          setDeliveryReview(null);
                          setNotice(
                            'Rule delivery setting saved; runtime and channel gates still apply.',
                          );
                        },
                      )
                    }
                  >
                    {rule.config.deliveryEnabled
                      ? 'Pause staff delivery'
                      : 'Enable reviewed staff channels'}
                  </CapiroButton>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="lw-keywords-actions">
            <span>
              {selected.length} selected · {suggestions.data?.rows.length ?? 0} on this page
            </span>
            <CapiroButton
              size="compact"
              disabled={busy || !selected.length || !currentFolder?.canEdit}
              onClick={() => {
                const frozen = selected.map((s) => ({ ...s, requestKey: crypto.randomUUID() }));
                void perform(
                  async () =>
                    (
                      await api.post<{ results: Array<{ id: string; outcome: string }> }>(
                        `${KEYWORD_BASE}/suggestions/batch`,
                        { action: 'add', items: frozen },
                      )
                    ).data,
                  (r) => {
                    setNotice(r.results.map((x, i) => `${i + 1}: ${label(x.outcome)}`).join(' · '));
                    setSelected([]);
                  },
                );
              }}
            >
              Add {selected.length} selected
            </CapiroButton>
          </div>
          <p className="lw-keywords-scroll-hint">
            Scroll the table sideways to review every column.
          </p>
          <CapiroTableWrap role="region" aria-label="Suggested bills table" tabIndex={0}>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <TH>Select</TH>
                  <TH>Bill</TH>
                  <TH>Why it matched</TH>
                  <TH>Source coverage</TH>
                  <TH>Decision</TH>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {suggestions.data?.rows.map((s) => (
                  <tr key={s.id}>
                    <TD>
                      <input
                        type="checkbox"
                        aria-label={`Select ${s.payload.bill.number}`}
                        checked={selected.some((x) => x.id === s.id)}
                        disabled={s.state !== 'pending' || !currentFolder?.canEdit}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked
                              ? [...prev, { id: s.id, expectedVersion: s.version }]
                              : prev.filter((x) => x.id !== s.id),
                          )
                        }
                      />
                    </TD>
                    <TD>
                      <strong>{s.payload.bill.number}</strong>
                      <br />
                      {s.payload.bill.title}
                    </TD>
                    <TD>
                      {s.payload.origin === 'semantic'
                        ? 'Meri relevance · review required'
                        : 'Keyword rule match'}
                      <br />
                      {s.payload.matches[0]?.evaluation.results
                        .filter((r) => ['match', 'suggestion'].includes(r.outcome))
                        .flatMap((r) => r.evidence.map((e) => e.quote))
                        .join(' · ')}
                    </TD>
                    <TD>
                      {s.payload.coverage.complete
                        ? 'Complete in selected scope'
                        : 'Not fully evaluated'}
                    </TD>
                    <TD>
                      {label(s.state)}
                      <br />
                      <CapiroButton size="compact" onClick={() => setDetail(s)}>
                        Review
                      </CapiroButton>
                    </TD>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          {suggestions.isPending && folderId && sessionKey ? (
            <p role="status">Loading suggestions…</p>
          ) : !suggestions.data?.rows.length ? (
            <p>No suggestions in this scope. Open Keyword rules to preview a search.</p>
          ) : null}
          <CapiroButton
            size="compact"
            disabled={!suggestions.data?.next || busy}
            onClick={() => {
              setSelected([]);
              setCursor(suggestions.data!.next);
            }}
          >
            Next page
          </CapiroButton>
        </>
      )}
      {run.data ? (
        <div className="lw-keywords-run" aria-live="polite">
          <h4>Scan: {label(run.data.state)}</h4>
          <p>
            {run.data.counts.evaluated ?? 0} bills evaluated · {run.data.counts.matched ?? 0}{' '}
            matched · {run.data.counts.incomplete ?? 0} with source gaps
          </p>
          {run.data.reason ? <p>{label(run.data.reason)}</p> : null}
          <CapiroButton
            size="compact"
            disabled={busy || !['pending', 'partial', 'failed'].includes(run.data.state)}
            onClick={() =>
              void perform(async () => api.post(`${KEYWORD_BASE}/scans/${runId}/continue`))
            }
          >
            Continue scan
          </CapiroButton>
          <p>
            Preview creates suggestions only. Document matches describe the cited version; amendment
            language may remain proposed.
          </p>
        </div>
      ) : null}
      {ruleId && history.data?.length ? (
        <details>
          <summary>Run history</summary>
          {history.data.map((r) => (
            <p key={r.id}>
              <button type="button" onClick={() => navigate({ keywordRun: r.id })}>
                {label(r.state)} · {r.counts.evaluated ?? 0} evaluated · {r.id.slice(0, 8)}
              </button>
            </p>
          ))}
        </details>
      ) : null}
      <CapiroDrawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Review ${detail.payload.bill.number}` : 'Review suggestion'}
      >
        {detail ? (
          <div className="lw-keywords-detail">
            <h3>{detail.payload.bill.title}</h3>
            {detail.payload.origin === 'semantic' ? (
              <p>Meri relevance suggestion: {detail.payload.explanation}</p>
            ) : null}
            <a href={'/bills/' + encodeURIComponent(detail.payload.bill.id)}>Open Bill 360</a>
            <p>
              Proposed change: add to {currentFolder?.name}. Position, priority and comments keep
              their current values.
            </p>
            <p>
              {detail.payload.sourceScope.jurisdiction} · {detail.payload.sourceScope.sessionKey} ·{' '}
              {label(detail.state)}
            </p>
            {detail.payload.matches.map((m) => (
              <div key={m.document.id}>
                <h4>{label(m.document.kind)}</h4>
                <p>
                  Source version <span className="lw-keywords-hash">{m.document.revision}</span>
                </p>
                {m.evaluation.results
                  .filter((r) => ['match', 'suggestion'].includes(r.outcome))
                  .map((r) => (
                    <div key={r.id}>
                      {r.evidence.map((e, i) => (
                        <blockquote key={i}>
                          <p>{e.quote}</p>
                          <footer>
                            Matched {e.expression} · characters {e.start}–{e.end}
                          </footer>
                        </blockquote>
                      ))}
                    </div>
                  ))}
                {safeUrl(m.document.sourceUrl) ? (
                  <a href={safeUrl(m.document.sourceUrl)} target="_blank" rel="noreferrer">
                    Open published source
                  </a>
                ) : (
                  <p>Source link unavailable</p>
                )}
              </div>
            ))}
            {!detail.payload.coverage.complete ? (
              <p>Not fully evaluated: {detail.payload.coverage.missing.map(label).join(' · ')}</p>
            ) : null}
            <div className="lw-keywords-actions">
              <CapiroButton
                size="compact"
                disabled={busy || detail.state !== 'pending' || !currentFolder?.canEdit}
                onClick={() => void decision(detail, 'add')}
              >
                Add to folder
              </CapiroButton>
              <CapiroButton
                size="compact"
                disabled={busy || !currentFolder?.canEdit}
                onClick={() => void decision(detail, 'dismiss')}
              >
                Dismiss this evidence
              </CapiroButton>
              <CapiroButton
                size="compact"
                disabled={busy || !currentFolder?.canEdit}
                onClick={() =>
                  void decision(detail, detail.state === 'excluded' ? 'restore' : 'exclude')
                }
              >
                {detail.state === 'excluded'
                  ? 'Restore rule suggestion'
                  : 'Exclude from this rule and folder'}
              </CapiroButton>
              {detail.state === 'added' ? (
                <CapiroButton
                  size="compact"
                  disabled={busy || !currentFolder?.canEdit}
                  onClick={() => void decision(detail, 'undo')}
                >
                  Undo addition
                </CapiroButton>
              ) : null}
            </div>
            <p>
              Removing a tracked bill blocks all automatic rules for this folder until you manually
              add it again.
            </p>
          </div>
        ) : null}
      </CapiroDrawer>
    </section>
  );
}
