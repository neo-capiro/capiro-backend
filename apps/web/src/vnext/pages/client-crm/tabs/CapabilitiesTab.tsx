import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardHead,
  EvidenceChip,
  Pill,
  TabPageHead,
  GRADIENT_DARK,
  GRADIENT_DARK_HOVER,
  type EvidenceTier,
  type PillTone,
} from '../portfolio-primitives.js';
import { CAP_PERF } from '../portfolio-fixtures.js';
import { useApi } from '../../../../lib/use-api.js';
import { CapabilityDrawerVNext } from '../CapabilityDrawerVNext.js';
import { CapabilityCreateFormVNext } from '../CapabilityCreateFormVNext.js';
import type { Capability } from '../../../../pages/clients/capability-types.js';
import { readClientRegistrations } from '../../../../pages/clients/client-registrations.js';
import {
  OUTCOME_TONE,
  OUTCOME_TYPE_LABEL,
} from '../../../../pages/clients/submission-history-api.js';
import { useClientSubmissions, type SubmissionWithCapability } from '../client-submissions.js';
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
 * TRL, program line from peNumbers, tags from tags. **The design's per-area
 * "matches" count and evidence tier/source have NO field on the capability
 * model** — they used to be read off the CAP_AREAS fixture at the same index,
 * which stamped invented match counts and provenance tiers onto real client
 * capabilities. They are now omitted on live records (wire-audit "4 New
 * capability" row 2). §7.2 registrations & codes is real — it reads the
 * government identifiers the Company Info wizard writes (see
 * `readClientRegistrations`). §7.3 past performance is real: it reads the
 * client's `ClientSubmissionHistory` rows across its capabilities (row 12).
 * §7.2 capability-fit rows have no per-client backend and stay fixture.
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
  const areas: CapabilityAreaView[] = live.map((cap) => toLiveAreaView(cap));

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
        <RegistrationsCard client={client} />
        <CapabilityFitCard />
      </div>

      {/* §7.3 Past performance */}
      <PastPerformanceCard client={client} />

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
        {area.pe === 'Not yet mapped' ? (
          // One quiet line instead of a full labeled block — a roster where
          // every card shouts PROGRAM LINE / Not yet mapped is noise, not data.
          <span style={{ fontSize: 12, color: '#98A2B3' }}>No program line mapped yet</span>
        ) : (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
              Program line
            </span>
            <span style={{ fontSize: 13, color: '#101828' }}>{area.pe}</span>
          </span>
        )}
        {/* Rendered only when a source exists for them — see CapabilityAreaView. */}
        {area.matches ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
              Matches
            </span>
            <span style={{ fontSize: 13, color: '#101828' }}>{area.matches}</span>
          </span>
        ) : null}
        <span style={{ flex: 1, minWidth: 8 }} />
        {area.tier ? <EvidenceChip tier={area.tier} label={area.source ?? ''} /> : null}
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
            <span style={{ fontSize: 13, color: '#667085', whiteSpace: 'nowrap' }}>
              {`SAM.gov · ${samStatus}${samExpiration ? ` · expires ${formatRegDate(samExpiration)}` : ''}`}
            </span>
          ) : null
        }
      />
      <div style={{ padding: '6px 24px 20px' }}>
        {rows.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '8px 0 4px' }}>
            <p style={{ margin: 0, fontSize: 14, color: '#667085' }}>
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

/**
 * Wire-audit "4 New capability" item 3 (client-profile Excel row 45):
 * Capability fit recommendations have no backend — "Needs PE/FO matching
 * scored against capabilities" is a Hard/L gap. The CAP_FIT fixture (bill/PE
 * targets with invented fit scores) implied real matches the product cannot
 * produce. The honest treatment is an explicit empty state that names the gap,
 * the same pattern used by the NetworkCard and the advocacy evidence footer.
 */
