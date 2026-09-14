import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroSelect } from '../../components/fields/index.js';
import { errorMessage } from '../../../lib/error-message.js';
import { useConfigureWatchMonitoring, useRevalidateWatch, useWatchMonitoring } from './strategies-api.js';
import './watch-controls.css';

/** Monitoring configuration is distinct from showing the Watch reference layer. */
export function WatchControls({ strategyId }: { strategyId: string }) {
  const navigate = useNavigate();
  const monitoring = useWatchMonitoring(strategyId);
  const configure = useConfigureWatchMonitoring(strategyId);
  const check = useRevalidateWatch(strategyId);
  const busyRef = useRef(false);
  const [selectedMode, setSelectedMode] = useState<'paused' | 'manual' | 'daily' | 'weekly' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const data = monitoring.data;
  const currentMode = data?.mission?.state === 'active' ? data.mission.cadence ?? 'manual' : 'paused';
  const busy = configure.isPending || check.isPending;
  const mode = selectedMode ?? currentMode;
  const last = data?.lastRun;
  const failed = last && ['failed', 'failed_recoverable', 'failed_terminal'].includes(last.state);
  const checking = last && ['queued', 'planning', 'executing'].includes(last.state);
  const stamp = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const act = async (run: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setResult(null);
    try {
      if (run) {
        // Refetch before checking; an error must never be interpreted as an absent mission.
        const fresh = await monitoring.refetch();
        if (fresh.isError || !fresh.data?.available || fresh.data.mission?.state !== 'active') {
          throw fresh.error ?? new Error('Save an active monitoring setting before running a check.');
        }
        const checked = await check.mutateAsync(true);
        if (checked.lastRecheck?.state === 'failed') throw new Error('The check failed. Your existing proposals are preserved. Try checking again.');
        setResult(`Check complete. ${checked.pendingCount} proposed change${checked.pendingCount === 1 ? '' : 's'} ready for review.`);
      } else {
        await configure.mutateAsync(mode);
        setSelectedMode(null);
        setResult(mode === 'paused' ? 'Monitoring paused for this strategy.' : 'Monitoring settings saved for this strategy.');
      }
      await monitoring.refetch();
    } catch (err) {
      setError(errorMessage(err, 'Monitoring could not be updated. Try again.'));
    } finally {
      busyRef.current = false;
    }
  };

  return <section className="st-card st-monitoring" aria-label="Strategy monitoring" id="strategy-monitoring">
    <div className="st-monitoring__heading">
      <div>
        <h2 className="st-section-label">Strategy monitoring</h2>
        <p className="st-monitoring__description">Watch checks dates, dependencies, ownership and context, then proposes changes for your review.</p>
      </div>
      <CapiroButton size="compact" onClick={() => navigate('/strategies/agents/proposals')}>Review proposals</CapiroButton>
    </div>
    <div className="st-monitoring__body">
      {monitoring.isLoading ? <p role="status">Loading monitoring status…</p>
        : monitoring.isError ? <p role="alert">Monitoring status unavailable. {errorMessage(monitoring.error, 'Ask your administrator to check access.')} <CapiroButton size="compact" onClick={() => void monitoring.refetch()}>Try again</CapiroButton></p>
          : !data?.available ? <p role="status">Monitoring is unavailable for your organization. Ask your administrator to enable strategy monitoring.</p>
            : <>
              <div className="st-monitoring__status" role="status">
                <span className={`st-pill st-pill--${failed ? 'error' : 'info'}`}>{currentMode === 'paused' ? data.mission ? 'Paused' : 'Not configured' : currentMode === 'manual' ? 'Manual checks enabled' : data.schedulerEnabled ? `${currentMode === 'daily' ? 'Daily' : 'Weekly'} checks enabled` : 'Scheduled checks unavailable'}</span>
                <span>{!last ? 'Never checked' : failed ? 'Last check failed' : checking ? 'Check has not finished' : last.checkedAt ? `Last checked ${stamp(last.checkedAt)}` : 'No successful check recorded'}
                {last?.checkedAt && last.findingCount !== null && !failed && !checking ? ` · ${last.findingCount} finding${last.findingCount === 1 ? '' : 's'}` : ''}
                </span>
              </div>
              {failed && <p role="alert">{last.error || 'The previous check did not finish. Run a new check to try again.'}</p>}
              {data.schedulerEnabled && currentMode !== 'paused' && data.mission?.nextRunAt && <p>Next scheduled check: {stamp(data.mission.nextRunAt)}</p>}
              {data.duplicateMissionCount > 0 && <p>More than one monitoring schedule exists. Save your chosen setting to use one schedule and pause the duplicates.</p>}
              <div className="st-monitoring__controls">
                <CapiroSelect label="Monitoring frequency" value={mode} disabled={busy} onChange={(e) => setSelectedMode(e.target.value as typeof mode)} options={[
                  { value: 'paused', label: 'Paused' },
                  { value: 'manual', label: 'Manual checks' },
                  { value: 'daily', label: 'Daily checks', disabled: !data.schedulerEnabled },
                  { value: 'weekly', label: 'Weekly checks', disabled: !data.schedulerEnabled },
                ]} />
                <CapiroButton size="compact" disabled={busy || (mode === currentMode && data.duplicateMissionCount === 0)} onClick={() => void act(false)}>Save monitoring</CapiroButton>
                <CapiroButton size="compact" variant="primary" disabled={busy || currentMode === 'paused'} onClick={() => void act(true)}>{check.isPending ? 'Checking…' : 'Check now'}</CapiroButton>
              </div>
              {!data.schedulerEnabled && <p className="st-monitoring__hint">Scheduled monitoring is unavailable. Use manual checks when needed.</p>}
            </>}
      {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
    </div>
    <p className="st-monitoring__footer">Showing or hiding the Watch timeline layer does not change monitoring.</p>
  </section>;
}
