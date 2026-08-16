import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardHead,
  EvidenceChip,
  FitChip,
  Pill,
  TabPageHead,
  GRADIENT_DARK,
  GRADIENT_DARK_HOVER,
  type EvidenceTier,
  type PillTone,
} from '../portfolio-primitives.js';
import { CAP_AREAS, CAP_CODES, CAP_FIT, CAP_PERF } from '../portfolio-fixtures.js';
import { useApi } from '../../../../lib/use-api.js';
import { CapabilityDrawer, type Capability } from '../../../../pages/clients/CapabilityDrawer.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';

/**
 * Capabilities tab (spec §7). Order: capability areas → registrations & fit →
 * past performance.
 *
 * Data: §7.1 capability areas bind to the real capabilities endpoint when it
 * returns records (`GET /api/clients/:id/capabilities`, same query key as the
 * canonical profile surface, so both share one cache) — maturity derives from
 * TRL, program line from peNumbers, tags from tags. Fields the backend does
 * not carry (matches count, evidence tier/source) come from the design
 * fixture at the same index. §7.2 registrations/codes and capability-fit rows
 * and §7.3 past performance have no per-client backend — they render the
 * design's fixtures (UI-only).
 *
 * The canonical CapabilityDrawer stays mounted for all editing: the header
 * "Add capability" action opens it blank, and clicking a live capability area
 * opens it on that record (fixture areas are static — there is no record).
 */

export function ClientCrmCapabilitiesProto({
  client,
  onFillWithMeri,
}: {
  client: Client;
  onFillWithMeri?: () => void;
}) {
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
  const areas: CapabilityAreaView[] = live.map((cap, i) => toLiveAreaView(cap, i));

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Capabilities"
        sub="What the client actually does, how it is registered to sell, and what it has delivered. This record drives every legislative, funding, and district match in Capiro."
        actions={
          <>
            <SecondaryBtn onClick={() => setCreating(true)}>Add capability</SecondaryBtn>
            <PrimaryBtn onClick={onFillWithMeri}>Fill with Meri</PrimaryBtn>
          </>
        }
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
        <RegistrationsCard />
        <CapabilityFitCard />
      </div>

      {/* §7.3 Past performance */}
      <PastPerformanceCard />

      {(editing || creating) && (
        <CapabilityDrawer
          capability={editing}
          clientId={client.id}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onUpdated={() => {
            refresh();
            setCreating(false);
          }}
          {...(editing ? { onDelete: () => setPendingDelete(editing) } : {})}
        />
      )}

      {/* Destructive mutations confirm; the overlay traps focus while open. */}
      <CapiroModal open={Boolean(pendingDelete)} title="Delete capability" onClose={() => setPendingDelete(null)}>
        <p style={{ margin: 0, fontSize: 14, color: '#475467' }}>
          Delete <strong>{pendingDelete?.name}</strong>? Its advocacy history and linked documents are removed with it.
          This cannot be undone.
        </p>
        {remove.isError ? (
          <p style={{ margin: '8px 0 0', fontSize: 14, color: '#B42318' }}>
            {remove.error instanceof Error ? remove.error.message : 'Delete failed'}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
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
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 40,
        padding: '0 16px',
        borderRadius: 8,
        background: hover ? '#F9FAFB' : '#ffffff',
        color: hover ? '#101828' : '#344054',
        fontSize: 14,
        fontWeight: 600,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
      }}
    >
      {children}
    </button>
  );
}

function PrimaryBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 40,
        padding: '0 16px',
        borderRadius: 8,
        background: hover ? GRADIENT_DARK_HOVER : GRADIENT_DARK,
        color: '#ffffff',
        fontSize: 14,
        fontWeight: 600,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        boxShadow: '0px 1px 2px rgba(16,24,40,.05)',
      }}
    >
      {children}
    </button>
  );
}

function LinkBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ fontSize: 14, fontWeight: 600, color: hover ? '#0E141C' : '#101828', whiteSpace: 'nowrap' }}
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
  matches: string;
  tier: EvidenceTier;
  source: string;
  /** Present only when the card is backed by a real capability record. */
  capability?: Capability;
}

/**
 * The backend carries no maturity field — derive the design's bands from TRL:
 * ≥7 Fielded (success), 4–6 Prototype (blue), otherwise Research (warning).
 * Matches/evidence have no backend: the fixture at the same index supplies them.
 */
