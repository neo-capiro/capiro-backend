import { useQuery } from '@tanstack/react-query';
import type { DefenseDossierFieldDto } from '@capiro/shared';
import { useApi } from '../../../../lib/use-api.js';
import { getDefenseDossier } from '../defense-research-api.js';
import { PfCard } from './pe-profile-primitives.js';

const labels: Record<string, string> = {
  mission: 'Mission',
  plans: 'Plans',
  accomplishments: 'Accomplishments',
  strategy_alignment: 'Strategy alignment',
  performance_measures: 'Performance measures',
  related_program_funding: 'Related program funding',
  remarks: 'Remarks',
  analyst_questions: 'Analyst questions',
};

function sourceContextUrl(value: string | null): string | null {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function NarrativeField({ field }: { field: DefenseDossierFieldDto }) {
  return (
    <section aria-label={labels[field.field] ?? field.field} style={{ padding: '12px 16px' }}>
      <h3>{labels[field.field] ?? field.field}</h3>
      <p>Availability: {field.availability}</p>
      {field.value !== null ? (
        <p style={{ whiteSpace: 'pre-wrap' }}>{field.value}</p>
      ) : (
        <p>No field value supplied.</p>
      )}
      {field.reason ? <p>{field.reason}</p> : null}
      {[field.fiscalPeriod, field.metric, field.unit].some((value) => value !== null) ? (
        <p>
          {[field.fiscalPeriod, field.metric, field.unit]
            .filter((value) => value !== null)
            .join(' · ')}
        </p>
      ) : null}
      {field.evidence.length ? (
        <details>
          <summary>Source context ({field.evidence.length})</summary>
          <p>
            Contextual citations do not establish field-specific provenance unless the field
            projection says so.
          </p>
          <ul>
            {field.evidence.map((evidence) => (
              <li key={evidence.evidenceRefId}>
                {sourceContextUrl(evidence.sourceUrl) ? (
                  <a href={sourceContextUrl(evidence.sourceUrl)!} target="_blank" rel="noreferrer">
                    {evidence.publisher ?? evidence.sourceFamily}
                  </a>
                ) : (
                  <span>
                    {evidence.publisher ?? evidence.sourceFamily} · source URL unavailable
                  </span>
                )}
                {evidence.nativeLocator.page !== null ? (
                  <span> · page {evidence.nativeLocator.page}</span>
                ) : null}
                {evidence.nativeLocator.section !== null ? (
                  <span> · section {evidence.nativeLocator.section}</span>
                ) : null}
                {evidence.nativeLocator.occurrenceId !== null ? (
                  <span> · occurrence {evidence.nativeLocator.occurrenceId}</span>
                ) : null}
                {evidence.sourceRevisionId !== null ? (
                  <span> · revision {evidence.sourceRevisionId}</span>
                ) : null}
                {evidence.availability ? <span> · {evidence.availability}</span> : null}
                {evidence.reason ? <p>{evidence.reason}</p> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p>Field-specific source context is unavailable.</p>
      )}
    </section>
  );
}

export function PeDossierNarrative({
  peCode,
  description,
}: {
  peCode: string;
  description: string | null;
}) {
  const api = useApi();
  const dossier = useQuery({
    queryKey: ['defense-dossier', 'program_element', peCode],
    queryFn: () => getDefenseDossier(api, 'program_element', peCode),
  });
  const hasFields = Boolean(dossier.data?.fields.length);
  const coverageReason = (dossier.data?.coverage as { reason?: string | null } | undefined)?.reason;
  return (
    <PfCard title="Program narrative">
      {dossier.isPending ? (
        <p role="status" style={{ padding: 16 }}>
          Loading dossier fields…
        </p>
      ) : null}
      {dossier.isError ? (
        <p role="alert" style={{ padding: 16 }}>
          Dossier fields could not be refreshed. Current availability is unknown; retained fields
          remain below.
        </p>
      ) : null}
      {dossier.data ? (
        <p style={{ padding: '0 16px' }}>
          Dossier coverage: {dossier.data.coverage.state} · {dossier.data.coverage.availableFields}{' '}
          available / {dossier.data.coverage.partialFields} partial /{' '}
          {dossier.data.coverage.unavailableFields} unavailable of{' '}
          {dossier.data.coverage.expectedFields} expected fields
        </p>
      ) : null}
      {coverageReason ? <p style={{ padding: '0 16px' }}>{coverageReason}</p> : null}
      {dossier.data?.fields.map((field) => (
        <NarrativeField key={field.field} field={field} />
      ))}
      {!hasFields ? (
        <section style={{ padding: 16 }} aria-label="Canonical description fallback">
          <h3>Canonical description · partial provenance</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>
            {description?.trim() ? description : 'Canonical description is unavailable.'}
          </p>
          <p>
            Field-specific narrative and source association are not established by this fallback.
          </p>
        </section>
      ) : null}
    </PfCard>
  );
}
