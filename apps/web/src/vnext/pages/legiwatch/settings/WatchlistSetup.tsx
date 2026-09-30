import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { ToastItem } from '../../../../pages/clients/tracker/tracker-components.js';
import { TrackerConfigPanel } from '../../../../pages/clients/tracker/TrackerConfigPanel.js';
import { useWatchlistConfig } from './use-watchlist-config.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { LwButton } from '../lib/primitives.js';
import { watchlistSetupPath } from '../lib/watchlist-navigation.js';
import './watchlist-config.css';

function ClientWatchlistConfig({ client }: { client: Client }) {
  const toast = useCapiroToast();
  const [results, setResults] = useState<Omit<ToastItem, 'id'> | null>(null);
  const [code, setCode] = useState('');
  const config = useWatchlistConfig(
    client.id,
    true,
    { error: (text) => toast.error(text) },
    setResults,
  );
  const { issueAreasQuery, watchlistQuery, prefsQuery, compiledQuery, seedQuery, otpState } =
    config;
  return (
    <section className="card" style={{ padding: 18 }}>
      {watchlistQuery.isError || prefsQuery.isError || issueAreasQuery.isError ? (
        <div role="alert">
          <p>
            Configuration could not be loaded. Your existing watchlist and alert preferences have
            not changed.
          </p>
          <LwButton
            onClick={() => {
              void watchlistQuery.refetch();
              void prefsQuery.refetch();
              void issueAreasQuery.refetch();
            }}
          >
            Retry configuration
          </LwButton>
        </div>
      ) : !prefsQuery.data ||
        !watchlistQuery.data ||
        watchlistQuery.isLoading ||
        issueAreasQuery.isLoading ? (
        <p>Loading configuration…</p>
      ) : (
        <TrackerConfigPanel
          allIssueAreas={config.allIssueAreas}
          clientName={client.name}
          watchlist={watchlistQuery.data}
          prefs={prefsQuery.data}
          seed={seedQuery.data}
          onSaveWatchlist={(value) => config.saveWatchlistMutation.mutate(value)}
          onSavePrefs={(value) => config.savePrefsMutation.mutate(value)}
          onRequestVerify={(phone, verified) => {
            setCode('');
            config.requestVerify(phone, verified);
          }}
          onTestAlert={config.fireTest}
          saving={config.saveWatchlistMutation.isPending}
          saveState={config.saveState}
          onRetrySave={config.retrySaveWatchlist}
          onUndoSave={config.undoSaveWatchlist}
          canUndo={config.undoRef.current !== null}
          canEditTargeting={config.canEditTargeting}
          termSurfaces={compiledQuery.data?.termSurfaces}
          typedTermsEnabled={config.trackerV2}
          jurisdictionsEnabled={config.trackerV2}
        />
      )}
      {results ? (
        <div role="status">
          {results.text}
          {results.results?.map((result, index) => (
            <p key={index}>
              {result.channel}: {result.status}
              {result.detail ? ` — ${result.detail}` : ''}
            </p>
          ))}
        </div>
      ) : null}
      {config.otpOpen && otpState.current ? (
        <CapiroModal open title="Verify your phone" onClose={config.closeOtp} width={420}>
          <p>We texted a 6-digit code to {otpState.current.masked}</p>
          <label>
            Verification code{' '}
            <input
              aria-label="Verification code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => {
                if (/^\d{0,6}$/.test(event.target.value)) setCode(event.target.value);
              }}
            />
          </label>
          {otpState.current.devCode ? (
            <p>
              SMS delivery isn’t live yet — dev code: <strong>{otpState.current.devCode}</strong>
            </p>
          ) : null}
          <div className="wl-otp-actions">
            <LwButton
              onClick={() => {
                const pending = otpState.current;
                if (pending) {
                  setCode('');
                  config.requestVerify(pending.phone, pending.onVerified);
                }
              }}
            >
              Resend code
            </LwButton>
            <LwButton onClick={config.closeOtp}>Cancel</LwButton>
            <LwButton
              disabled={code.length !== 6 || config.smsConfirmMutation.isPending}
              onClick={() => config.confirmOtp(code)}
            >
              Verify
            </LwButton>
          </div>
        </CapiroModal>
      ) : null}
    </section>
  );
}

export function WatchlistSetup() {
  const api = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const scope = params.get('client') ?? '';
  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const available = (clients.data ?? []).filter((client) => client.status !== 'archived');
  const selected = available.find((client) => client.id === scope);
  return (
    <div className="lw-native-wl lw-body" aria-label="Client watchlist setup">
      <section className="card" style={{ padding: 18 }}>
        <h2 className="lw-card__title">Client watchlist and alerts</h2>
        <p>
          Choose the topics, terms and jurisdictions that matter to this client, then set your alert
          preferences.
        </p>
        <LwButton
          onClick={() =>
            navigate(
              `/legiwatch?tab=settings${scope ? `&client=${encodeURIComponent(scope)}` : ''}`,
            )
          }
        >
          Back to settings
        </LwButton>
        {clients.isLoading ? (
          <p>Loading clients…</p>
        ) : clients.isError ? (
          <div role="alert">
            <p>Clients could not be loaded. Your watchlists have not changed.</p>
            <LwButton onClick={() => void clients.refetch()}>Retry clients</LwButton>
          </div>
        ) : (
          <label style={{ display: 'block', marginTop: 16 }}>
            Client for watchlist setup{' '}
            <select
              value={selected?.id ?? ''}
              onChange={(event) => navigate(watchlistSetupPath(event.target.value))}
            >
              <option value="">Choose a client</option>
              {available.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!clients.isLoading && !clients.isError && !selected ? (
          <p>
            {scope
              ? 'This client is unavailable. Choose an active client to edit its watchlist.'
              : 'Choose a client to open its watchlist. No client is selected automatically.'}
          </p>
        ) : null}
      </section>
      {selected && !clients.isError ? (
        <ClientWatchlistConfig key={selected.id} client={selected} />
      ) : null}
    </div>
  );
}
