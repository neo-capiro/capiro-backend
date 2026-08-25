import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardHead,
  EvidenceChip,
  FitChip,
  Pill,
  TabPageHead,
  type EvidenceTier,
  type PillTone,
} from '../portfolio-primitives.js';
import { useApi } from '../../../../lib/use-api.js';
import { CapabilityDrawerVNext } from '../CapabilityDrawerVNext.js';
import { CapabilityCreateFormVNext } from '../CapabilityCreateFormVNext.js';
import type { Capability } from '../../../../pages/clients/capability-types.js';
import { readClientRegistrations } from '../../../../pages/clients/client-registrations.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import './capabilities-tab.css';

/**
 * Capabilities tab (spec §7). Order: capability areas → registrations & fit.
 *
 * Data: §7.1 capability areas bind to the real capabilities endpoint when it
 * returns records (`GET /api/clients/:id/capabilities`, same query key as the
 * canonical profile surface, so both share one cache) — maturity derives from
 * TRL, program line from peNumbers, tags from tags. **The design's per-area
 * "matches" count and evidence tier/source have NO field on the capability
 * model** — they used to be read off the CAP_AREAS fixture at the same index,
 * which stamped invented match counts and provenance tiers onto real client
 * capabilities. They are now omitted on live records (wire-audit "4 New
 * capability" row 2). §7.2 registrations & codes is real — it reads the
 * government identifiers the Company Info wizard writes (see
 * `readClientRegistrations`). §7.2 capability-fit rows have no per-client
 * backend and stay fixture. Past performance moved to Intelligence / Federal
 * Footprint (`PastPerformanceCard`): the profile header already carries one
 * "Fill with Meri" for the whole client, and delivery history reads with the
 * rest of the client's federal record rather than beside its capability
 * roster.
 *
 * All editing happens in the vNext capability editor (CapabilityDrawerVNext —
 * a re-skin of the canonical CapabilityDrawer on the same PATCH/attachment
 * contract; no antd renders on this surface): clicking a live capability area
 * opens it on that record (fixture areas are static — there is no record).
 *
 * "Add capability" used to open that editor with `capability={null}`, which the
 * editor renders as NOTHING — so the modal appeared with an empty body and the
 * button was effectively dead. Creating now goes through
 * `CapabilityCreateFormVNext` (POST `…/capabilities`), and on success the same
 * modal switches to the editor on the record just created, so PE numbers, match
 * keywords, and documents — all of which need an id — are one step away.
 */

