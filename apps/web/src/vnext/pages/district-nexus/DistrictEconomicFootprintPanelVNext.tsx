import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useApi } from '../../../lib/use-api.js';
import { formatMoney, formatNumber, splitDistrictKey } from '../../../pages/intelligence/district-nexus/district-nexus-format.js';

interface FootprintEvidenceRecord {
  id: string;
  evidenceType: string;
  subjectName: string | null;
  state: string | null;
  congressionalDistrict: string | null;
  boundaryCongress: number | null;
  numericValue: number | null;
  unit: string | null;
  reviewStatus: 'pending_review' | 'approved' | 'rejected';
  verificationStatus: string;
  externalUseApproved: boolean;
  promotedFacilityId: string | null;
  createdAt: string;
}

interface FootprintImportSummary {
  id: string;
  filename: string;
  format: string;
  status: string;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
}

interface ClientEconomicFootprintResponse {
  clientId: string;
  districts: Array<{
    districtKey: string;
    approvedEvidenceCount: number;
    pendingEvidenceCount: number;
    facilityCount: number;
    employeeCount: number | null;
    payroll: number | null;
    capitalInvestment: number | null;
    taxes: number | null;
    supplierCount: number;
    supplierSpend: number | null;
    partnerCount: number;
    beneficiaryCount: number | null;
    projectSiteCount: number;
    boundaryCongresses: number[];
  }>;
  imports: FootprintImportSummary[];
  evidence: FootprintEvidenceRecord[];
  coverage: { percent: number; measured: string[]; missing: string[] };
  totals: {
    approvedEvidenceCount: number;
    pendingEvidenceCount: number;
    facilityCount: number;
    employeeCount: number | null;
    payroll: number | null;
    capitalInvestment: number | null;
    taxes: number | null;
    supplierCount: number;
    supplierSpend: number | null;
    partnerCount: number;
    beneficiaryCount: number | null;
    projectSiteCount: number;
  };
  warnings: string[];
}

interface DistrictEconomicContextResponse {
  districtKey: string;
  metrics: Array<{
    source: 'acs' | 'cbp' | 'lodes';
    dataset: string;
    sourceYear: number;
    boundaryCongress: number | null;
    metricKey: string;
    value: number | null;
    unit: string | null;
    marginOfError: number | null;
    naicsCode: string | null;
    metadata: Record<string, unknown>;
  }>;
  sources: Array<{
    source: 'acs' | 'cbp' | 'lodes';
    dataset: string;
    sourceYear: number | null;
    status: string;
    lastAttemptAt: string;
    lastCompletedAt: string | null;
    rowsWritten: number;
    error: string | null;
    annual: true;
  }>;
  warnings: string[];
}

interface PreviewResponse {
  importId: string;
  filename: string;
  format: string;
  rowCount: number;
  evidenceCount: number;
  acceptedCount: number;
  rejectedCount: number;
  warnings: string[];
  evidence: Array<{
    previewId: string;
    evidenceType: string;
    subjectName: string | null;
    numericValue: number | null;
    unit: string | null;
    geography: {
      state: string | null;
      congressionalDistrict: string | null;
      boundaryCongress: number | null;
      districtSource: string;
    };
    warnings: string[];
  }>;
}

