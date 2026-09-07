import type { ChatMessageRetrieval } from '../../components/chat/chat-store.js';
import { meriCoverageReason } from '../../components/chat/meri-retrieval-metadata.js';

const label = (value: string) =>
  value.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

export function MeriRetrievalCoverage({ retrieval }: { retrieval: ChatMessageRetrieval }) {
  const coverage = retrieval.coverage;
  const health = coverage.sourceHealth ?? [];
  const status = {
    complete: 'Retrieved',
    partial: 'Partial',
    error: 'Read failed',
    unavailable: 'Unavailable',
  };
  return (
    <section className="vnext-meri__evidence-section" aria-label="Initial context coverage">
      <div className="vnext-meri__evidence-section-label">INITIAL CONTEXT COVERAGE</div>
      <p>{meriCoverageReason(coverage.stopReason)}.</p>
      {coverage.recordsReturned !== undefined ? (
        <p>
          {coverage.recordsReturned} records returned
          {coverage.recordsEvaluated !== undefined
            ? ` · ${coverage.recordsEvaluated} records evaluated`
            : ''}
          .
        </p>
      ) : null}
      {coverage.requestedEntityCount != null && coverage.searchedEntityCount != null ? (
        <p>
          {coverage.searchedEntityCount} of {coverage.requestedEntityCount} requested entities
          searched.
        </p>
      ) : null}
      {coverage.paginationComplete === false ? (
        <p>Additional result pages were not fully read.</p>
      ) : null}
      {coverage.truncated ? <p>Some records or text were shortened or omitted.</p> : null}
      {retrieval.plan.timeWindow ? (
        <p>Requested period: {retrieval.plan.timeWindow.expression}.</p>
      ) : null}
      {health.length ? (
        <table aria-label="Source coverage and freshness">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Coverage</th>
              <th scope="col">Source timestamp (UTC)</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {health.map((source) => (
              <tr key={source.source}>
                <th scope="row">{label(source.source)}</th>
                <td>{status[source.status]}</td>
                <td>
                  {source.lastSyncAt
                    ? new Date(source.lastSyncAt)
                        .toISOString()
                        .replace('T', ' ')
                        .replace('.000Z', ' UTC')
                    : 'Not reported'}
                </td>
                <td>{source.detail ? meriCoverageReason(source.detail) : 'Not reported'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {(coverage.unavailableSources ?? []).length ? (
        <ul>
          {coverage.unavailableSources!.map((source) => (
            <li key={source.source}>
              {label(source.source)}: {meriCoverageReason(source.reason)}.
            </li>
          ))}
        </ul>
      ) : null}
      {health.length ? (
        <p>
          Use the cited document’s date and stage to assess currency; this timestamp alone does not
          establish that a fact is current.
        </p>
      ) : null}
    </section>
  );
}
