import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useApi } from '../../../lib/use-api.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { NOTETAKER_CONSENT_COPY as consent } from '../../../pages/engagement/notetaker-consent-copy.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { UIcon } from './portfolio-primitives.js';

type Preference = { enabled: boolean; stopping: boolean };

export function ClientNotetakerAction({ client, onDialogChange }: { client: Client; onDialogChange: (open: boolean) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const key = ['client-notetaker', client.id];
  const url = `/api/engagement/clients/${client.id}/notetaker`;
  const [open, setOpenState] = useState(false);
  const setOpen = (value: boolean) => { setOpenState(value); onDialogChange(value); };
  const [authorized, setAuthorized] = useState(false);
  const [notified, setNotified] = useState(false);
  const preference = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<Preference>(url)).data,
    refetchInterval: 30_000,
  });
  const save = useMutation({
    mutationFn: async (enabled: boolean) => enabled
      ? (await api.post<Preference>(url, { authorizedToRecord: authorized, allPartiesWillBeNotified: notified })).data
      : (await api.delete<Preference>(url)).data,
    onSuccess: (value) => {
      qc.setQueryData(key, value);
      void qc.invalidateQueries({ queryKey: ['engagement-meetings'] });
      setOpen(false);
      toast.success(value.enabled
        ? `Meri will automatically join your meetings with ${client.name} until you turn this off.`
        : value.stopping
          ? 'Automatic attendance is off. Meri is still leaving a meeting; removal will be retried.'
          : 'Automatic attendance is off.');
    },
  });
  const error = save.error ?? preference.error;
  const errorMessage = isAxiosError(error) && typeof error.response?.data?.message === 'string'
    ? error.response.data.message : 'Could not update automatic attendance. Try again.';
  const enabled = preference.data?.enabled === true;

  return <>
    <button type="button" role="menuitem" className="cap-pf-meri-action-item"
      disabled={preference.isPending || save.isPending}
      onClick={() => {
        setAuthorized(false); setNotified(false); save.reset();
        if (preference.isError) void preference.refetch();
        setOpen(true);
      }}>
      <span className="cap-pf-meri-action-icon"><UIcon name="Calendar2" size={16} /></span>
      <span className="cap-pf-meri-action-body">
        <span className="cap-pf-meri-action-label">{enabled ? 'Turn off Meri for Meetings' : 'Send Meri to Meetings'}</span>
        <span className="cap-pf-meri-action-detail">{preference.isError
          ? 'Attendance setting unavailable. Click to retry.'
          : preference.data?.stopping ? 'Off · Meri is leaving a meeting.'
            : enabled ? 'On · Meri automatically joins your meetings with this client.'
              : 'Automatically take notes at your meetings with this client.'}</span>
      </span>
    </button>
    <EngagementDialog open={open} onClose={() => setOpen(false)} width={520}
      eyebrow="Client · meeting notetaker"
      title={enabled ? 'Turn off automatic attendance' : 'Send Meri to Meetings'}
      description={client.name} busy={save.isPending} busyLabel="Saving attendance…"
      error={error ? errorMessage : null}
      footer={<>
        <button type="button" className="cap-pf-notetaker-btn" disabled={save.isPending} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="cap-pf-notetaker-btn cap-pf-notetaker-btn--primary"
          disabled={preference.isPending || preference.isError || save.isPending || (!enabled && (!authorized || !notified))}
          onClick={() => save.mutate(!enabled)}>{enabled ? 'Turn off' : 'Enable automatic attendance'}</button>
      </>}>
      {enabled ? <p className="cap-pf-notetaker-info">Meri will stop joining your meetings with {client.name} and leave any meetings joined through this setting.</p> : <>
        <p className="cap-pf-notetaker-info">This applies to all current and future meetings on your calendar associated with {client.name}, until you turn it off. Meri joins around the start time when a supported meeting link is available. The confirmations below apply to each of those meetings.</p>
        <p className="cap-pf-notetaker-info">{consent.intro}</p>
        <label className="cap-pf-notetaker-consent"><input type="checkbox" checked={authorized} disabled={save.isPending} onChange={(e) => setAuthorized(e.target.checked)} /><span>{consent.authorizedLabel}</span></label>
        <label className="cap-pf-notetaker-consent"><input type="checkbox" checked={notified} disabled={save.isPending} onChange={(e) => setNotified(e.target.checked)} /><span>{consent.notifiedLabel}</span></label>
      </>}
    </EngagementDialog>
  </>;
}