function toLiveAreaView(cap: Capability, i: number): CapabilityAreaView {
  const maturity = cap.trl != null && cap.trl >= 7 ? 'Fielded' : cap.trl != null && cap.trl >= 4 ? 'Prototype' : 'Research';
  const tone: PillTone = maturity === 'Fielded' ? 'success' : maturity === 'Prototype' ? 'blue' : 'warning';
  // i % length is always in range for the fixed 4-entry fixture.
  const fixture = CAP_AREAS[i % CAP_AREAS.length]!;
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
    matches: fixture.matches,
    tier: fixture.tier as EvidenceTier,
    source: fixture.source,
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
            <span
              style={{
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                height: 24,
                padding: '0 10px',
                borderRadius: 9999,
                background: '#F9FAFB',
                boxShadow: 'inset 0 0 0 1px #EAECF0',
                color: '#344054',
                fontSize: 12,
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              {`${areas.length} area${areas.length === 1 ? '' : 's'} · ${fielded} fielded`}
            </span>
          )
        }
      />
      <div className="cap-pf-grid-cap-areas" style={{ padding: '0 24px 24px' }}>
        {loading ? (
          <p style={{ margin: 0, fontSize: 14, color: '#667085' }}>Loading capability areas…</p>
        ) : areas.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '8px 0 16px' }}>
            <p style={{ margin: 0, fontSize: 14, color: '#667085' }}>No capability areas recorded yet.</p>
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
  const cardStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '18px 18px 16px',
    borderRadius: 10,
    background: '#FCFCFD',
    boxShadow: hover && onOpen ? 'inset 0 0 0 1px #D0D5DD' : 'inset 0 0 0 1px #EAECF0',
  } as const;

  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>
          {area.name}
        </span>
        <Pill tone={area.tone} style={{ flex: '0 0 auto' }}>
          {area.maturity}
        </Pill>
      </div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>{area.body}</p>
      {area.tags.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {area.tags.map((tag) => (
            <span
              key={tag}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 22,
                padding: '0 8px',
                borderRadius: 6,
                background: '#F2F4F7',
                boxShadow: 'inset 0 0 0 1px #EAECF0',
                color: '#344054',
                fontSize: 12,
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          paddingTop: 12,
          boxShadow: 'inset 0 1px 0 #EAECF0',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
            Program line
          </span>
          <span style={{ fontSize: 13, color: '#101828' }}>{area.pe}</span>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
            Matches
          </span>
          <span style={{ fontSize: 13, color: '#101828' }}>{area.matches}</span>
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        <EvidenceChip tier={area.tier} label={area.source} />
      </div>
    </>
  );

  if (!onOpen) return <div style={cardStyle}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...cardStyle, width: '100%', textAlign: 'left' }}
    >
      {inner}
    </button>
  );
}

/* ── §7.2 Registrations & codes ───────────────────────────────────────────── */

function RegistrationsCard() {
  return (
    <Card>
      <CardHead
        title="Registrations & codes"
        action={
          <span style={{ fontSize: 13, color: '#667085', whiteSpace: 'nowrap' }}>SAM.gov · verified Aug 04</span>
        }
      />
      <div style={{ padding: '6px 24px 20px' }}>
        {CAP_CODES.map((c) => (
          <div
            key={c.label}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 16,
              padding: '11px 0',
              boxShadow: 'inset 0 -1px 0 #F2F4F7',
            }}
          >
            <span
              style={{
                flex: '0 0 auto',
                width: 148,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                color: '#667085',
              }}
            >
              {c.label}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828', textWrap: 'pretty' }}>{c.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── §7.2 Where capabilities create fit ───────────────────────────────────── */

function CapabilityFitCard() {
  return (
    <Card>
      <CardHead
        withDesc
        title="Where capabilities create fit"
        description="The matches Capiro draws from this record, and the reason behind each one."
      />
      <div>
        {CAP_FIT.map((f) => (
          <FitRow key={f.target} fit={f} />
        ))}
      </div>
    </Card>
  );
}

function FitRow({ fit }: { fit: (typeof CAP_FIT)[number] }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 14,
        padding: '13px 24px',
        borderTop: '1px solid #F2F4F7',
        textAlign: 'left',
        background: hover ? '#F9FAFB' : 'transparent',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 500,
            color: '#101828',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {fit.target}
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085', textWrap: 'pretty' }}>{fit.why}</span>
      </span>
      <FitChip score={fit.fit} style={{ flex: '0 0 auto' }} />
    </button>
  );
}

/* ── §7.3 Past performance ────────────────────────────────────────────────── */

function PastPerformanceCard() {
  return (
    <Card>
      <CardHead
        withDesc
        title="Past performance"
        description="Prime and subcontract history behind the capability claims, drawn from award data and client records."
        action={<LinkBtn>View all 14</LinkBtn>}
      />
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <div style={{ minWidth: 900 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              padding: '10px 24px',
              background: '#F9FAFB',
              borderTop: '1px solid #EAECF0',
              borderBottom: '1px solid #EAECF0',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: '#667085',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>Award</span>
            <span style={{ flex: '0 0 auto', width: 188 }}>Agency</span>
            <span style={{ flex: '0 0 auto', width: 96, textAlign: 'right' }}>Value</span>
            <span style={{ flex: '0 0 auto', width: 132 }}>Period</span>
            <span style={{ flex: '0 0 auto', width: 88 }}>Role</span>
            <span style={{ flex: '0 0 auto', width: 112 }}>Status</span>
          </div>
          {CAP_PERF.map((p) => (
            <PerfRow key={p.title} perf={p} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function PerfRow({ perf }: { perf: (typeof CAP_PERF)[number] }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 16,
        padding: '13px 24px',
        borderBottom: '1px solid #F2F4F7',
        textAlign: 'left',
        background: hover ? '#F9FAFB' : 'transparent',
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          fontWeight: 500,
          color: '#101828',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {perf.title}
      </span>
      <span
        style={{
          flex: '0 0 auto',
          width: 188,
          fontSize: 13,
          color: '#475467',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {perf.agency}
      </span>
      <span style={{ flex: '0 0 auto', width: 96, fontSize: 14, fontWeight: 600, color: '#101828', textAlign: 'right' }}>
        {perf.value}
      </span>
      <span style={{ flex: '0 0 auto', width: 132, fontSize: 13, color: '#475467' }}>{perf.period}</span>
      <span style={{ flex: '0 0 auto', width: 88, fontSize: 13, color: '#475467' }}>{perf.role}</span>
      <span style={{ flex: '0 0 auto', width: 112 }}>
        <Pill tone={perf.ui as PillTone}>{perf.status}</Pill>
      </span>
    </button>
  );
}