export function ClientCrmCapabilitiesProto({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Capability | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Capability | null>(null);

  const capabilities = useQuery<Capability[]>({
    // Same key the canonical profile uses, so both surfaces share one cache.
    queryKey: ['client-capabilities', client.id],
    queryFn: async () => (await api.get<Capability[]>(`/api/clients/${client.id}/capabilities`)).data,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clients/${client.id}/capabilities/${id}`)).data,
    onSuccess: () => {
      setPendingDelete(null);
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
    },
  });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });

  const live = capabilities.data ?? [];
  const areas: CapabilityAreaView[] = live.map((cap) => toLiveAreaView(cap));

  return (
    <div className="cap-pf-anim-rise cap-pf-caps">
      <TabPageHead
        title="Capabilities"
        sub="What the client actually does, how it is registered to sell, and what it has delivered. This record drives every legislative, funding, and district match in Capiro."
        // One "Fill with Meri" per profile, and it lives in the shell header
        // (ClientProfileShell) — a second copy here fired the same drawer.
        actions={<SecondaryBtn onClick={() => setCreating(true)}>Add capability</SecondaryBtn>}
      />

      {/* §7.1 Capability areas */}
      <CapabilityAreasCard
        areas={areas}
        loading={capabilities.isLoading}
        onOpenArea={(cap) => setEditing(cap)}
        onAddCapability={() => setCreating(true)}
      />

      {/* §7.2 Registrations & codes · Where capabilities create fit (two-up) */}
      <div className="cap-pf-grid-2">
        <RegistrationsCard client={client} />
        <CapabilityFitCard client={client} onAddCapability={() => setCreating(true)} />
      </div>

      {/* The canonical editor is an in-flow side panel on the legacy profile.
          In vNext that made a clicked capability look as if it had been appended
          below the whole page. Keep its mature editing surface, but put it in the
          standard focus-trapping modal so the selected capability is immediately
          visible without changing the page's scroll position. */}
      <CapiroModal
        open={Boolean(editing || creating)}
        title={editing ? `Capability — ${editing.name}` : 'New capability'}
        onClose={() => {
          setEditing(null);
          setCreating(false);
        }}
      >
        {editing ? (
          <CapabilityDrawerVNext
            capability={editing}
            clientId={client.id}
            onClose={() => {
              setEditing(null);
              setCreating(false);
            }}
            onUpdated={refresh}
            onDelete={() => setPendingDelete(editing)}
          />
        ) : (
          <CapabilityCreateFormVNext
            clientId={client.id}
            onCancel={() => setCreating(false)}
            onCreated={(capability) => {
              // Stay in the same modal and continue on the saved record: the
              // editor owns PE numbers, match keywords, and documents, none of
              // which can be set before the capability has an id.
              setCreating(false);
              setEditing(capability);
            }}
          />
        )}
      </CapiroModal>

      {/* Destructive mutations confirm; the overlay traps focus while open. */}
      <CapiroModal open={Boolean(pendingDelete)} title="Delete capability" onClose={() => setPendingDelete(null)}>
        <p className="cap-pf-caps__modal-text">
          Delete <strong>{pendingDelete?.name}</strong>? Its advocacy history and linked documents are removed with it.
          This cannot be undone.
        </p>
        {remove.isError ? (
          <p className="cap-pf-caps__modal-error">
            {remove.error instanceof Error ? remove.error.message : 'Delete failed'}
          </p>
        ) : null}
        <div className="cap-pf-caps__modal-actions">
          <CapiroButton
            variant="primary"
            size="compact"
            loading={remove.isPending}
            onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
          >
            Delete
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={() => setPendingDelete(null)}>
            Cancel
          </CapiroButton>
        </div>
      </CapiroModal>
    </div>
  );
}

/* ── shared small buttons (reference idiom) ───────────────────────────────── */

function SecondaryBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`cap-pf-caps__secondary-btn${hover ? ' is-hover' : ''}`}
    >
      {children}
    </button>
  );
}

/* ── §7.1 Capability areas ────────────────────────────────────────────────── */

interface CapabilityAreaView {
  key: string;
  name: string;
  maturity: string;
  tone: PillTone;
  body: string;
  tags: string[];
  pe: string;
  /**
   * Row 2, wire-audit "4 New capability": there is no matches count and no
   * evidence tier/source on `ClientCapability`, so a live card carries none.
   * Reading them off the design fixture put an invented "8 matches · Tier A ·
   * SAM.gov" under a real capability name, which reads as this client's data.
   */
  matches?: string;
  tier?: EvidenceTier;
  source?: string;
  /** Present only when the card is backed by a real capability record. */
  capability?: Capability;
}

/**
 * The backend carries no maturity field — derive the design's bands from TRL:
 * ≥7 Fielded (success), 4–6 Prototype (blue), otherwise Research (warning).
 *
 * Nothing else is invented. Matches and evidence tier/source have no field on
 * the capability model, so a live card simply does not render them.
 */
function toLiveAreaView(cap: Capability): CapabilityAreaView {
  const maturity = cap.trl != null && cap.trl >= 7 ? 'Fielded' : cap.trl != null && cap.trl >= 4 ? 'Prototype' : 'Research';
  const tone: PillTone = maturity === 'Fielded' ? 'success' : maturity === 'Prototype' ? 'blue' : 'warning';
  const pe = cap.peNumbers[0] ?? cap.peNumber;
  return {
    key: cap.id,
    name: cap.name,
    maturity,
    tone,
    body:
      cap.description ??
      ([cap.type, cap.serviceBranch, cap.appropriationAccount].filter(Boolean).join(' · ') ||
        'No description recorded yet.'),
    tags: cap.tags,
    pe: pe ? `PE ${pe}` : 'Not yet mapped',
    capability: cap,
  };
}

function CapabilityAreasCard({
  areas,
  loading,
  onOpenArea,
  onAddCapability,
}: {
  areas: CapabilityAreaView[];
  loading: boolean;
  onOpenArea: (cap: Capability) => void;
  onAddCapability: () => void;
}) {
  const fielded = areas.filter((a) => a.maturity === 'Fielded').length;
  return (
    <Card>
      <CardHead
        withDesc
        title="Capability areas"
        description="Each area carries its maturity, the budget lines it maps to, and where the claim comes from."
        action={
          loading ? null : (
            <span className="cap-pf-caps__count-pill">
              {`${areas.length} area${areas.length === 1 ? '' : 's'} · ${fielded} fielded`}
            </span>
          )
        }
      />
      <div className="cap-pf-grid-cap-areas" style={{ padding: '0 24px 24px' }}>
        {loading ? (
          <p className="cap-pf-caps__muted-note">Loading capability areas…</p>
        ) : areas.length === 0 ? (
          <div className="cap-pf-caps__empty-wrap">
            <p className="cap-pf-caps__muted-note">No capability areas recorded yet.</p>
            <SecondaryBtn onClick={onAddCapability}>Add capability</SecondaryBtn>
          </div>
        ) : (
          areas.map((area) => (
            <CapabilityAreaCard
              key={area.key}
              area={area}
              onOpen={area.capability ? () => onOpenArea(area.capability as Capability) : undefined}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function CapabilityAreaCard({ area, onOpen }: { area: CapabilityAreaView; onOpen?: () => void }) {
  const [hover, setHover] = useState(false);
  const cardClass = `cap-pf-caps__area-card${hover && onOpen ? ' is-hover' : ''}`;

  const inner = (
    <>
      <div className="cap-pf-caps__area-top">
        <span className="cap-pf-caps__area-name">{area.name}</span>
        <Pill tone={area.tone} style={{ flex: '0 0 auto' }}>
          {area.maturity}
        </Pill>
      </div>
      <p className="cap-pf-caps__area-body">{area.body}</p>
      {area.tags.length > 0 ? (
        <div className="cap-pf-caps__area-tags">
          {area.tags.map((tag) => (
            <span key={tag} className="cap-pf-caps__tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="cap-pf-caps__area-foot">
        {area.pe === 'Not yet mapped' ? (
          // One quiet line instead of a full labeled block — a roster where
          // every card shouts PROGRAM LINE / Not yet mapped is noise, not data.
          <span className="cap-pf-caps__faint-note">No program line mapped yet</span>
        ) : (
          <span className="cap-pf-caps__meta-pair">
            <span className="cap-pf-caps__meta-label">Program line</span>
            <span className="cap-pf-caps__meta-value">{area.pe}</span>
          </span>
        )}
        {/* Rendered only when a source exists for them — see CapabilityAreaView. */}
        {area.matches ? (
          <span className="cap-pf-caps__meta-pair">
            <span className="cap-pf-caps__meta-label">Matches</span>
            <span className="cap-pf-caps__meta-value">{area.matches}</span>
          </span>
        ) : null}
        <span className="cap-pf-caps__area-spacer" />
        {area.tier ? <EvidenceChip tier={area.tier} label={area.source ?? ''} /> : null}
      </div>
    </>
  );

  if (!onOpen) return <div className={cardClass}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`${cardClass} cap-pf-caps__area-card--btn`}
    >
      {inner}
    </button>
  );
}

/* ── §7.2 Registrations & codes ───────────────────────────────────────────── */

/** Stored SAM dates are date-only strings; render them without a timezone shift. */
function formatRegDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Real registrations (wire-audit "3 Compose extend" item 1). Every row comes
 * from the client record the Company Info wizard writes — see
 * `readClientRegistrations`. `client` is already loaded (it is a prop, not a
 * query), so "no rows" is genuinely no data and gets a real empty state; the
 * CAP_CODES fixture is not a stand-in for an unregistered client.
 *
 * The header's "verified <date>" stamp is the recorded SAM.gov status and
 * expiration, not a sync timestamp — nothing in this product verifies against
 * SAM.gov on a schedule, so it never claims a verification it did not perform.
 */
function RegistrationsCard({ client }: { client: Client }) {
  const navigate = useNavigate();
  const { rows, samStatus, samExpiration } = readClientRegistrations(client);
  return (
    <Card>
      <CardHead
        title="Registrations & codes"
        action={
          samStatus ? (
            <span className="cap-pf-caps__sam-status">
              {`SAM.gov · ${samStatus}${samExpiration ? ` · expires ${formatRegDate(samExpiration)}` : ''}`}
            </span>
          ) : null
        }
      />
      <div className="cap-pf-caps__reg-body">
        {rows.length === 0 ? (
          <div className="cap-pf-caps__empty-wrap is-tight">
            <p className="cap-pf-caps__muted-note">
              No registrations or codes recorded for this client yet.
            </p>
            {/* The Company Info wizard has no deep link of its own — it opens
                from the canonical profile page, so that is where this goes. */}
            <SecondaryBtn onClick={() => navigate(`/clients?clientId=${client.id}`)}>
              Edit client profile
            </SecondaryBtn>
          </div>
        ) : null}
        {rows.map((c) => (
          <div key={c.label} className="cap-pf-caps__reg-row">
            <span className="cap-pf-caps__reg-label">{c.label}</span>
            <span className="cap-pf-caps__reg-value">{c.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── §7.2 Where capabilities create fit ───────────────────────────────────── */

type CapabilityFitMatch = {
  id: string;
  kind: 'pe' | 'bill' | 'fo';
  targetId: string;
  target: string;
  why: string;
  fit: number;
  score01: number;
  capabilityIds: string[];
  href?: string | null;
};

type CapabilityFitResult = {
  matches: CapabilityFitMatch[];
  computedAt: string | null;
  status: 'ready' | 'empty' | 'profile_too_thin' | 'stale';
  emptyReason?: string;
  sources: { pe: boolean; bill: boolean; fo: boolean };
};

function CapabilityFitCard({ client, onAddCapability }: { client: Client; onAddCapability: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const fitQ = useQuery<CapabilityFitResult>({
    queryKey: ['client-capability-fit', client.id],
    queryFn: async () => (await api.get(`/api/clients/${client.id}/capability-fit`)).data as CapabilityFitResult,
  });
  const refreshM = useMutation({
    mutationFn: async () => (await api.post(`/api/clients/${client.id}/capability-fit/refresh`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['client-capability-fit', client.id] }),
  });

  // Older callers/tests may return the capabilities array for every GET. Treat
  // that malformed fit payload as unavailable rather than dereferencing it.
  const result = fitQ.data && !Array.isArray(fitQ.data) ? fitQ.data : undefined;
  const matches = result?.matches ?? [];
  const loading = fitQ.isLoading;
  const refreshing = refreshM.isPending;
  const refreshButton = (
    <SecondaryBtn onClick={() => refreshM.mutate()} disabled={refreshing}>
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </SecondaryBtn>
  );

  return (
    <Card>
      <CardHead
        withDesc
        title="Where capabilities create fit"
        description="The matches Capiro draws from this record, and the reason behind each one."
      />
      {loading ? (
        <div className="cap-pf-caps__fit-loading">Loading capability fit…</div>
      ) : matches.length > 0 && result && (result.status === 'ready' || result.status === 'stale') ? (
        <div className="cap-pf-caps__fit-body">
          {result.status === 'stale' ? (
            <div className="cap-pf-caps__stale-banner">
              <span>These matches may be outdated.</span>{refreshButton}
            </div>
          ) : null}
          {result.matches.map((match) => (
            <div key={match.id} className="cap-pf-caps__match-row">
              <div className="cap-pf-caps__match-main">
                {match.href ? (
                  <a href={match.href} className="cap-pf-caps__match-target">{match.target}</a>
                ) : (
                  <span className="cap-pf-caps__match-target">{match.target}</span>
                )}
                <div className="cap-pf-caps__match-why">{match.why}</div>
              </div>
              <FitChip score={match.fit} />
            </div>
          ))}
          {result.status === 'ready' ? <div className="cap-pf-caps__fit-foot">{refreshButton}</div> : null}
        </div>
      ) : result?.status === 'profile_too_thin' ? (
        <div className="cap-pf-caps__fit-empty">
          <span className="cap-pf-caps__muted-note">{result.emptyReason}</span>
          <SecondaryBtn onClick={onAddCapability}>Add capability</SecondaryBtn>
        </div>
      ) : (
        <div className="cap-pf-caps__fit-empty">
          <span className="cap-pf-caps__muted-note">{result?.emptyReason ?? 'Not computed yet.'}</span>
          {refreshButton}
        </div>
      )}
    </Card>
  );
}
