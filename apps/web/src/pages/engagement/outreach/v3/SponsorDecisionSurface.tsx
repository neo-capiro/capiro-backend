import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Building2,
  Check,
  CircleHelp,
  Globe2,
  Loader2,
  LockKeyhole,
  Plus,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { sponsorCommand } from './commands.js';
import type { DecisionSurfacesProps } from './DecisionSurfaces.js';
import type { OutreachV3SponsorKind } from './contracts.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';

export type SponsorDecisionSurfaceProps = Pick<
  DecisionSurfacesProps,
  'session' | 'clients' | 'busy' | 'applyCommands'
>;

const OPTIONS: Array<{
  kind: Exclude<OutreachV3SponsorKind, 'undecided'>;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    kind: 'client',
    title: 'One client',
    description: 'Use one explicitly authorized client scope.',
    icon: <Building2 size={18} />,
  },
  {
    kind: 'multi_client',
    title: 'Several clients',
    description: 'Every represented client must be authorized.',
    icon: <UsersRound size={18} />,
  },
  {
    kind: 'firm',
    title: 'Firm-wide',
    description: 'Use only tenant-neutral shared context.',
    icon: <ShieldCheck size={18} />,
  },
  {
    kind: 'coalition',
    title: 'Coalition or association',
    description: 'Name the shared sponsor; no implied client endorsement.',
    icon: <Globe2 size={18} />,
  },
  {
    kind: 'internal_team',
    title: 'Internal team',
    description: 'Internal planning without external sponsor attribution.',
    icon: <UserRound size={18} />,
  },
  {
    kind: 'none',
    title: 'No formal sponsor',
    description: 'General relationship or informational outreach.',
    icon: <CircleHelp size={18} />,
  },
];

