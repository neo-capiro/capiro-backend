import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import { KEYWORD_BASE } from './KeywordReview.js';
type Stage = {
  id: string;
  sourceId: string;
  version: number;
  sourceHash: string;
  state: string;
  payload: Record<string, any>;
  promotion: { targetId: string } | null;
};
export type ImportLedger = {
  actorId: string;
  definitions: Array<{ sourceId: string; compiled: { status: string } | null }>;
  rules: Stage[];
  channels: Array<{ sourceId: string; payload: Record<string, any> }>;
  currentStaff: Array<{ userId: string; email: string }>;
};
export function KeywordImportReview({
  identity,
  jurisdiction,
  sessionKey,
  onPromote,
  onInspect,
}: {
  identity: string;
  jurisdiction: string;
  sessionKey: string;
  onPromote: (row: Stage) => void;
  onInspect: (id: string) => void;
}) {
  const api = useApi(),
    [open, setOpen] = useState(false);
  const data = useQuery({
    queryKey: ['lw-keywords', identity, 'staged'],
    enabled: open,
    queryFn: async () =>
      (
        await api.get<ImportLedger>(
          KEYWORD_BASE + '/staged?sourceAccount=' + encodeURIComponent('lobbytools:rubin-turnbull'),
        )
      ).data,
    retry: false,
  });
  return (
    <div className="lw-keywords-rule">
      <CapiroButton size="compact" onClick={() => setOpen(!open)} aria-expanded={open}>
        Imported rule readiness
      </CapiroButton>
      {open ? (
        <>
          <p>
            Review exact source selections, owner mappings and cadence. Promotion creates an
            inactive rule.
          </p>
          {data.isPending ? <p role="status">Loading imported configuration…</p> : null}
          {data.error ? (
            <p role="alert">Import review requires current administrator access.</p>
          ) : null}
          {data.data ? (
            <>
              <p>
                {data.data.definitions.length} definitions ·{' '}
                {data.data.definitions.filter((d) => d.compiled?.status === 'supported').length}{' '}
                supported · {data.data.rules.length} captured rules
              </p>
              <div className="lw-keywords-table-scroll">
                <table className="lw-keywords-import">
                  <thead>
                    <tr>
                      <th>Captured rule</th>
                      <th>Selected definitions</th>
                      <th>Cadence</th>
                      <th>Staff channels</th>
                      <th>Readiness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.rules.map((r) => {
                      const selected = (r.payload.selected_targets ?? [])
                        .filter((g: any) => g.type === 'keyword')
                        .flatMap((g: any) => g.selected ?? []);
                      const channels = data.data!.channels.filter(
                        (c) => c.payload.alert_key === r.payload.audit_key,
                      );
                      const unsupported = selected.filter(
                        (s: any) =>
                          data.data!.definitions.find((d) => d.sourceId === s.id)?.compiled
                            ?.status !== 'supported',
                      ).length;
                      return (
                        <tr key={r.id}>
                          <td>
                            {r.payload.name}
                            <br />
                            {r.payload.audit_key}
                          </td>
                          <td>
                            {selected.length}
                            {unsupported ? ' · ' + unsupported + ' need review' : ''}
                          </td>
                          <td>{r.payload.frequency?.join(', ')}</td>
                          <td>
                            {channels.filter((c) => c.payload.email_selected).length} email ·{' '}
                            {channels.filter((c) => c.payload.notification_selected).length} in app
                          </td>
                          <td>
                            {selected.length
                              ? 'Owner, targets and interpretation need review'
                              : 'Empty rule · blocked'}
                            <br />
                            <CapiroButton
                              size="compact"
                              disabled={!sessionKey}
                              onClick={() =>
                                r.promotion ? onInspect(r.promotion.targetId) : onPromote(r)
                              }
                            >
                              {r.promotion ? 'Inspect mapped rule' : 'Promote inactive'}
                            </CapiroButton>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p>
                Scope for promotion: {jurisdiction} {sessionKey || 'Select a session'} · retained
                bill text. All source definitions remain preserved.
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
export function ImportedMappings({
  ledger,
  stagedId,
  onReview,
}: {
  ledger: ImportLedger;
  stagedId: string;
  onReview: (mapping: Record<string, string>) => void;
}) {
  const [mapping, setMapping] = useState<Record<string, string>>({}),
    [reviewed, setReviewed] = useState(false);
  const staged = ledger.rules.find((r) => r.id === stagedId);
  if (!staged) return null;
  const channels = ledger.channels.filter(
    (c) =>
      c.payload.alert_key === staged.payload.audit_key &&
      (c.payload.email_selected || c.payload.notification_selected),
  );
  return (
    <details>
      <summary>Review owner and captured staff subscriptions</summary>
      <p>
        Current owner will be the reviewing administrator. Select current staff identities for the
        captured channel choices.
      </p>
      {channels.map((c) => (
        <CapiroSelect
          key={c.sourceId}
          label={
            String(c.payload.user_name ?? c.payload.user_id) +
            ' · ' +
            [
              c.payload.email_selected ? 'email' : '',
              c.payload.notification_selected ? 'in app' : '',
            ]
              .filter(Boolean)
              .join(', ')
          }
          value={mapping[String(c.payload.user_id)] ?? ''}
          options={[
            { value: '', label: 'Select current staff' },
            ...ledger.currentStaff.map((s) => ({ value: s.userId, label: s.email })),
          ]}
          onChange={(e) => setMapping({ ...mapping, [String(c.payload.user_id)]: e.target.value })}
        />
      ))}
      <label>
        <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />{' '}
        I reviewed the source creator and these staff mappings.
      </label>
      <CapiroButton
        size="compact"
        disabled={!reviewed || channels.some((c) => !mapping[String(c.payload.user_id)])}
        onClick={() => onReview(mapping)}
      >
        Save reviewed mappings, keep inactive
      </CapiroButton>
    </details>
  );
}
