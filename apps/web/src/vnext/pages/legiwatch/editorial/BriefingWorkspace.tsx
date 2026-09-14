import { CitationPicker } from './CitationPicker.js';
import { BriefingConfigurations } from './BriefingConfiguration.js';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BRIEFING_TEMPLATES, PHASE8_FEATURES } from '@capiro/shared';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { EVIDENCE_BASE, basketKey, readBasket, useEvidence, type Row } from './evidence-api.js';
import { REPORT_BASE, type Report } from '../reports/report-api.js';
import { FOLDER_BASE, type Folder } from '../bills/folder-api.js';
import { useQuery } from '@tanstack/react-query';
import './evidence.css';
const option = (value: string, label = value) => ({ value, label });
export function BriefingWorkspace() {
  const allowed = useIntelFeatureEnabled(PHASE8_FEATURES.editorial),
    scope = useApiScope(),
    [p] = useSearchParams();
  return allowed ? (
    <BriefingView key={`${scope}:${p.get('client')}:${p.get('folder')}`} />
  ) : (
    <p className="lw-evidence-empty">Briefing authoring is not enabled for this workspace.</p>
  );
}
function BriefingView() {
  const api = useApi(),
    scope = useApiScope(),
    [p, setP] = useSearchParams(),
    client = p.get('client') ?? '',
    folder = p.get('folder') ?? '',
    key = basketKey(scope, client, folder),
    draftKey = key + ':draft';
  const recovered = () => {
    try {
      return JSON.parse(sessionStorage.getItem(draftKey) ?? '{}');
    } catch {
      return {};
    }
  };
  const [chosen, setChosen] = useState<Row>(recovered().chosen ?? {}),
    [sources, setSources] = useState<Row[]>(() => readBasket(key)),
    [template, setTemplate] = useState(recovered().template ?? 'morning_news_brief'),
    [title, setTitle] = useState(recovered().title ?? 'Client briefing'),
    [analysis, setAnalysis] = useState(recovered().analysis ?? ''),
    [cutoff, setCutoff] = useState(recovered().cutoff ?? new Date().toISOString()),
    [timezone, setTimezone] = useState(
      recovered().timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [requestId, setRequestId] = useState(recovered().requestId ?? crypto.randomUUID()),
    [saved, setSaved] = useState<Row | null>(recovered().saved ?? null),
    [reportId, setReportId] = useState(recovered().reportId ?? ''),
    [acceptGaps, setAcceptGaps] = useState(false),
    [audience, setAudience] = useState('internal'),
    [preview, setPreview] = useState<Row | null>(null),
    [runId, setRunId] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    sessionStorage.setItem(
      draftKey,
      JSON.stringify({
        template,
        title,
        analysis,
        cutoff,
        timezone,
        requestId,
        saved,
        reportId,
        chosen,
      }),
    );
  }, [template, title, analysis, cutoff, timezone, requestId, saved, reportId, draftKey, chosen]);
  const folders = useQuery({
    queryKey: ['phase8-folders', scope, client],
    queryFn: async () =>
      (await api.get<Folder[]>(FOLDER_BASE)).data.filter(
        (f) => !f.archived && f.clientId === (client || null),
      ),
  });
  const reports = useQuery({
    queryKey: ['phase8-reports', scope, folder],
    queryFn: async () =>
      (await api.get<Report[]>(REPORT_BASE)).data.filter(
        (r) => r.folderIds.length === 1 && r.folderIds[0] === folder,
      ),
  });

  const action = async (fn: () => Promise<unknown>, notice: string) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      setMessage(notice);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Briefing requires review.');
    } finally {
      setBusy(false);
    }
  };
  const setFolder = (id: string) => {
    const n = new URLSearchParams(p);
    n.set('folder', id);
    setP(n);
  };
  const create = () =>
    action(async () => {
      const selected = [],
        citations = [];
      for (const ref of sources) {
        const row = (
          await api.get<Row>(
            `${EVIDENCE_BASE}/source/${ref.kind}/${encodeURIComponent(ref.id)}?${new URLSearchParams({ clientId: client, folderId: folder })}`,
          )
        ).data;
        if (row.revision !== ref.revision)
          throw Error('A selected source changed. Review it again in News or Budget.');
        const citation = chosen[`${ref.kind}:${ref.id}`];
        if (!citation) throw Error('Choose a cited passage for every selected source.');
        selected.push({ kind: ref.kind, id: ref.id, revision: ref.revision });
        citations.push(citation);
      }
      const response = await api.post<Row>(`${EVIDENCE_BASE}/briefings/drafts`, {
        clientId: client || null,
        folderId: folder,
        template,
        title,
        analysis: analysis || sources.map((s, i) => `[${i + 1}] ${s.title}`).join('\n'),
        generationMode: analysis ? 'authored_analysis' : 'source_list',
        cutoff,
        timezone,
        requestKey: requestId,
        sources: selected,
        citations,
      });
      setSaved(response.data);
      setPreview(null);
    }, 'Private draft saved. Open Workspace to edit before reviewing this edition.');
  return (
    <section className="lw-evidence">
      <h3>Client briefings</h3>
      <p>
        Original Capiro editions with selected evidence, an explicit cutoff, and exact output
        review.
      </p>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="lw-evidence-toolbar">
        <CapiroSelect
          label="Folder"
          value={folder}
          options={[
            option('', 'Choose a folder'),
            ...(folders.data ?? []).map((f) => option(f.id, f.name)),
          ]}
          onChange={(e) => setFolder(e.target.value)}
        />
        <CapiroSelect
          label="Template"
          value={template}
          options={Object.entries(BRIEFING_TEMPLATES).map(([id, label]) => option(id, label))}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <CapiroInput
          label="Edition title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="lw-evidence-toolbar">
        <CapiroInput
          label="Knowledge cutoff (ISO timestamp)"
          value={cutoff}
          onChange={(e) => setCutoff(e.target.value)}
        />
        <CapiroInput
          label="Timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        />
        <CapiroButton size="compact" onClick={() => setCutoff(new Date().toISOString())}>
          Use current cutoff
        </CapiroButton>
      </div>
      <CapiroButton
        size="compact"
        disabled={busy}
        onClick={() => {
          setSaved(null);
          setPreview(null);
          setRunId('');
          setRequestId(crypto.randomUUID());
          setCutoff(new Date().toISOString());
          setSources(readBasket(key));
          setMessage('New edition ready. Earlier drafts remain in Workspace and Reports.');
        }}
      >
        Start a new edition
      </CapiroButton>
      <h4>Selected evidence ({sources.length})</h4>
      {sources.length ? (
        <ul>
          {sources.map((s, i) => (
            <li key={`${s.kind}:${s.id}`}>
              {s.title} <small>({s.kind})</small>{' '}
              <CitationPicker
                source={s}
                client={client}
                folder={folder}
                citation={chosen[`${s.kind}:${s.id}`]}
                onChoose={(citation) => setChosen({ ...chosen, [`${s.kind}:${s.id}`]: citation })}
              />{' '}
              <button
                onClick={() => {
                  const next = sources.filter((_, n) => n !== i);
                  setSources(next);
                  sessionStorage.setItem(key, JSON.stringify(next));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          Select articles in{' '}
          <Link to={`/legiwatch?${new URLSearchParams({ tab: 'news', client, folder })}`}>
            News
          </Link>{' '}
          and documents in{' '}
          <Link
            to={`/legiwatch?${new URLSearchParams({ tab: 'budget', budgetView: 'documents', client, folder })}`}
          >
            Budget
          </Link>
          .
        </p>
      )}
      <CapiroTextarea
        label="Capiro analysis for review"
        value={analysis}
        placeholder="Describe the development, client implication, uncertainty, and useful next action. Attribute reporting and cite the selected evidence."
        onChange={(e) => setAnalysis(e.target.value)}
        rows={8}
      />
      <p className="lw-evidence-notice">
        With no analysis, preparation saves a source list for further work. It is not a generated
        analytical brief.
      </p>
      <CapiroButton
        disabled={
          !folder ||
          !sources.length ||
          sources.some((s) => !chosen[`${s.kind}:${s.id}`]) ||
          busy ||
          !!saved?.draft?.draftId
        }
        onClick={() => void create()}
      >
        Prepare private draft
      </CapiroButton>
      {saved && (
        <div className="lw-evidence-comparison">
          <p>
            {saved.draft?.draftId ? (
              <Link to={`/workspace/draft/${encodeURIComponent(saved.draft.draftId)}`}>
                Open editable Workspace draft →
              </Link>
            ) : (
              'Selection saved; Workspace preparation is pending.'
            )}
          </p>
          <div className="lw-evidence-toolbar">
            <CapiroSelect
              label="Report definition"
              value={reportId}
              options={[
                option('', 'Choose this folder’s report'),
                ...(reports.data ?? []).map((r) => option(r.id, r.name)),
              ]}
              onChange={(e) => {
                setReportId(e.target.value);
                setPreview(null);
              }}
            />
            <CapiroSelect
              label="Edition audience"
              value={audience}
              options={[
                option('internal', 'Internal review'),
                option('external', 'External distribution review'),
              ]}
              onChange={(e) => {
                setAudience(e.target.value);
                setPreview(null);
              }}
            />
            <CapiroButton
              disabled={!reportId || busy}
              onClick={() =>
                void action(
                  async () =>
                    setPreview(
                      (
                        await api.post<Row>(`${EVIDENCE_BASE}/briefings/preview`, {
                          selectionId: saved.selectionId,
                          reportId,
                          audience,
                          acceptSourceGaps: acceptGaps,
                        })
                      ).data,
                    ),
                  'Review the exact edited output below.',
                )
              }
            >
              Preview edited edition
            </CapiroButton>
          </div>
          {audience === 'external' && (
            <label className="lw-evidence-check">
              <input
                type="checkbox"
                checked={acceptGaps}
                onChange={(e) => {
                  setAcceptGaps(e.target.checked);
                  setPreview(null);
                }}
              />
              I reviewed the selected source limitations for this distribution
            </label>
          )}
          {preview && (
            <>
              <p>
                {preview.audience} · {preview.deliveryState}
              </p>
              <pre className="lw-evidence-text">{preview.rendered.text}</pre>
              <CapiroButton
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    setRunId(
                      (
                        await api.post<Row>(`${EVIDENCE_BASE}/briefings/approve`, {
                          selectionId: saved.selectionId,
                          reportId,
                          audience,
                          acceptSourceGaps: acceptGaps,
                          approvalHash: preview.approvalHash,
                        })
                      ).data.runId,
                    );
                  }, 'Edition approved. Distribution has its own exact recipient and content review.')
                }
              >
                Approve this edition
              </CapiroButton>
            </>
          )}
          {runId && (
            <p>
              Saved to{' '}
              <button
                onClick={() => {
                  const n = new URLSearchParams(p);
                  n.set('reportView', 'history');
                  setP(n);
                }}
              >
                Reports run history
              </button>
              . Open that run to use the existing recipient preview and delivery controls.
            </p>
          )}
        </div>
      )}
      <BriefingConfigurations client={client} folder={folder} reports={reports.data ?? []} />
    </section>
  );
}