export function SponsorDecisionSurface({
  session,
  clients,
  busy,
  applyCommands,
}: SponsorDecisionSurfaceProps) {
  const sponsor = session.spec.sponsor;
  const [kind, setKind] = useState<OutreachV3SponsorKind>(sponsor.kind);
  const [label, setLabel] = useState(sponsor.label ?? '');
  const [search, setSearch] = useState('');
  const [clientIds, setClientIds] = useState<string[]>(
    sponsor.clientRefs.map((ref) => ref.clientId),
  );
  const [error, setError] = useState<string | null>(null);

  const filteredClients = useMemo(() => {
    const query = search.trim().toLowerCase();
    return clients
      .filter((client) => !query || client.name.toLowerCase().includes(query))
      .slice(0, 30);
  }, [clients, search]);
  const selectedClients = useMemo(
    () => clientIds.map((id) => clients.find((client) => client.id === id)).filter(Boolean),
    [clientIds, clients],
  );

  const selectKind = (next: Exclude<OutreachV3SponsorKind, 'undecided'>) => {
    setKind(next);
    setError(null);
    if (next !== 'client' && next !== 'multi_client') setClientIds([]);
    if (next !== 'coalition') setLabel('');
  };

  const toggleClient = (clientId: string) => {
    setClientIds((current) => {
      if (kind === 'client') return current[0] === clientId ? [] : [clientId];
      return current.includes(clientId)
        ? current.filter((id) => id !== clientId)
        : [...current, clientId];
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (kind === 'undecided') {
      setError('Choose who this campaign is for. No client is a valid choice.');
      return;
    }
    if (kind === 'client' && clientIds.length !== 1) {
      setError('Select exactly one authorized client.');
      return;
    }
    if (kind === 'multi_client' && clientIds.length < 2) {
      setError('Select at least two authorized clients.');
      return;
    }
    if (kind === 'coalition' && !label.trim()) {
      setError('Enter the coalition or association name.');
      return;
    }
    setError(null);
    try {
      await applyCommands([
        sponsorCommand({
          kind,
          label,
          clientIds: kind === 'client' || kind === 'multi_client' ? clientIds : [],
        }),
      ]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  return (
    <form className="ov3-decision-panel" onSubmit={submit}>
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Sponsor scope · client optional</span>
          <h2>Who is this campaign for?</h2>
          <p>
            Sponsor scope governs attribution and which confidential context may be reviewed. It
            never chooses the recipients.
          </p>
        </div>
        <span className={`ov3-badge ${kind === 'undecided' ? 'is-warning' : 'is-info'}`}>
          {kind === 'undecided' ? 'Choose one' : 'Scope selected'}
        </span>
      </header>

      <div className="ov3-choice-grid is-three">
        {OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            className={`ov3-choice-card ${kind === option.kind ? 'is-selected' : ''}`}
            aria-pressed={kind === option.kind}
            onClick={() => selectKind(option.kind)}
          >
            <span className="ov3-choice-card__radio" aria-hidden="true">
              {kind === option.kind ? <span /> : null}
            </span>
            <span className="ov3-choice-card__icon">{option.icon}</span>
            <span>
              <strong>{option.title}</strong>
              <small>{option.description}</small>
            </span>
          </button>
        ))}
      </div>

      {kind === 'client' || kind === 'multi_client' ? (
        <section className="ov3-selection-box">
          <header>
            <div>
              <span className="ov3-section-label">Authorized clients</span>
              <p>
                {kind === 'client'
                  ? 'Choose exactly one client.'
                  : 'Choose two or more clients. Confidential context remains isolated.'}
              </p>
            </div>
            <label className="ov3-search-control">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search clients"
                aria-label="Search clients"
              />
            </label>
          </header>

          {selectedClients.length ? (
            <div className="ov3-selected-chips" aria-label="Selected clients">
              {selectedClients.map((client) =>
                client ? (
                  <span key={client.id}>
                    {client.name}
                    <button
                      type="button"
                      aria-label={`Remove ${client.name}`}
                      onClick={() => toggleClient(client.id)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                ) : null,
              )}
              <button type="button" className="ov3-button is-quiet" onClick={() => setClientIds([])}>
                Clear selection
              </button>
            </div>
          ) : null}

          <div className="ov3-client-list">
            {filteredClients.map((client) => {
              const selected = clientIds.includes(client.id);
              return (
                <button
                  key={client.id}
                  type="button"
                  className={selected ? 'is-selected' : ''}
                  aria-pressed={selected}
                  onClick={() => toggleClient(client.id)}
                >
                  <span className="ov3-avatar">{client.name.slice(0, 2).toUpperCase()}</span>
                  <span>
                    <strong>{client.name}</strong>
                    <small>{client.website || client.sectorTag || 'Client account'}</small>
                  </span>
                  {selected ? <Check size={17} aria-hidden="true" /> : <Plus size={17} />}
                </button>
              );
            })}
            {!filteredClients.length ? (
              <div className="ov3-empty-state is-compact">
                <Building2 size={22} aria-hidden="true" />
                <strong>No authorized clients match</strong>
                <p>Change the search or choose another sponsor scope.</p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {kind === 'coalition' ? (
        <label className="ov3-field">
          <span>Coalition or association name<em>Required</em></span>
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Autonomous Systems Coalition"
          />
        </label>
      ) : null}

      <div className="ov3-recovery is-info">
        <LockKeyhole size={18} aria-hidden="true" />
        <div>
          <strong>Sponsor and target audience are separate</strong>
          <p>
            Choosing a client unlocks only authorized context review. It does not add the client,
            client contacts, or anyone else to the campaign audience.
          </p>
        </div>
      </div>

      {kind === 'multi_client' ? (
        <div className="ov3-recovery is-warning">
          <UsersRound size={18} aria-hidden="true" />
          <div>
            <strong>Multi-client context remains client-neutral in this phase</strong>
            <p>
              Capiro will not commingle client-confidential material or imply a joint endorsement.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="ov3-recovery is-danger" role="alert">
          <CircleHelp size={18} aria-hidden="true" />
          <div><strong>Complete the sponsor scope</strong><p>{error}</p></div>
        </div>
      ) : null}

      <footer className="ov3-panel-footer">
        <span>No client is required. Scope affects context and attribution—not recipients.</span>
        <div className="ov3-panel-footer__actions">
          <button type="submit" className="ov3-button is-primary" disabled={busy}>
            {busy ? <Loader2 className="ov3-spin" size={16} /> : null}
            Confirm sponsor
          </button>
        </div>
      </footer>
    </form>
  );
}
