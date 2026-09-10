import type { DossierProvenance } from './bill-360.types.js';
const time = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : 'Unknown';
export function BillSourceHealth({ provenance: p }: { provenance: DossierProvenance }) {
  if (!p.sourceCheckStatus) return null;
  return (
    <section aria-label="Source check status" className="lw-folder-context">
      <h3>Source check</h3>
      <dl>
        <dt>Latest check result</dt>
        <dd>{p.sourceCheckStatus === 'unknown' ? 'Not checked' : p.sourceCheckStatus}</dd>
        <dt>Last successful source check</dt>
        <dd>{time(p.sourceCheckedAt)}</dd>
        <dt>Last attempted check</dt>
        <dd>{time(p.sourceCheckAttemptedAt)}</dd>
        <dt>Last successful ingestion</dt>
        <dd>{time(p.lastSyncedAt)}</dd>
        <dt>Source document date</dt>
        <dd>{p.documentDate?.slice(0, 10) ?? 'Unknown'}</dd>
      </dl>
      {p.sourceCheckReason && <p>{p.sourceCheckReason}</p>}
    </section>
  );
}
