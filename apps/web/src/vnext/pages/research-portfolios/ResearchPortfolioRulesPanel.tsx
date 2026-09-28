import { ResearchPortfolioAuthorityBoundary } from './research-portfolio-authority.js';
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  PreviewResearchPortfolioRuleDto,
  ResearchPortfolioDetailDto,
  ResearchPortfolioRuleCandidateDto,
  ResearchPortfolioRuleNode,
  ResearchPortfolioRulePreviewDto,
  ResearchPortfolioRuleVersionDto,
  ResearchPortfolioTemplateDto,
  ResearchTaxonomyVersionDto,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { newIdempotencyKey } from './research-portfolios-api.js';

const DEFAULT_EXPRESSION = JSON.stringify({ kind: 'condition', field: 'component', operator: 'eq', value: 'Army' }, null, 2);

export function ResearchPortfolioRulesPanel(props: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  return (
    <ResearchPortfolioAuthorityBoundary>
      <ResearchPortfolioRulesPanelContent key={props.portfolio.id} {...props} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function ResearchPortfolioRulesPanelContent({ portfolio, canEdit, onDone }: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [expressionText, setExpressionText] = useState(DEFAULT_EXPRESSION);
  const [readable, setReadable] = useState('Component is Army');
  const [mode, setMode] = useState<'rules' | 'hybrid'>(portfolio.mode === 'rules' ? 'rules' : 'hybrid');
  const [qualificationPolicyText, setQualificationPolicyText] = useState(JSON.stringify({ autoAdd: false, minimumQualification: 'reviewed' }, null, 2));
  const [taxonomyVersionId, setTaxonomyVersionId] = useState<string | null>(null);
  const [templateVersionId, setTemplateVersionId] = useState<string | null>(null);
  const [candidatesText, setCandidatesText] = useState(() => JSON.stringify(
    portfolio.members.map((member) => ({ targetKind: member.targetKind, targetId: member.targetId, label: member.label, facts: { entityKind: member.targetKind }, completeness: member.disposition === 'unresolved' ? 'unresolved' : 'complete' })),
    null,
    2,
  ));
  const [previewResult, setPreviewResult] = useState<ResearchPortfolioRulePreviewDto | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  const rules = useQuery({ queryKey: ['research-portfolios', portfolio.id, 'rules'], queryFn: async () => (await api.get<ResearchPortfolioRuleVersionDto[]>(`/api/research-portfolios/${portfolio.id}/rules`)).data });
  const templates = useQuery({ queryKey: ['research-portfolios', 'templates'], queryFn: async () => (await api.get<ResearchPortfolioTemplateDto[]>('/api/research-portfolios/templates')).data });
  const taxonomy = useQuery({ queryKey: ['research-portfolios', 'taxonomy'], queryFn: async () => (await api.get<ResearchTaxonomyVersionDto[]>('/api/research-portfolios/taxonomy')).data });

  const selectedTaxonomy = taxonomyVersionId ?? taxonomy.data?.[0]?.id ?? null;
  const preview = useMutation({
    mutationFn: async (body: PreviewResearchPortfolioRuleDto) => (await api.post<ResearchPortfolioRulePreviewDto>(`/api/research-portfolios/${portfolio.id}/rules/preview`, body)).data,
    onSuccess: (result) => { setPreviewResult(result); setInputError(null); },
  });
  const publish = useMutation({
    mutationFn: async (result: ResearchPortfolioRulePreviewDto) => (await api.post<ResearchPortfolioRuleVersionDto>(`/api/research-portfolios/${portfolio.id}/rules`, { expectedRevision: portfolio.revision, previewId: result.previewId, previewHash: result.previewHash, idempotencyKey: newIdempotencyKey('rule-publish') })).data,
    onSuccess: async (result) => { setPreviewResult(null); await onDone(`Rule version published; bounded recomputation is ${result.recompute?.status ?? 'recorded'}.`); await rules.refetch(); },
  });

  function submitPreview(event: FormEvent) {
    event.preventDefault();
    try {
      const expression = JSON.parse(expressionText) as ResearchPortfolioRuleNode;
      const candidates = JSON.parse(candidatesText) as ResearchPortfolioRuleCandidateDto[];
      const qualificationPolicy = JSON.parse(qualificationPolicyText) as Record<string, unknown>;
      if (!Array.isArray(candidates)) throw new Error('Candidates must be a JSON array.');
      if (!qualificationPolicy || Array.isArray(qualificationPolicy) || typeof qualificationPolicy !== 'object') throw new Error('Qualification policy must be a JSON object.');
      preview.mutate({ expectedRevision: portfolio.revision, schemaVersion: 1, expression, readableExpression: readable.trim(), mode, qualificationPolicy, taxonomyVersionId: selectedTaxonomy, templateVersionId, candidates });
    } catch (error) {
      setInputError(error instanceof Error ? error.message : 'Rule input is invalid.');
    }
  }

  const current = useMemo(() => rules.data?.[0] ?? null, [rules.data]);
  return (
    <section className="rp-card">
      <div className="rp-row rp-row--spread"><div><h2>Rules and taxonomy</h2><p>Three-valued previews keep incomplete evidence unknown and never remove manual work.</p></div>{current ? <span className="rp-badge">Version {current.version} · {current.recompute?.status ?? 'published'}</span> : null}</div>
      <p className="rp-meta">Taxonomy: {taxonomy.data?.[0]?.label ?? 'No published taxonomy'} · Templates: {templates.data?.length ?? 0}</p>
      {canEdit ? (
        <form className="rp-form" onSubmit={submitPreview}>
          <label>Firm template version<select value={templateVersionId ?? ''} onChange={(event) => { const selected = templates.data?.flatMap((template) => template.versions.map((version) => ({ template, version }))).find(({ version }) => version.id === event.target.value); if (selected) { setTemplateVersionId(selected.version.id); setExpressionText(JSON.stringify(selected.version.expression, null, 2)); setReadable(selected.version.readableExpression); setMode(selected.version.mode === 'rules' ? 'rules' : 'hybrid'); setQualificationPolicyText(JSON.stringify(selected.version.qualificationPolicy, null, 2)); setTaxonomyVersionId(selected.version.taxonomyVersionId); setPreviewResult(null); } else { setTemplateVersionId(null); } }}><option value="">No template</option>{templates.data?.flatMap((template) => template.versions.map((version) => <option key={version.id} value={version.id}>{template.name} · v{version.version}</option>))}</select></label>
          <label>Automation mode<select value={mode} onChange={(event) => { setMode(event.target.value as 'rules' | 'hybrid'); setPreviewResult(null); }}><option value="hybrid">Hybrid</option><option value="rules">Dynamic rules</option></select></label>
          <label>Taxonomy version<select value={selectedTaxonomy ?? ''} onChange={(event) => { setTaxonomyVersionId(event.target.value || null); setPreviewResult(null); }}><option value="">No taxonomy version</option>{taxonomy.data?.map((version) => <option key={version.id} value={version.id}>{version.label} · v{version.version}</option>)}</select></label>
          <label>Readable expression<input value={readable} onChange={(event) => setReadable(event.target.value)} required /></label>
          <div className="rp-rule-editors"><label>Expression AST<textarea value={expressionText} onChange={(event) => { setExpressionText(event.target.value); setPreviewResult(null); }} rows={10} spellCheck={false} /></label><label>Qualification policy<textarea value={qualificationPolicyText} onChange={(event) => { setQualificationPolicyText(event.target.value); setPreviewResult(null); }} rows={10} spellCheck={false} /></label><label>Candidate facts<textarea value={candidatesText} onChange={(event) => { setCandidatesText(event.target.value); setPreviewResult(null); }} rows={10} spellCheck={false} /></label></div>
          {inputError ? <p className="rp-error" role="alert">{inputError}</p> : null}
          <button className="rp-button" disabled={preview.isPending}>{preview.isPending ? 'Evaluating…' : 'Preview rule'}</button>
        </form>
      ) : null}
      {preview.error ? <p className="rp-error" role="alert">The rule preview was rejected. Check fields, operators, types, and the current revision.</p> : null}
      {previewResult ? <div className="rp-rule-preview"><div className="rp-row rp-row--spread"><p><strong>{previewResult.complete ? 'Complete preview' : 'Partial preview'}</strong> · {previewResult.items.length} evaluated</p><button className="rp-button rp-button--primary" onClick={() => publish.mutate(previewResult)} disabled={publish.isPending}>Publish this preview</button></div><ul className="rp-list">{previewResult.items.map((item) => <li className="rp-list__item" key={`${item.targetKind}:${item.targetId}`}><span>{item.label || item.targetId}{item.reasons.length ? <small>{item.reasons.join('; ')}</small> : null}</span><span className={`rp-badge rp-badge--${item.result}`}>{item.disposition} · {item.result}</span></li>)}</ul></div> : null}
      {publish.error ? <p className="rp-error" role="alert">Publication failed because the preview expired or the portfolio changed. Refresh the preview.</p> : null}
    </section>
  );
}
