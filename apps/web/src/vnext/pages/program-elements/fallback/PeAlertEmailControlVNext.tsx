/**
 * PE Watch email-alert preference — native vNext port of
 * `pages/program-element/PeAlertEmailControl.tsx` (re-skin: identical
 * endpoints, query keys, copy, toasts). One control, per user: Off / Daily
 * digest / Daily + critical. Alerts cover the PEs this user watches.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  getPeAlertEmailPref,
  setPeAlertEmailPref,
  type PeAlertEmailMode,
} from '../../../../pages/program-element/api.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { PeFbMailIcon } from './pe-fallback-icons.js';

const OPTIONS: Array<{ label: string; value: PeAlertEmailMode }> = [
  { label: 'Off', value: 'off' },
  { label: 'Daily digest', value: 'daily' },
  { label: 'Daily + critical', value: 'daily_plus_critical' },
];

export function PeAlertEmailControlVNext() {
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const prefQuery = useQuery({
    queryKey: ['pe-alert-email-pref'],
    queryFn: () => getPeAlertEmailPref(api),
  });
  const mutation = useMutation({
    mutationFn: (mode: PeAlertEmailMode) => setPeAlertEmailPref(api, mode),
    onSuccess: (data) => {
      queryClient.setQueryData(['pe-alert-email-pref'], data);
      toast.success(
        data.mode === 'off'
          ? 'PE Watch emails off'
          : data.mode === 'daily'
            ? 'Daily PE Watch digest on'
            : 'Daily digest + critical alerts on',
      );
    },
    onError: () => toast.error('Could not save the email preference'),
  });

  const value = prefQuery.data?.mode ?? 'daily';
  const disabled = prefQuery.isLoading || mutation.isPending;

  return (
    <div className="pe-fb-alert-email" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{ whiteSpace: 'nowrap' }}
        title="Email alerts for budget moves on the program elements you watch — funding cuts, terminations, new starts, committee marks, and new budget documents."
      >
        <PeFbMailIcon /> Email alerts
      </span>
      <div className="pe-fb-segment" role="radiogroup" aria-label="Email alerts">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={value === option.value ? 'active' : ''}
            disabled={disabled}
            onClick={() => mutation.mutate(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
