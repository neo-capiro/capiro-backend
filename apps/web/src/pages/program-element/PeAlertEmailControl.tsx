import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailOutlined } from '@ant-design/icons';
import { Segmented, Tooltip, message } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getPeAlertEmailPref, setPeAlertEmailPref, type PeAlertEmailMode } from './api.js';

const OPTIONS: Array<{ label: string; value: PeAlertEmailMode }> = [
  { label: 'Off', value: 'off' },
  { label: 'Daily digest', value: 'daily' },
  { label: 'Daily + critical', value: 'daily_plus_critical' },
];

/**
 * PE Watch email-alert preference (PE Watch plan Phase 2). Lives on the
 * Program Elements surface by design — one control, per user: Off / Daily
 * digest / Daily + critical. Alerts cover the PEs this user watches.
 */
export function PeAlertEmailControl() {
  const api = useApi();
  const queryClient = useQueryClient();
  const prefQuery = useQuery({
    queryKey: ['pe-alert-email-pref'],
    queryFn: () => getPeAlertEmailPref(api),
  });
  const mutation = useMutation({
    mutationFn: (mode: PeAlertEmailMode) => setPeAlertEmailPref(api, mode),
    onSuccess: (data) => {
      queryClient.setQueryData(['pe-alert-email-pref'], data);
      void message.success(
        data.mode === 'off'
          ? 'PE Watch emails off'
          : data.mode === 'daily'
            ? 'Daily PE Watch digest on'
            : 'Daily digest + critical alerts on',
      );
    },
    onError: () => void message.error('Could not save the email preference'),
  });

  return (
    <div className="pe-alert-email-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tooltip title="Email alerts for budget moves on the program elements you watch — funding cuts, terminations, new starts, committee marks, and new budget documents.">
        <span style={{ whiteSpace: 'nowrap' }}>
          <MailOutlined /> Email alerts
        </span>
      </Tooltip>
      <Segmented
        size="small"
        options={OPTIONS}
        value={prefQuery.data?.mode ?? 'daily'}
        disabled={prefQuery.isLoading || mutation.isPending}
        onChange={(v) => mutation.mutate(v as PeAlertEmailMode)}
      />
    </div>
  );
}
