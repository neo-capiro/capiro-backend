import type { ChatMessageRetrieval } from '../../components/chat/chat-store.js';
import { meriCoverageReason, meriCoverageSourceLabel } from '../../components/chat/meri-retrieval-metadata.js';

const label = meriCoverageSourceLabel;
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not reported';

export function MeriRetrievalCoverage({ retrieval }: { retrieval: ChatMessageRetrieval }) {
  const coverage = retrieval.coverage;
  const health = coverage.sourceHealth ?? [];
  const turn = coverage.phase === 'turn';
  const initial = coverage.initialContext;
  const reads = coverage.toolReads ?? [];
  const status = {
    complete: 'Retrieved',
    partial: 'Partial',
    error: 'Read failed',
    unavailable: 'Unavailable',
  };
  return (
    <section className="vnext-meri__evidence-section" aria-label={turn ? 'Turn source coverage' : 'Initial context coverage'}>
      <div className="vnext-meri__evidence-section-label">{turn ? 'TURN SOURCE COVERAGE' : 'INITIAL CONTEXT COVERAGE'}</div>
      <p>{meriCoverageReason(coverage.stopReason)}.</p>
      {turn ? <p>Initial context counts are shown first. Later reads are listed separately; repeated or overlapping reads are not added together.</p> : null}
      {coverage.recordsReturned !== undefined ? (
        <p>
          {coverage.recordsReturned} records returned
          {coverage.recordsEvaluated !== undefined
            ? ` · ${coverage.recordsEvaluated} records inspected`
            : ''}
          .
        </p>
      ) : null}
      {coverage.recordsDisplayed !== undefined ? <p>{coverage.recordsDisplayed} returned records displayed to the model{coverage.recordsOmitted !== undefined ? ` · ${coverage.recordsOmitted} omitted from model evidence` : ''}.</p> : null}
      {(coverage.sourceCounts?.length ?? 0) > 0 ? (
        <table aria-label="Initial source record counts">
          <thead><tr><th scope="col">Source</th><th scope="col">Record counts</th></tr></thead>
          <tbody>{coverage.sourceCounts!.map((source) => <tr key={source.source}>
            <th scope="row">{label(source.source)}</th><td><MeriRecordCounts counts={source} /></td>
          </tr>)}</tbody>
        </table>
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
                <td>{timestamp(source.lastSyncAt)}</td>
                <td>{source.detail ? meriCoverageReason(source.detail) : 'Not reported'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {initial && !initial.complete ? (
        <details>
          <summary>Initial context before later reads</summary>
          <p>{meriCoverageReason(initial.stopReason)}.</p>
          {(initial.sourceHealth ?? []).map((source) => (
            <p key={source.source}>{label(source.source)}: {status[source.status]}{source.detail ? ` — ${meriCoverageReason(source.detail)}` : ''}.</p>
          ))}
        </details>
      ) : null}
      {reads.length ? (
        <>
          <table aria-label="Subsequent tool reads">
            <thead><tr><th scope="col">Source</th><th scope="col">Read result</th><th scope="col">Record counts</th><th scope="col">Remaining gap</th><th scope="col">Source timestamp (UTC)</th></tr></thead>
            <tbody>{reads.map((read, index) => (
              <tr key={`${read.tool}-${read.source}-${index}`}>
                <th scope="row">{label(read.source)}{read.detail?.startsWith('profile_section:') ? ` · ${meriCoverageReason(read.detail)}` : ''}</th>
                <td>{status[read.status]} for this read</td>
                <td><MeriRecordCounts counts={read} /></td>
                <td>{[
                  read.status === 'error' || read.status === 'unavailable' ? 'This source could not be read' : null,
                  read.paginationComplete === false ? 'More pages remain' : null,
                  read.truncated ? 'Some content was shortened or omitted' : null,
                  read.paginationComplete === null ? 'Pagination not reported' : null,
                  read.detail && !read.detail.startsWith('profile_section:') && read.detail !== 'complete' ? meriCoverageReason(read.detail) : null,
                ].filter(Boolean).join('; ') || 'None reported for this read'}</td>
                <td>{timestamp(read.lastSyncAt)}</td>
              </tr>
            ))}</tbody>
          </table>
          <p>A completed read covers its requested query, page or section. It does not establish complete access to the source or all client records.</p>
        </>
      ) : null}
      {(coverage.unavailableSources ?? []).length ? (
        <ul>
          {coverage.unavailableSources!.map((source) => (
            <li key={`${source.source}-${source.reason}`}>
              {label(source.source)}: {meriCoverageReason(source.reason)}.
            </li>
          ))}
        </ul>
      ) : null}
      {coverage.sourceCounts?.length || reads.length ? <p>Matched counts describe the query or section, including other pages. Inspected counts are reported by the source. Displayed and omitted counts refer only to returned records in the model evidence. Unknown means the source did not report a count; shortened text is disclosed separately.</p> : null}
      {health.length || reads.length ? (
        <p>
          Use the cited document’s date and stage to assess currency; this timestamp alone does not
          establish that a fact is current.
        </p>
      ) : null}
    </section>
  );
}

function MeriRecordCounts({ counts }: { counts: {
  recordsMatched?: number | null; recordsEvaluated?: number | null;
  recordsReturned?: number | null; recordsDisplayed?: number | null; recordsOmitted?: number | null;
} }) {
  return <div>{([
    ['Matched', counts.recordsMatched], ['Inspected', counts.recordsEvaluated],
    ['Returned', counts.recordsReturned], ['Displayed', counts.recordsDisplayed], ['Omitted', counts.recordsOmitted],
  ] as const).map(([name, value]) => <div key={name}>{name}: {value ?? 'Unknown'}</div>)}</div>;
}