function CapabilityFitCard() {
  return (
    <Card>
      <CardHead
        withDesc
        title="Where capabilities create fit"
        description="The matches Capiro draws from this record, and the reason behind each one."
      />
      <div style={{ padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>No fit matches yet</span>
        <span style={{ fontSize: 13, color: '#98A2B3', textAlign: 'center', maxWidth: 340, textWrap: 'pretty' }}>
          Capability-to-PE and capability-to-bill matching is not available yet. Recorded capabilities above show what this client can do.
        </span>
      </div>
    </Card>
  );
}

/* ── §7.3 Past performance ────────────────────────────────────────────────── */

/**
 * §7.3 Past performance — real (wire-audit "4 New capability" row 12).
 *
 * Reads the client's `ClientSubmissionHistory` rows across its capabilities.
 * The columns differ from the design's on purpose: that table wanted Agency /
 * Value / Period / Role, and this store carries none of those — it holds
 * fiscal year, title, free-text meta, an outcome and its coarse type. Inventing
 * a dollar value or a prime/sub role beside a real submission title would read
 * as award data the product does not have, so the table shows what is stored.
 * "View all N" is the real row count, not the design's 14.
 */
function PastPerformanceCard({ client }: { client: Client }) {
  const { rows, settled, failed } = useClientSubmissions(client.id);
  const [showAll, setShowAll] = useState(false);
  // Fixture only while the reads are in flight or errored — never as a
  // stand-in for a client with no recorded history.
  const showFixture = !settled || failed;
  const genuinelyEmpty = settled && !failed && rows.length === 0;
  const hasMore = !showFixture && rows.length > 3;
  const visibleRows = hasMore && !showAll ? rows.slice(0, 3) : rows;

  return (
    <Card>
      <CardHead
        withDesc
        title="Past performance"
        description="Submissions recorded against this client's capabilities, and what happened to each."
        action={
          showFixture || rows.length === 0 ? null : hasMore ? (
            <LinkBtn onClick={() => setShowAll((current) => !current)}>
              {showAll ? 'Show recent' : `View all ${rows.length}`}
            </LinkBtn>
          ) : (
            <span style={{ fontSize: 13, color: '#667085', whiteSpace: 'nowrap' }}>
              {`${rows.length} record${rows.length === 1 ? '' : 's'}`}
            </span>
          )
        }
      />
      {genuinelyEmpty ? (
        <p style={{ margin: 0, padding: '4px 24px 20px', fontSize: 14, color: '#667085' }}>
          No submissions recorded against this client&apos;s capabilities yet.
        </p>
      ) : (
        <div style={{ width: '100%', overflowX: 'auto' }}>
          <div style={{ minWidth: showFixture ? 900 : 720 }}>
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
              {showFixture ? (
                <>
                  <span style={{ flex: 1, minWidth: 0 }}>Award</span>
                  <span style={{ flex: '0 0 auto', width: 188 }}>Agency</span>
                  <span style={{ flex: '0 0 auto', width: 96, textAlign: 'right' }}>Value</span>
                  <span style={{ flex: '0 0 auto', width: 132 }}>Period</span>
                  <span style={{ flex: '0 0 auto', width: 88 }}>Role</span>
                  <span style={{ flex: '0 0 auto', width: 112 }}>Status</span>
                </>
              ) : (
                <>
                  <span style={{ flex: '0 0 auto', width: 72 }}>FY</span>
                  <span style={{ flex: 1, minWidth: 0 }}>Submission</span>
                  <span style={{ flex: '0 0 auto', width: 188 }}>Capability</span>
                  <span style={{ flex: '0 0 auto', width: 132 }}>Outcome</span>
                  <span style={{ flex: '0 0 auto', width: 112 }}>Status</span>
                </>
              )}
            </div>
            {showFixture
              ? CAP_PERF.map((p) => <PerfRow key={p.title} perf={p} />)
              : visibleRows.map((row) => <SubmissionRow key={row.id} row={row} />)}
          </div>
        </div>
      )}
    </Card>
  );
}

function SubmissionRow({ row }: { row: SubmissionWithCapability }) {
  const [hover, setHover] = useState(false);
  const tone = (OUTCOME_TONE[row.outcomeType] ?? 'gray') as PillTone;
  return (
    <div
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
      <span style={{ flex: '0 0 auto', width: 72, fontSize: 13, fontWeight: 600, color: '#101828' }}>
        {row.fiscalYear}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>
          {row.title}
        </span>
        {row.meta ? (
          <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085', textWrap: 'pretty' }}>
            {row.meta}
          </span>
        ) : null}
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
        {row.capabilityName ?? '—'}
      </span>
      <span style={{ flex: '0 0 auto', width: 132, fontSize: 13, color: '#475467', textWrap: 'pretty' }}>
        {/* The free-text outcome when there is one; the coarse type is the pill. */}
        {row.outcome ?? '—'}
      </span>
      <span style={{ flex: '0 0 auto', width: 112 }}>
        <Pill tone={tone}>{OUTCOME_TYPE_LABEL[row.outcomeType] ?? row.outcomeType}</Pill>
      </span>
    </div>
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
