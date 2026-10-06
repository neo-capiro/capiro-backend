import { addBasket, basketKey } from '../editorial/evidence-api.js';
import { ImportReview } from './ImportReview.js';
import { ResearchReportReview } from './ResearchReportReview.js';
import {
  researchDraftKey,
  readResearchDraft,
  writeResearchDraft,
  passageSourceUrl,
} from './research-state.js';

import { useState, useRef, useEffect, lazy, Suspense } from 'react';

import { useSearchParams, Link, useNavigate } from 'react-router-dom';

import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../../../lib/use-api.js';

import { useApiScope } from '../../../../lib/use-api-scope.js';

import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';

import { useMe } from '../../../../lib/me.js';

import { CapiroButton } from '../../../components/actions/index.js';

import { CapiroInput, CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';

import {
  CapiroTable,
  CapiroTableWrap,
  CapiroTableHead,
  CapiroTableBody,
  CapiroTableHeaderCell as TH,
  CapiroTableCell as TD,
} from '../../../components/tables/index.js';

import { isTenantAdmin, type ResearchVersion, type ComparisonLine } from '@capiro/shared';

import './research.css';

const BASE = '/intel-api/legiwatch/research';
const Bill360Drawer = lazy(() =>
  import('../bills/Bill360Drawer.js').then((m) => ({ default: m.Bill360Drawer })),
);

type Result = {
  left?: ResearchVersion;
  right?: ResearchVersion;
  items?: Array<
    ResearchVersion & {
      title: string;
      isCurrent: boolean;
      excerpt: { quote: string };
      billTitle?: string;
      billIdentifier?: string;
      sponsor?: string;
      chamber?: string;
      lastAction?: string;
      versionType?: string;
    }
  >;
  rows?: any[];
  related?: any[];
  versions?: Array<ResearchVersion & { title?: string }>;
  cursor?: string | null;
  coverage?: { complete: boolean; reason: string };
  changes?: ComparisonLine[];
  warning?: string;
  rules?: any[];
  memberships?: any[];
  receipts?: any[];
  adopted?: any[];
};

const safeUrl = (raw: string) => {
  try {
    const u = new URL(raw);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};

const options = (items: string[]) => items.map((value) => ({ value, label: value }));

export function ResearchTab() {
  const [scopeParams] = useSearchParams();

  const identity = useApiScope(),
    enabled = useIntelFeatureEnabled('legiwatch_research_v1');

  if (!enabled)
    return (
      <section className="lw-research">
        <h2>Research setup</h2>
        <p>
          Legislative research is not enabled for this workspace. An administrator can review the
          source coverage and rollout configuration.
        </p>
        <Link to="/legiwatch?tab=settings">Open LegiWatch settings</Link>
      </section>
    );

  return (
    <ResearchWorkspace
      key={JSON.stringify([
        identity,
        scopeParams.get('client'),
        scopeParams.get('folder'),
        scopeParams.get('session'),
        scopeParams.get('edition'),
        scopeParams.get('left'),
        scopeParams.get('leftRevision'),
        scopeParams.get('right'),
        scopeParams.get('rightRevision'),
        scopeParams.get('rightSession'),
      ])}
    />
  );
}

function ResearchWorkspace() {
  const api = useApi(),
    navigate = useNavigate(),
    identity = useApiScope(),
    me = useMe(),
    [params, setParams] = useSearchParams();

  const requestedView = params.get('researchView') ?? 'bills',
    canReviewImports = Boolean(me.data && isTenantAdmin(me.data.role)),
    importAccessResolved = Boolean(me.data) || !me.isLoading,
    importFallback = requestedView === 'imports' && importAccessResolved && !canReviewImports,
    view = importFallback ? 'bills' : requestedView,
    query = params.get('researchQuery') ?? '',
    folderId = params.get('folder') ?? '',
    clientId = params.get('client') ?? '';

  const jurisdiction = params.get('jurisdiction') ?? 'FL',
    sessionKey = params.get('session') ?? (jurisdiction === 'US' ? String(Math.floor((new Date().getFullYear() - 1789) / 2) + 1) : String(new Date().getFullYear())),
    edition = params.get('edition') ?? '2026';
  const unsupportedLegalScope = view === 'statutes' && jurisdiction !== 'FL';
  const leftBill = params.get('leftBill') ?? params.get('bill') ?? '';
  const isBillView = view === 'bills' || view === 'compare';

  const storageKey = researchDraftKey(identity, params),
    recovered = readResearchDraft(storageKey);
  const [draft, setDraft] = useState(query),
    [error, setError] = useState(''),
    [analysis, setAnalysis] = useState(recovered.analysis),
    [saved, setSaved] = useState<{ draftId?: string; selectionId: string } | null>(recovered.saved),
    [rightSearch, setRightSearch] = useState(params.get('rightSearch') ?? ''),
    [importAccessNotice, setImportAccessNotice] = useState(false);

  const pending = useRef<{ hash: string; key: string } | null>(recovered.pending),
    mounted = useRef(true);

  useEffect(() => {
    writeResearchDraft(storageKey, { analysis, saved, pending: pending.current });
  }, [storageKey, analysis, saved]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const get = (url: string) => api.get<Result>(url).then((r) => r.data);

  const post = (url: string, body: unknown) => api.post<Result>(url, body).then((r) => r.data);

  const change = (values: Record<string, string>) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [k, v] of Object.entries(values)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      return next;
    });
  };

  const changeJurisdiction = (next: string) => {
    change({ jurisdiction: next, session: next === 'US' ? String(Math.floor((new Date().getFullYear() - 1789) / 2) + 1) : String(new Date().getFullYear()), cursor: '', left: '', right: '', leftRevision: '', rightRevision: '', rightSession: '', leftBill: '', rightBill: '', bill: '' });
  };

  useEffect(() => {
    if (!importFallback) return;
    setImportAccessNotice(true);
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('researchView', 'bills');
      next.delete('cursor');
      next.delete('researchQuery');
      return next;
    });
  }, [importFallback, setParams]);

  const scope = {
    jurisdiction,
    sessionKey,
    folderId: folderId || null,
    clientId: clientId || null,
  };

  const shared = new URLSearchParams(
    Object.entries({ ...scope, edition, noticeId: params.get('noticeId') ?? '' }).filter(
      ([, v]) => v !== null,
    ) as string[][],
  );

  const key = [
    'legiwatch-research',
    identity,
    scope,
    edition,
    view,
    query,
    params.get('left'),
    params.get('right'),
    params.get('leftRevision'),
    params.get('rightRevision'),
    params.get('cursor'),
    params.get('referenceId'),
    params.get('documentKind'),
    params.get('noticeId'),
    params.get('researchCode'),
    params.get('versionPolicy'),
    params.get('versionStage'),
    params.get('bill'),
    params.get('billTitle'),
    params.get('sponsor'),
    params.get('chamber'),
    params.get('action'),
    params.get('allowCrossBill'),
    params.get('rightSession'),
  ];

  const read = useQuery<Result>({
    queryKey: key,
    enabled: !unsupportedLegalScope && (requestedView !== 'imports' || importAccessResolved),
    queryFn: async () => {
      if (view === 'compare')
        return post(BASE + '/compare', {
          ...scope,
          leftId: params.get('left'),
          rightId: params.get('right'),
          leftRevision: params.get('leftRevision'),
          rightRevision: params.get('rightRevision'),
          allowCrossBill: params.get('allowCrossBill') === 'true',
          rightSessionKey: params.get('rightSession') ?? sessionKey,
        });

      if (view === 'bills')
        return post(BASE + '/search', {
          ...scope,
          query,
          cursor: params.get('cursor'),
          kind: params.get('documentKind') ?? 'all',
          versionPolicy: params.get('versionPolicy') ?? 'any_retained',
          versionStage: params.get('versionStage') ?? 'all',
          ...(params.get('bill') ? { billIds: [params.get('bill')] } : {}),
          referenceId: params.get('referenceId'),
          title: params.get('billTitle'),
          sponsor: params.get('sponsor'),
          chamber: params.get('chamber'),
          action: params.get('action'),
        });

      if (view === 'statutes') {
        shared.set('citation', query);
        shared.set('code', params.get('researchCode') ?? 'statute');
        return get(BASE + '/references?' + shared);
      }

      if (view === 'rules') {
        shared.set('ruleNumber', query);
        return get(BASE + '/rules?' + shared);
      }

      if (view === 'deadlines') return get(BASE + '/deadlines?' + shared);

      if (view === 'imports') return get(BASE + '/imports?' + shared);

      return get(BASE + '/coverage?' + shared);
    },
    retry: false,
  });

  const selected = useQuery<Result>({
    queryKey: ['research-versions', identity, scope, leftBill],
    enabled: isBillView && Boolean(leftBill),
    queryFn: () => {
      shared.set('billId', leftBill);
      return get(BASE + '/versions?' + shared);
    },
  });

  const rightSession = params.get('rightSession') ?? sessionKey,
    rightBill = params.get('rightBill') ?? '';
  const rightSelected = useQuery<Result>({
    queryKey: ['research-right-versions', identity, scope, rightSession, rightBill],
    enabled: isBillView && Boolean(rightBill),
    queryFn: () =>
      get(
        BASE +
          '/versions?' +
          new URLSearchParams({
            ...Object.fromEntries(shared),
            billId: rightBill,
            sessionKey: rightSession,
          }),
      ),
  });
  const rightCandidates = useQuery<Result>({
    queryKey: [
      'research-right-bills',
      identity,
      scope,
      rightSession,
      params.get('rightSearch'),
      params.get('rightCursor'),
    ],
    enabled: isBillView && params.get('rightPicker') === 'true',
    queryFn: () =>
      post(BASE + '/search', {
        ...scope,
        sessionKey: rightSession,
        query: '',
        title: params.get('rightSearch') ?? '',
        kind: 'text',
        versionPolicy: 'current_extractions',
        cursor: params.get('rightCursor'),
      }),
    retry: false,
  });
  const folder = useQuery({
    queryKey: ['research-folder-name', identity, folderId],
    enabled: Boolean(folderId),
    retry: false,
    queryFn: async () =>
      (
        await api.get<Array<{ id: string; name: string }>>('/intel-api/legiwatch/folders')
      ).data.find((f) => f.id === folderId) ?? null,
  });
  const client = useQuery({
    queryKey: ['research-client-name', identity, clientId],
    enabled: Boolean(clientId),
    retry: false,
    queryFn: async () =>
      (await api.get<{ name: string }>('/api/clients/' + encodeURIComponent(clientId))).data,
  });

  const selectPair = (side: 'left' | 'right', id: string) => {
    const version = (side === 'right' && rightBill ? rightSelected : selected).data?.versions?.find(
      (v) => v.id === id,
    );
    if (version) change({ [side]: id, [side + 'Revision']: version.revision });
  };

  const versions = selected.data?.versions ?? [];
  const rightVersions = rightBill ? (rightSelected.data?.versions ?? []) : versions;

  // Specialist filters, compacted into chips. Every option stays reachable;
  // this only makes the applied subset visible and individually clearable.
  const specialistFilters: Array<{ label: string; param: string }> = [
    { label: 'Bill', param: 'bill' },
    { label: 'Bill title', param: 'billTitle' },
    { label: 'Sponsor', param: 'sponsor' },
    { label: 'Chamber', param: 'chamber' },
    { label: 'Latest action', param: 'action' },
    { label: 'Document kind', param: 'documentKind' },
    { label: 'Retained versions', param: 'versionPolicy' },
    { label: 'Publisher stage', param: 'versionStage' },
    { label: 'Statute citation', param: 'referenceId' },
  ];
  const isDefaultFilter = (param: string, value: string | null) =>
    !value ||
    (param === 'documentKind' && value === 'all') ||
    (param === 'versionPolicy' && value === 'any_retained') ||
    (param === 'versionStage' && value === 'all');
  const appliedFilters = specialistFilters.filter(
    (f) => !isDefaultFilter(f.param, params.get(f.param)),
  );
  const clearAllFilters = () =>
    change({
      ...Object.fromEntries(appliedFilters.map((f) => [f.param, ''])),
      cursor: '',
    });

  const memberships = useQuery({
    queryKey: ['research-memberships', identity, scope],
    enabled: Boolean(folderId) && view === 'statutes',
    queryFn: async () =>
      (
        await api.get<Array<{ reference_id: string; version: number; removed: boolean }>>(
          BASE + '/memberships?' + shared + '&includeRemoved=true',
        )
      ).data,
  });

  useEffect(() => {
    setDraft(query);
  }, [query]);

  return (
    <section className="lw-research" aria-label="Legislative research">
      <nav aria-label="Research views" className="lw-research__nav">
        {[
          ['bills', 'Bills'],
          ['statutes', 'Statutes & Constitution'],
          ['rules', 'Rules & deadlines'],
          ...(canReviewImports ? [['imports', 'Review imported setup']] : []),
          ['coverage', 'Source coverage'],
        ].map(([value, label]) => (
          <CapiroButton
            key={value}
            aria-pressed={view === value || (value === 'bills' && view === 'compare')}
            variant={
              view === value || (value === 'bills' && view === 'compare')
                ? 'primary'
                : 'secondary'
            }
            onClick={() => {
              setImportAccessNotice(false);
              change({ researchView: value!, cursor: '', researchQuery: '', ...(value === 'statutes' ? { jurisdiction: 'FL', session: String(new Date().getFullYear()) } : {}) });
              setDraft('');
            }}
          >
            {label}
          </CapiroButton>
        ))}
      </nav>

      {importAccessNotice && !canReviewImports ? (
        <p className="lw-research__scope-note" role="status">
          Imported setup review is available to workspace administrators. Research opened in Bills
          instead.
        </p>
      ) : null}

      <p className="lw-research__scope-note" role="note">
        {view === 'bills'
          ? 'Full-text search across the bill documents LegiWatch has retained — bill text, amendments and supplements. Metadata browsing lives in Bills.'
          : view === 'compare'
            ? 'Exact-wording comparison of two retained document versions.'
            : view === 'statutes'
              ? 'Citation lookup in the retained Florida Statutes editions and the current Constitution snapshot.'
              : view === 'rules'
                ? 'Rule notices retained from the official rule sources.'
                : view === 'deadlines'
                  ? 'Published dates and deadlines from retained rule notices.'
                  : view === 'imports'
                    ? 'Review setup imported into this workspace before it takes effect.'
                    : 'Which official sources LegiWatch has retained, and how complete each source check is.'}
      </p>

      <div className="lw-research__scope">
        <span>
          {folderId
            ? (folder.data?.name ?? 'Selected folder (name unavailable)')
            : 'All permitted public sources'}{' '}
          ·{' '}
          {clientId
            ? (client.data?.name ?? 'Selected client (name unavailable)')
            : 'No client selected'}
        </span>
        <CapiroSelect
          label="Jurisdiction"
          value={jurisdiction}
          options={options(['FL', 'US'])}
          onChange={(e) => changeJurisdiction(e.target.value)}
        />
        {view === 'statutes' && params.get('researchCode') !== 'constitution' ? (
          <CapiroInput
            label="Statute edition"
            value={edition}
            onChange={(e) => change({ edition: e.target.value })}
          />
        ) : view === 'statutes' ? (
          <span>Current publisher snapshot; edition not assigned</span>
        ) : ['bills', 'compare', 'coverage', 'imports'].includes(view) ? (
          <CapiroInput
            label="Bill session"
            value={sessionKey}
            onChange={(e) => change({ session: e.target.value, cursor: '' })}
          />
        ) : <span>Bill session does not apply to rule notices or published deadlines.</span>}
        <span className="lw-research__effective">
          Effective scope: {jurisdiction === 'FL' ? 'Florida Legislature' : 'U.S. Congress'} ·{' '}
          {view === 'statutes' ? params.get('researchCode') === 'constitution' ? 'current Constitution snapshot' : `edition ${edition}` : ['rules', 'deadlines'].includes(view) ? 'published rule notices; no bill session' : `session ${sessionKey}`} ·{' '}
          {folderId || clientId
            ? 'selected folder/client context'
            : 'public corpus, no folder filter'}{' '}
          · retained sources only — unretained documents cannot match (see Source coverage).
        </span>
      </div>

      {unsupportedLegalScope ? <p role="status" className="lw-research__scope-note">Statute and Constitution lookup is available for Florida. <CapiroButton size="compact" onClick={() => changeJurisdiction('FL')}>Use Florida legal sources</CapiroButton></p> : null}
      {view === 'statutes' && !unsupportedLegalScope ? (
        <CapiroSelect
          label="Legal source"
          value={params.get('researchCode') ?? 'statute'}
          options={[
            { value: 'statute', label: 'Florida Statutes' },
            { value: 'constitution', label: 'Florida Constitution — current publisher snapshot' },
          ]}
          onChange={(e) => {
            change({ researchCode: e.target.value, researchQuery: '' });
            setDraft('');
          }}
        />
      ) : null}

      {['bills', 'statutes', 'rules'].includes(view) ? (
        <form
          className="lw-research__search"
          onSubmit={(e) => {
            e.preventDefault();
            change({ researchQuery: draft, cursor: '' });
          }}
        >
          <CapiroInput
            label={
              view === 'statutes'
                ? 'Citation or title'
                : view === 'rules'
                  ? 'Exact rule number'
                  : 'Words or phrase in bill documents'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              view === 'statutes' ? '395.003' : view === 'rules' ? '1-1.008' : '"health care"'
            }
          />
          <CapiroButton type="submit">Search</CapiroButton>
        </form>
      ) : null}

      {view === 'bills' ? (
        <div className="lw-research__scope">
          <details>
            <summary>Bill title, sponsor and action filters</summary>
            {[
              ['billTitle', 'Bill title'],
              ['sponsor', 'Sponsor name'],
              ['chamber', 'Chamber'],
              ['action', 'Latest published action'],
            ].map(([key, label]) => (
              <CapiroInput
                key={key}
                label={label!}
                value={params.get(key!) ?? ''}
                onChange={(e) => change({ [key!]: e.target.value, cursor: '' })}
              />
            ))}
          </details>
          <details>
            <summary>More filters — document kind, retained versions, publisher stage</summary>
            <CapiroSelect
              label="Document kind"
              value={params.get('documentKind') ?? 'all'}
              options={[
                { value: 'all', label: 'All document kinds' },
                { value: 'text', label: 'Bill text' },
                { value: 'amendment', label: 'Amendments' },
                { value: 'supplement', label: 'Supplements' },
              ]}
              onChange={(e) => change({ documentKind: e.target.value, cursor: '' })}
            />
            <CapiroSelect
              label="Retained version policy"
              value={params.get('versionPolicy') ?? 'any_retained'}
              options={[
                {
                  value: 'any_retained',
                  label: 'All retained versions — every saved extraction can match',
                },
                {
                  value: 'current_extractions',
                  label: 'Current extraction only — the latest saved copy of each document',
                },
                {
                  value: 'newest_dated_text',
                  label: 'Newest dated bill text — by publisher date, ties included',
                },
              ]}
              onChange={(e) => change({ versionPolicy: e.target.value, cursor: '' })}
            />
            <CapiroSelect
              label="Publisher text stage"
              value={params.get('versionStage') ?? 'all'}
              options={[
                { value: 'all', label: 'All published stages' },
                { value: 'enrolled', label: 'Publisher-labeled enrolled text' },
                { value: 'chaptered', label: 'Publisher-labeled chaptered text' },
              ]}
              onChange={(e) => change({ versionStage: e.target.value, cursor: '' })}
            />
            {params.get('versionPolicy') === 'newest_dated_text' ? (
              <p>
                Uses the newest retained publisher date, including ties. Undated texts are omitted;
                missing evidence may affect the result.
              </p>
            ) : null}
            {params.get('versionStage') && params.get('versionStage') !== 'all' ? (
              <p>
                The publisher's document label does not establish which provisions became
                effective. Review the original record and any related outcomes.
              </p>
            ) : null}
          </details>
          {params.get('bill') ? (
            <CapiroButton onClick={() => change({ bill: '', cursor: '' })}>
              Search all bills in session
            </CapiroButton>
          ) : null}
        </div>
      ) : null}

      {view === 'bills' && appliedFilters.length ? (
        <div className="lw-research__chips" role="group" aria-label="Active research filters">
          <span>Active filters:</span>
          {appliedFilters.map((f) => (
            <button
              key={f.param}
              type="button"
              className="lw-research__chip"
              title="Remove this filter"
              onClick={() => change({ [f.param]: '', cursor: '' })}
            >
              {f.label}: {params.get(f.param)} ✕
            </button>
          ))}
          <CapiroButton size="compact" onClick={clearAllFilters}>
            Clear all filters
          </CapiroButton>
        </div>
      ) : null}

      {view === 'rules' || view === 'deadlines' ? (
        <CapiroButton
          onClick={() => change({ researchView: view === 'rules' ? 'deadlines' : 'rules' })}
        >
          {view === 'rules' ? 'Show published dates' : 'Show rule notices'}
        </CapiroButton>
      ) : null}

      {requestedView === 'imports' && !importAccessResolved ? (
        <p role="status">Checking administrator access to imported setup review…</p>
      ) : !unsupportedLegalScope && read.isPending ? (
        <p role="status">
          Searching the retained sources for this scope — results appear when the source
          responds…
        </p>
      ) : read.isError ? (
        <p role="alert">
          This research view did not return. The retained sources or workspace access may be
          unavailable; your filters are unchanged and nothing was deleted.{' '}
          <CapiroButton onClick={() => read.refetch()}>Retry</CapiroButton>
        </p>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}

      {read.data?.coverage && !read.data.coverage.complete ? (
        <aside role="status">
          Search incomplete. Results cover retained source evidence.{' '}
          <CapiroButton onClick={() => change({ researchView: 'coverage' })}>
            Review source coverage
          </CapiroButton>
        </aside>
      ) : null}

      {isBillView && leftBill && versions.length > 0 ? (
        <div className="lw-research__pair">
          <p className="lw-research__pair-note">
            Each entry is one retained document version: label · publisher date · version id.
            Only versions LegiWatch has saved from official sources are listed.
          </p>
          <CapiroSelect
            label="Left version"
            value={params.get('left') ?? ''}
            options={[
              { value: '', label: 'Choose the left version' },
              ...versions.map((v) => ({
                value: v.id,
                label: `${v.title ?? v.kind} · ${v.publishedDate ?? 'date unavailable'} · ${v.id.slice(0, 8)}`,
              })),
            ]}
            onChange={(e) => selectPair('left', e.target.value)}
          />
          <CapiroSelect
            label="Right version"
            value={params.get('right') ?? ''}
            options={[
              { value: '', label: 'Choose the right version' },
              ...rightVersions.map((v) => ({
                value: v.id,
                label: `${v.title ?? v.kind} · ${v.publishedDate ?? 'date unavailable'} · ${v.id.slice(0, 8)}`,
              })),
            ]}
            onChange={(e) => selectPair('right', e.target.value)}
          />
          <CapiroButton
            disabled={!params.get('left') || !params.get('right')}
            onClick={() => change({ researchView: 'compare' })}
          >
            Compare selected versions
          </CapiroButton>
          <CapiroButton
            onClick={() =>
              change({ rightPicker: params.get('rightPicker') === 'true' ? '' : 'true', leftBill })
            }
          >
            Choose another bill or session
          </CapiroButton>
        </div>
      ) : null}

      {isBillView && params.get('rightPicker') === 'true' ? (
        <section aria-label="Choose the right bill">
          <h3>Compare another bill or session</h3>
          <p>The left version remains pinned. Choose the right bill, then its exact version.</p>
          <CapiroInput
            label="Right bill session"
            value={rightSession}
            onChange={(e) =>
              change({
                rightSession: e.target.value,
                rightBill: '',
                right: '',
                rightRevision: '',
                rightCursor: '',
                researchView: 'bills',
              })
            }
          />
          <form
            className="lw-research__search"
            onSubmit={(e) => {
              e.preventDefault();
              change({ rightSearch, rightCursor: '' });
            }}
          >
            <CapiroInput
              label="Find the right bill by title"
              value={rightSearch}
              onChange={(e) => setRightSearch(e.target.value)}
            />
            <CapiroButton type="submit">Find bills</CapiroButton>
          </form>
          {rightCandidates.isPending ? <p role="status">Loading retained bill texts…</p> : null}
          {rightCandidates.isError || rightSelected.isError ? (
            <p role="alert">
              The right source is unavailable. Check its session and current access.
            </p>
          ) : null}
          <CapiroSelect
            label="Right bill"
            value={rightBill}
            options={[
              { value: '', label: 'Choose a bill with retained text' },
              ...Array.from(
                new Map(
                  (rightCandidates.data?.items ?? []).map((v) => [
                    v.billId,
                    {
                      value: v.billId,
                      label: `${v.billIdentifier ?? v.billId} · ${v.billTitle ?? ''}`,
                    },
                  ]),
                ).values(),
              ),
            ]}
            onChange={(e) =>
              change({
                rightBill: e.target.value,
                right: '',
                rightRevision: '',
                allowCrossBill: 'true',
                researchView: 'bills',
              })
            }
          />
          <p>
            Only retained source documents are listed. Review source coverage for missing bills or
            versions.
          </p>
          {rightCandidates.data?.cursor ? (
            <CapiroButton onClick={() => change({ rightCursor: rightCandidates.data!.cursor! })}>
              More retained bills
            </CapiroButton>
          ) : null}
          {rightBill ? (
            <CapiroButton
              onClick={() =>
                change({
                  rightBill: '',
                  right: '',
                  rightRevision: '',
                  rightSession: '',
                  allowCrossBill: '',
                  researchView: 'bills',
                })
              }
            >
              Use the left bill on both sides
            </CapiroButton>
          ) : null}
        </section>
      ) : null}

      {view === 'bills' && read.data && !read.data.items?.length ? (
        <div className="lw-research__empty" role="status">
          <p>
            <strong>No retained document matches this page of results.</strong>{' '}
            {read.data.cursor
              ? 'More source pages remain — use “Search next source page” below before concluding there is no match.'
              : 'This covers only the retained sources for the effective scope above; check source coverage before treating this as a complete negative.'}
          </p>
          <div className="lw-research__chips">
            {query ? (
              <CapiroButton
                size="compact"
                onClick={() => change({ researchQuery: '', cursor: '' })}
              >
                Clear search text
              </CapiroButton>
            ) : null}
            {appliedFilters.length ? (
              <CapiroButton size="compact" onClick={clearAllFilters}>
                Clear all filters
              </CapiroButton>
            ) : null}
            <CapiroButton size="compact" onClick={() => change({ researchView: 'coverage' })}>
              Review source coverage
            </CapiroButton>
          </div>
        </div>
      ) : null}

      {view === 'bills' && read.data ? (
        <CapiroTableWrap>
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <TH>Bill / session</TH>
                <TH>Matching document</TH>
                <TH>Original text</TH>
                <TH>Research</TH>
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {read.data.items?.map((item) => (
                <tr key={item.id}>
                  <TD>
                    {item.billIdentifier ?? item.billId}
                    <br />
                    {item.sessionKey}
                    {item.billTitle ? <p>{item.billTitle}</p> : null}
                    {item.sponsor ? (
                      <p>
                        {item.sponsor} · {item.chamber}
                      </p>
                    ) : null}
                    {item.lastAction ? <p>{item.lastAction}</p> : null}
                  </TD>
                  <TD>
                    {item.title ?? item.kind}
                    <br />
                    {item.publishedDate ?? 'Publisher date unavailable'}
                    <br />
                    {item.isCurrent ? 'Current extraction' : 'Historical extraction'}
                  </TD>
                  <TD>{item.excerpt.quote}</TD>
                  <TD>
                    <a href={safeUrl(item.sourceUrl ?? '')} target="_blank" rel="noreferrer">
                      Original source
                    </a>
                    <CapiroButton onClick={() => change({ researchBill: item.billId })}>
                      Open Bill 360
                    </CapiroButton>
                    <CapiroButton
                      onClick={() =>
                        change({
                          bill: item.billId,
                          leftBill: item.billId,
                          left: item.id,
                          leftRevision: item.revision,
                        })
                      }
                    >
                      Select versions
                    </CapiroButton>
                    <CapiroButton
                      disabled={!folderId}
                      onClick={() => {
                        addBasket(basketKey(identity, clientId, folderId), {
                          kind: 'research',
                          id: item.id,
                          revision: item.revision,
                          title: item.title ?? item.kind,
                        });
                        navigate(
                          '/legiwatch?' +
                            new URLSearchParams({
                              tab: 'digest',
                              digestMode: 'bill_report',
                              reportView: 'briefings',
                              client: clientId,
                              folder: folderId,
                            }),
                        );
                      }}
                    >
                      Include in briefing
                    </CapiroButton>
                  </TD>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      ) : null}

      {view === 'compare' && read.data?.changes ? (
        <>
          <div className="lw-research__pair">
            {[read.data.left, read.data.right].map((v, i) =>
              v ? (
                <article key={i}>
                  <h3>
                    {i === 0 ? 'Left' : 'Right'} · {v.billId}
                  </h3>
                  <p>
                    {v.kind} · {v.publishedDate ?? 'Publisher date unavailable'} · {v.sessionKey}
                  </p>
                  <p>Exact version {v.id}</p>
                  <a href={safeUrl(v.sourceUrl ?? '')} target="_blank" rel="noreferrer">
                    Open this original version
                  </a>
                </article>
              ) : null,
            )}
          </div>
          <p>{read.data.warning}</p>
          <div className="lw-research__diff" aria-label="Exact version text comparison">
            {read.data.changes.map((line, i) => (
              <div key={i} className={'lw-research__line is-' + line.kind}>
                <span>{line.kind}</span>
                <pre className="lw-research__unified">{line.text}</pre>
                <pre className="lw-research__left" aria-label="Left passage">
                  {line.left ? line.text : ''}
                </pre>
                <pre className="lw-research__right" aria-label="Right passage">
                  {line.right ? line.text : ''}
                </pre>
                <small>
                  {line.left ? (
                    <a
                      href={passageSourceUrl(read.data?.left?.sourceUrl, line.left.locator)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Left source · {line.left.locator}
                    </a>
                  ) : null}{' '}
                  {line.right ? (
                    <a
                      href={passageSourceUrl(read.data?.right?.sourceUrl, line.right.locator)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Right source · {line.right.locator}
                    </a>
                  ) : null}
                </small>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {view === 'compare' && read.data?.left && read.data.right ? (
        <section aria-label="Save cited research">
          <CapiroTextarea
            label="Capiro analysis for review"
            value={analysis}
            onChange={(e) => setAnalysis(e.target.value)}
            placeholder="Add your interpretation, client implications and questions for review."
          />
          <CapiroButton
            onClick={async () => {
              const result = read.data!;
              const citations = result
                .changes!.filter((l) => l.kind !== 'unchanged' && l.text.length > 0)
                .slice(0, 20)
                .map((l) => {
                  const v = l.kind === 'removed' ? result.left! : result.right!,
                    at = l.left ?? l.right!;
                  return {
                    documentId: v.id,
                    revision: v.revision,
                    locator: at.locator,
                    start: at.start,
                    end: at.end,
                    quote: l.text,
                  };
                });

              if (!citations.length) {
                setError(
                  'Select a source pair with cited changed passages before saving this comparison.',
                );
                return;
              }

              const body = {
                ...scope,
                title: 'Legislative comparison',
                analysis,
                documents: [result.left!, result.right!].map((v) => ({
                  id: v.id,
                  revision: v.revision,
                  sessionKey: v.sessionKey,
                })),
                allowCrossBill: params.get('allowCrossBill') === 'true',
                rightSessionKey: rightSession,
                citations,
              };
              const fingerprint = JSON.stringify(body);
              if (pending.current?.hash !== fingerprint)
                pending.current = { hash: fingerprint, key: crypto.randomUUID() };
              writeResearchDraft(storageKey, { analysis, saved, pending: pending.current });

              try {
                const response = await api.post<{
                  selectionId: string;
                  draft?: { draftId: string };
                }>(BASE + '/drafts', { ...body, requestKey: pending.current.key });
                if (mounted.current) {
                  setSaved({
                    selectionId: response.data.selectionId,
                    draftId: response.data.draft?.draftId,
                  });
                  setError('');
                }
              } catch {
                if (mounted.current)
                  setError(
                    'The research draft is pending. Retry the same unchanged selection to recover its saved output.',
                  );
              }
            }}
          >
            Save cited research draft
          </CapiroButton>
          {saved?.draftId ? (
            <Link to={'/workspace/draft/' + encodeURIComponent(saved.draftId)}>
              Open saved research draft
            </Link>
          ) : saved ? (
            <p>Evidence selection saved. Workspace output is pending configuration.</p>
          ) : null}
        </section>
      ) : null}

      {view === 'statutes' &&
        read.data?.rows?.map((row) => (
          <article key={row.id}>
            <h3>
              {row.section ??
                `${row.code_kind === 'constitution' ? 'Article' : 'Chapter'} ${row.chapter}`}{' '}
              · {row.title ?? 'Text not yet qualified'}
            </h3>
            <p>
              {row.edition ??
                (row.code_kind === 'constitution'
                  ? 'Publisher snapshot observed ' + row.observed_at
                  : 'Edition not established')}{' '}
              ·{' '}
              <a href={safeUrl(row.source_url)} target="_blank" rel="noreferrer">
                Original source
              </a>
            </p>
            {row.sections?.map((s: any) => (
              <p key={s.locator} id={s.locator}>
                {s.text}
              </p>
            ))}
            {row.history_text ? (
              <details>
                <summary>Source history</summary>
                {row.history_text}
              </details>
            ) : null}
            <CapiroButton
              onClick={() =>
                change({
                  researchView: 'bills',
                  referenceId: row.id,
                  researchQuery: '',
                  cursor: '',
                })
              }
            >
              Bills mentioning this section
            </CapiroButton>
            {folderId ? (
              <CapiroButton
                onClick={async () => {
                  const current = memberships.data?.find((m) => m.reference_id === row.id);
                  try {
                    await api.post(BASE + '/memberships', {
                      ...scope,
                      referenceId: row.id,
                      edition: row.edition ?? null,
                      expectedVersion: current?.version ?? 0,
                      remove: current?.removed === false,
                      requestKey: crypto.randomUUID(),
                    });
                    await memberships.refetch();
                    if (mounted.current) setError('');
                  } catch {
                    if (mounted.current)
                      setError(
                        'Folder membership changed or access is unavailable. Reload the folder before applying.',
                      );
                  }
                }}
              >
                {memberships.data?.some((m) => m.reference_id === row.id && !m.removed)
                  ? 'Remove from selected folder'
                  : 'Track in selected folder'}
              </CapiroButton>
            ) : null}
          </article>
        ))}
      {view === 'statutes' && Boolean(read.data?.related?.length) ? (
        <section aria-label="Related legislative references">
          <h3>Related bill passages</h3>
          {read.data!.related!.map((r: any) => (
            <article key={r.id}>
              <p>
                {r.bill_id} · {r.document_kind} · {r.relation.replaceAll('_', ' ')} ·{' '}
                {r.is_current ? 'Current source revision' : 'Retained earlier source'}
              </p>
              <blockquote>{r.quote}</blockquote>
              <p>
                {r.locator} ·{' '}
                <a href={safeUrl(r.source_url)} target="_blank" rel="noreferrer">
                  Original document
                </a>
              </p>
              <CapiroButton
                onClick={() =>
                  change({
                    bill: r.bill_id,
                    session: r.session_key,
                    left: r.document_id,
                    leftRevision: r.document_revision,
                    researchView: 'bills',
                  })
                }
              >
                Compare this bill
              </CapiroButton>
            </article>
          ))}
        </section>
      ) : null}
      {params.get('researchBill') ? (
        <Suspense fallback={<p role="status">Loading Bill 360…</p>}>
          <Bill360Drawer
            billId={params.get('researchBill')!}
            clientId={clientId}
            folderId={folderId || undefined}
            onClose={() => change({ researchBill: '' })}
            onOpenFull={() =>
              navigate(
                '/bills/' +
                  encodeURIComponent(params.get('researchBill')!) +
                  '?' +
                  params.toString(),
              )
            }
          />
        </Suspense>
      ) : null}

      {view === 'rules' &&
        read.data?.rows?.map((row) => (
          <article key={row.id}>
            <h3>{row.payload.noticeType ?? 'Unknown notice type'}</h3>
            <p>
              {row.notice_id} · {row.payload.department}
            </p>
            <p>{row.payload.summary}</p>
            <ul>
              {row.payload.rules?.map((r: any) => (
                <li key={r.number}>
                  <a href={safeUrl(r.sourceUrl)} target="_blank" rel="noreferrer">
                    {r.number}
                  </a>{' '}
                  {r.title}
                </li>
              ))}
            </ul>
            <a href={safeUrl(row.source_url)} target="_blank" rel="noreferrer">
              Open publisher notice
            </a>
          </article>
        ))}

      {view === 'deadlines' &&
        read.data?.rows?.map((row) => (
          <article key={row.id}>
            <h3>
              {row.kind.replaceAll('_', ' ')} ·{' '}
              {String(row.date_only ?? 'Conditional date').slice(0, 10)}
            </h3>
            <p>{row.raw_wording}</p>
            <p>Source-stated date; no cutoff time has been supplied. {row.notice_id}</p>
            <a href={safeUrl(row.source_url)}>Original date basis</a>
            {folderId ? (
              <CapiroButton
                onClick={async () => {
                  try {
                    const response = await api.post<{
                      selectionId: string;
                      draft?: { draftId: string };
                    }>(BASE + '/deadlines/drafts', {
                      ...scope,
                      deadlineId: row.id,
                      noticeRevision: row.notice_revision_id,
                      analysis:
                        'Review the source-stated ' +
                        row.kind.replaceAll('_', ' ') +
                        '. Confirm the current publisher notice before acting; no cutoff time is inferred.',
                      requestKey: crypto.randomUUID(),
                    });
                    if (mounted.current) {
                      setSaved({
                        selectionId: response.data.selectionId,
                        draftId: response.data.draft?.draftId,
                      });
                      setError('');
                    }
                  } catch {
                    if (mounted.current)
                      setError(
                        'The source date changed or Workspace is unavailable. Review the current notice before creating a follow-up.',
                      );
                  }
                }}
              >
                Create private date follow-up
              </CapiroButton>
            ) : null}
          </article>
        ))}

      {view === 'rules' &&
        read.data?.adopted?.map((v) => (
          <article key={v.id}>
            <h3>{v.title}</h3>
            <p>
              {v.complete ? 'Retained adopted text' : 'Text extraction requires review'} ·{' '}
              <a href={safeUrl(v.source_url)}>Exact publisher attachment</a>
            </p>
            <p>{v.coverage.reason?.replaceAll('_', ' ').toLowerCase()}</p>
            {v.sections.map((s: any) => (
              <p key={s.locator}>{s.text}</p>
            ))}
          </article>
        ))}
      {view !== 'compare' && saved?.draftId ? (
        <Link to={'/workspace/draft/' + encodeURIComponent(saved.draftId)}>
          Open saved follow-up draft
        </Link>
      ) : null}
      {saved?.draftId && folderId ? (
        <ResearchReportReview
          key={saved.selectionId}
          selectionId={saved.selectionId}
          folderId={folderId}
        />
      ) : null}
      {view === 'imports' && read.data ? (
        <ImportReview
          rows={read.data.memberships ?? []}
          rules={read.data.rules ?? []}
          scope={scope}
          refresh={read.refetch}
        />
      ) : null}

      {view === 'coverage' && read.data ? (
        <>
          <h3>Source checks</h3>
          {read.data.receipts?.length ? (
            read.data.receipts.map((r: any) => (
              <article key={r.id}>
                <h4>{r.source}</h4>
                <p>
                  {r.complete ? 'Selected source check complete' : 'Source check incomplete'} ·{' '}
                  {r.observed_at}
                </p>
                <p>{r.manifest.gaps?.join(', ')}</p>
              </article>
            ))
          ) : (
            <p>
              No qualified source receipts are available. An operator must run the selected source
              ingestion and inspect its coverage.
            </p>
          )}
        </>
      ) : null}

      {read.data?.cursor ? (
        <CapiroButton onClick={() => change({ cursor: read.data!.cursor! })}>
          Search next source page
        </CapiroButton>
      ) : null}
    </section>
  );
}