interface Props {
  clientId: string | null;
  districtKey: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function labelForMetric(metric: string): string {
  return metric
    .replace(/_usd$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function metricValue(value: number | null, unit: string | null): string {
  if (value == null) return 'Unavailable';
  if (unit === 'USD') return formatMoney(value);
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  return formatNumber(value);
}

/**
 * Release 3 panel. Client-owned approved evidence, pending review, and public
 * district context are rendered in separate blocks. The component never adds
 * ACS/CBP/LODES context to a client total, and never renders missing money as
 * $0. Disabled Release 3 routes fail closed with 404 and are treated as not yet
 * enabled rather than as an empty footprint.
 */
export function DistrictEconomicFootprintPanelVNext({ clientId, districtKey }: Props) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { state, districtNo } = splitDistrictKey(districtKey);
  const footprint = useQuery<ClientEconomicFootprintResponse>({
    queryKey: ['district-nexus', 'economic-footprint', clientId],
    queryFn: async () =>
      (await api.get<ClientEconomicFootprintResponse>(
        `/api/intelligence/clients/${encodeURIComponent(clientId!)}/district-nexus-v2/economic-footprint`,
      )).data,
    enabled: Boolean(clientId),
    retry: false,
  });
  const context = useQuery<DistrictEconomicContextResponse>({
    queryKey: ['district-nexus', 'economic-context', state, districtNo],
    queryFn: async () =>
      (await api.get<DistrictEconomicContextResponse>(
        `/api/intelligence/district-nexus/districts/${encodeURIComponent(state)}/${encodeURIComponent(districtNo)}/economic-context`,
      )).data,
    enabled: Boolean(state && districtNo),
    retry: false,
  });

  if (context.isPending || (clientId && footprint.isPending)) {
    return (
      <div className="dnx-skel-rows" aria-busy="true">
        <CapiroSkeleton height={14} width="48%" />
        <CapiroSkeleton height={14} width="85%" />
        <CapiroSkeleton height={14} width="70%" />
      </div>
    );
  }

  const footprintDisabled = footprint.error && (footprint.error as { response?: { status?: number } }).response?.status === 404;
  const contextDisabled = context.error && (context.error as { response?: { status?: number } }).response?.status === 404;

  return (
    <div className="dnx-economic">
      {clientId ? (
        footprintDisabled ? (
          <HonestUnavailable text="First-party economic footprint import is not enabled for this tenant." />
        ) : footprint.isError ? (
          <CapiroErrorState title="Client economic footprint could not load" description="This is an error, not a zero footprint." />
        ) : footprint.data ? (
          <ClientFootprintBlock data={footprint.data} districtKey={districtKey} clientId={clientId} />
        ) : null
      ) : (
        <HonestUnavailable text="Select a client to view approved first-party facilities, jobs, payroll, investment, taxes, and suppliers." />
      )}

      {contextDisabled ? (
        <HonestUnavailable text="Public district economic context is not enabled for this tenant." />
      ) : context.isError ? (
        <CapiroErrorState title="District economic context could not load" description="Capiro will not substitute zeroes for a failed public-data read." />
      ) : context.data ? (
        <PublicContextBlock data={context.data} />
      ) : null}

      {clientId && !footprintDisabled ? (
        <FootprintImportBlock
          clientId={clientId}
          onCommitted={() =>
            void queryClient.invalidateQueries({ queryKey: ['district-nexus', 'economic-footprint', clientId] })
          }
        />
      ) : null}
    </div>
  );
}

function ClientFootprintBlock({
  data,
  districtKey,
  clientId,
}: {
  data: ClientEconomicFootprintResponse;
  districtKey: string;
  clientId: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const district = data.districts.find((row) => row.districtKey === districtKey);
  const districtEvidence = data.evidence.filter(
    (row) => row.state && row.congressionalDistrict && `${row.state}-${row.congressionalDistrict}` === districtKey,
  );
  const decision = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'approve' | 'reject' }) =>
      (
        await api.post(
          `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-v2/footprint-evidence/${encodeURIComponent(id)}/${action}`,
          action === 'approve' ? { externalUseApproved: false } : {},
        )
      ).data,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['district-nexus', 'economic-footprint', clientId] }),
  });

  return (
    <div className="dnx-economic-block">
      <div className="dnx-list-label">Client-provided economic footprint</div>
      <div className="dnx-muted" style={{ marginBottom: 10 }}>
        Approved facts only. Pending imports never change the Nexus map; an approved facility is promoted into the existing facility truth rail.
      </div>
      <div className="dnx-dr-l2" style={{ marginBottom: 10 }}>
        <CapiroBadge tone="info">Coverage {data.coverage.percent}%</CapiroBadge>
        <CapiroBadge tone="neutral">{data.totals.approvedEvidenceCount} approved</CapiroBadge>
        {data.totals.pendingEvidenceCount ? (
          <CapiroBadge tone="warning">{data.totals.pendingEvidenceCount} pending</CapiroBadge>
        ) : null}
      </div>
      {district ? (
        <dl className="dnx-kv">
          <dt>Facilities</dt><dd>{district.facilityCount}</dd>
          <dt>Employees</dt><dd>{formatNumber(district.employeeCount)}</dd>
          <dt>Payroll</dt><dd>{formatMoney(district.payroll)}</dd>
          <dt>Capital investment</dt><dd>{formatMoney(district.capitalInvestment)}</dd>
          <dt>Taxes paid</dt><dd>{formatMoney(district.taxes)}</dd>
          <dt>Suppliers</dt><dd>{district.supplierCount}</dd>
          <dt>Supplier spend</dt><dd>{formatMoney(district.supplierSpend)}</dd>
        </dl>
      ) : (
        <HonestUnavailable text="No imported client evidence is currently placed in this district." />
      )}
      {data.coverage.missing.length ? (
        <div className="dnx-hint dnx-info" style={{ marginTop: 10 }}>
          Missing inputs: {data.coverage.missing.join(', ')}. Missing means unmeasured, not zero.
        </div>
      ) : null}
      {districtEvidence.length ? (
        <div style={{ marginTop: 12 }}>
          {districtEvidence.slice(0, 12).map((row) => (
            <div className="dnx-pop-row" key={row.id}>
              <div>
                <b>{labelForMetric(row.evidenceType)}</b>
                <div className="dnx-muted">
                  {row.subjectName ?? 'No subject name'} · {row.verificationStatus.replace(/_/g, ' ')}
                  {row.promotedFacilityId ? ' · promoted to facility' : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div>{row.numericValue == null ? '—' : metricValue(row.numericValue, row.unit)}</div>
                {row.reviewStatus === 'pending_review' ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                    <CapiroButton size="compact" onClick={() => decision.mutate({ id: row.id, action: 'approve' })}>
                      Approve
                    </CapiroButton>
                    <CapiroButton variant="quiet" size="compact" onClick={() => decision.mutate({ id: row.id, action: 'reject' })}>
                      Reject
                    </CapiroButton>
                  </div>
                ) : (
                  <CapiroBadge tone={row.reviewStatus === 'approved' ? 'success' : 'neutral'}>{row.reviewStatus}</CapiroBadge>
                )}
              </div>
            </div>
          ))}
          {decision.isError ? (
            <div className="dnx-hint dnx-notable">Approval failed. Administrative review permission may be required.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PublicContextBlock({ data }: { data: DistrictEconomicContextResponse }) {
  const currentMetrics = useMemo(() => {
    const latest = new Map<string, DistrictEconomicContextResponse['metrics'][number]>();
    for (const metric of data.metrics) {
      const key = `${metric.source}:${metric.naicsCode ?? 'all'}:${metric.metricKey}`;
      if (!latest.has(key)) latest.set(key, metric);
    }
    return [...latest.values()];
  }, [data.metrics]);
  const headline = currentMetrics.filter((metric) =>
    ['total_population', 'median_household_income_usd', 'employment', 'establishments', 'annual_payroll_usd', 'jobs_total'].includes(metric.metricKey),
  );

  return (
    <div className="dnx-economic-block" style={{ marginTop: 16 }}>
      <div className="dnx-list-label">Public district economic context</div>
      <div className="dnx-muted" style={{ marginBottom: 10 }}>
        ACS, County Business Patterns, and LODES describe the district. They are context—not proof that this client created these jobs or dollars.
      </div>
      {headline.length ? (
        <div className="dnx-economic-grid">
          {headline.slice(0, 10).map((metric) => (
            <div className="dnx-economic-card" key={`${metric.source}:${metric.naicsCode}:${metric.metricKey}`}>
              <div className="dnx-k">{labelForMetric(metric.metricKey)}</div>
              <div className="dnx-v" style={{ fontSize: 18 }}>{metricValue(metric.value, metric.unit)}</div>
              <div className="dnx-s">
                {metric.source.toUpperCase()} {metric.sourceYear}
                {metric.naicsCode ? ` · NAICS ${metric.naicsCode}` : ''}
                {metric.marginOfError != null ? ` · ±${formatNumber(metric.marginOfError)}` : ''}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <HonestUnavailable text="No public economic facts are loaded for this district yet." />
      )}
      <div className="dnx-dr-l2" style={{ marginTop: 10 }}>
        {data.sources.map((source) => (
          <CapiroBadge key={`${source.source}:${source.dataset}`} tone={source.status === 'success' ? 'success' : source.status === 'unavailable' ? 'neutral' : 'warning'}>
            {source.source.toUpperCase()} · {source.sourceYear ?? 'year unknown'} · {source.status.replace(/_/g, ' ')}
          </CapiroBadge>
        ))}
      </div>
      {data.warnings.map((warning) => (
        <div className="dnx-hint dnx-info" key={warning}>{warning}</div>
      ))}
    </div>
  );
}

function FootprintImportBlock({ clientId, onCommitted }: { clientId: string; onCommitted: () => void }) {
  const api = useApi();
  const [file, setFile] = useState<File | null>(null);
  const [manualJson, setManualJson] = useState('[\n  {\n    "facilityName": "",\n    "addressLine1": "",\n    "city": "",\n    "state": "",\n    "employeeCount": null\n  }\n]');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const previewMutation = useMutation({
    mutationFn: async () => {
      if (file) {
        const extension = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
        return (
          await api.post<PreviewResponse>(
            `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-v2/footprint-imports/preview`,
            {
              filename: file.name,
              format: extension,
              contentBase64: await fileToBase64(file),
            },
          )
        ).data;
      }
      const rows = JSON.parse(manualJson) as unknown[];
      return (
        await api.post<PreviewResponse>(
          `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-v2/footprint-imports/preview`,
          {
            filename: 'manual-or-meri-structured.json',
            format: 'meri_structured',
            rows,
          },
        )
      ).data;
    },
    onSuccess: setPreview,
  });
  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('Preview first');
      return (
        await api.post(
          `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-v2/footprint-imports/${encodeURIComponent(preview.importId)}/commit`,
        )
      ).data;
    },
    onSuccess: () => {
      setPreview(null);
      setFile(null);
      onCommitted();
    },
  });

  return (
    <div className="dnx-economic-block" style={{ marginTop: 16 }}>
      <div className="dnx-list-label">Add economic-footprint evidence</div>
      <div className="dnx-muted" style={{ marginBottom: 10 }}>
        CSV/XLSX, manual rows, or structured rows reviewed from Meri. Preview and geocode first; commit creates pending evidence only.
      </div>
      <input
        aria-label="Economic footprint CSV or XLSX"
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <div className="dnx-muted" style={{ margin: '8px 0' }}>Or paste manual / Meri-structured rows:</div>
      <textarea
        aria-label="Structured economic footprint rows"
        value={manualJson}
        onChange={(event) => setManualJson(event.target.value)}
        rows={7}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <CapiroButton size="compact" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
          {previewMutation.isPending ? 'Preparing preview…' : 'Preview import'}
        </CapiroButton>
        {preview ? (
          <CapiroButton size="compact" onClick={() => commitMutation.mutate()} disabled={commitMutation.isPending || preview.acceptedCount === 0}>
            {commitMutation.isPending ? 'Committing…' : `Commit ${preview.acceptedCount} evidence records`}
          </CapiroButton>
        ) : null}
      </div>
      {previewMutation.isError ? (
        <div className="dnx-hint dnx-notable" style={{ marginTop: 8 }}>The import could not be previewed. Check the file/JSON and try again.</div>
      ) : null}
      {preview ? (
        <div style={{ marginTop: 12 }}>
          <div className="dnx-dr-l2">
            <CapiroBadge tone="info">{preview.rowCount} source rows</CapiroBadge>
            <CapiroBadge tone="success">{preview.acceptedCount} valid evidence</CapiroBadge>
            {preview.rejectedCount ? <CapiroBadge tone="warning">{preview.rejectedCount} blocked</CapiroBadge> : null}
          </div>
          {preview.evidence.slice(0, 10).map((row) => (
            <div className="dnx-pop-row" key={row.previewId}>
              <div>
                <b>{labelForMetric(row.evidenceType)}</b> · {row.subjectName ?? 'unnamed'}
                <div className="dnx-muted">
                  {row.geography.state && row.geography.congressionalDistrict
                    ? `${row.geography.state}-${row.geography.congressionalDistrict}`
                    : 'district unresolved'}
                  {' · '}{row.geography.districtSource.replace(/_/g, ' ')}
                </div>
              </div>
              <div>{row.numericValue == null ? '—' : metricValue(row.numericValue, row.unit)}</div>
            </div>
          ))}
          {preview.warnings.slice(0, 6).map((warning) => (
            <div className="dnx-hint dnx-info" key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HonestUnavailable({ text }: { text: string }) {
  return <div className="dnx-hint dnx-info">{text}</div>;
}
