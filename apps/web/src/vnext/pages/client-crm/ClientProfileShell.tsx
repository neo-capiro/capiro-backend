import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { UIcon, PfButton, GRADIENT_DARK, PILL } from './portfolio-primitives.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import { sectorLabel } from '../../lib/labels.js';
import { openMeriWorkspaceWithContext } from '../../../components/chat/meri-window.js';
import { CRM_TAB_LABELS, type CrmSurface, type CrmView } from './client-crm-routing.js';
import { useClientAccountOwner } from './useClientAccountOwner.js';
import './client-profile-shell.css';

/**
 * Responsive breakpoint flags (spec §1.6): narrow = w<1200, tight = w<1024,
 * collapsed = w<1440. Exposed as data attributes on the .cap-pf root so column
 * templates flip declaratively in portfolio-proto.css.
 */
function usePfBreakpoints() {
  const [flags, setFlags] = useState({ narrow: false, tight: false, collapsed: false });
  useEffect(() => {
    const compute = () => {
      const w = window.innerWidth;
      setFlags({ narrow: w < 1200, tight: w < 1024, collapsed: w < 1440 });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);
  return flags;
}

/**
 * Portfolio prototype client shell (spec §5). Wraps every /clients?clientId=
 * route body: breadcrumb bar → identity block → six-tab strip. The shared
 * AppShellUui owns the global top bar + rail; this shell owns everything below
 * it inside the client route, transcribed from the prototype's inline styles.
 */

export interface ProfileShellProps {
  client: Client;
  tab: CrmSurface;
  view: CrmView | null;
  onNavigate: (tab: CrmSurface, view?: CrmView | null) => void;
  onFillWithMeri: () => void;
  onDataHealth: () => void;
  fillBusy?: boolean;
  fillLabel?: string;
  syncLabel?: string;
  onSync?: () => void;
  profileGapCount?: number;
  /**
   * Item 11: how fresh the client's sources on screen are, already phrased
   * ("4 minutes ago"). Null while nothing has loaded — the label then says so
   * instead of asserting a freshness nobody measured.
   */
  refreshedLabel?: string | null;
  /** Sources that could not be read at all; the dot stops claiming health. */
  sourceFailures?: number;
  /** Item 9: archive is gated at standard_user on the API. */
  canArchive?: boolean;
  onArchive?: () => void;
  /** Item 10: the client PUT behind a focus tag is gated at user_admin. */
  canEditFocus?: boolean;
  /** Rendered tab body. */
  children: ReactNode;
}

/** Focus chips come from the client's own intake vocabulary. The form writes
 * `intakeData.sectors` (multi-select); `portfolio`/`tags` are legacy keys that
 * are usually absent, which left the header's FOCUS row empty while the
 * Overview card showed a sector. The primary `sectorTag` seeds the row when
 * nothing else does, humanized so no raw SNAKE_CASE token renders. */
function focusChipsFor(client: Client): string[] {
  const intake = (client.intakeData ?? {}) as Record<string, unknown>;
  const portfolio = Array.isArray(intake.portfolio) ? (intake.portfolio as string[]) : [];
  const tags = Array.isArray(intake.tags) ? (intake.tags as string[]) : [];
  const sectors = Array.isArray(intake.sectors) ? (intake.sectors as string[]) : [];
  const chips = [...portfolio, ...tags, ...sectors]
    .map((e) => sectorLabel(String(e)) ?? '')
    .filter(Boolean);
  if (chips.length === 0) {
    const primary = sectorLabel(client.sectorTag);
    if (primary) chips.push(primary);
  }
  return [...new Set(chips)].slice(0, 4);
}

export function ClientProfileShell({
  client,
  tab,
  onNavigate,
  onFillWithMeri,
  onDataHealth,
  fillBusy = false,
  fillLabel = 'Fill with Meri',
  syncLabel = 'Sync',
  onSync,
  profileGapCount = 0,
  refreshedLabel = null,
  sourceFailures = 0,
  canArchive = false,
  onArchive,
  canEditFocus = false,
  children,
}: ProfileShellProps) {
  const chips = focusChipsFor(client);
  const isActive = (client.status ?? '').toLowerCase() === 'active';
  const statusTone = isActive ? 'success' : (client.status ?? '').toLowerCase() === 'at risk' ? 'warning' : 'gray';
  const [st, sr, sf, sd] = PILL[statusTone];
  const bp = usePfBreakpoints();
  const navigate = useNavigate();

  return (
    <div
      className="cap-pf cap-pf-client"
      data-pf-narrow={bp.narrow ? '1' : undefined}
      data-pf-tight={bp.tight ? '1' : undefined}
      data-pf-collapsed={bp.collapsed ? '1' : undefined}
    >
      {/* ── Breadcrumb bar (§5.1) ─────────────────────────────────────────── */}
      {/* Horizontal padding lives in client-crm.css (.cap-pf-client__crumbs) —
          it re-centers this full-bleed band now that the shell's own 1280px
          cap is escaped for this route (see the escape rule at the top of
          that file), and drops to 16px at 779px so a phone still gets an
          inset instead of the shell's now-removed padding. */}
      <div className="cap-pf-client__crumbs cap-pf-breadcrumb-bar">
        <CrumbButton label="Portfolio" onClick={() => navigate('/clients')} />
        <Sep />
        <CrumbButton label="Clients" onClick={() => navigate('/clients')} />
        <Sep />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '.03em',
            textTransform: 'uppercase',
            color: '#101828',
            whiteSpace: 'nowrap',
          }}
        >
          {client.name}
        </span>
        <span style={{ flex: 1 }} />
        {/* Item 11: real freshness. The green pulse is a health claim, so it
            only shows when every source answered — a failing source turns the
            dot amber and the copy says what happened instead of a stale time.
            This measures when the app last fetched, which is what "refreshed"
            means here; no per-client ingestion timestamp exists to read. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#475467', whiteSpace: 'nowrap' }}>
          <span
            className={sourceFailures === 0 ? 'cap-pf-anim-pulse' : undefined}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: sourceFailures > 0 ? '#F79009' : refreshedLabel ? '#12B76A' : '#98A2B3',
            }}
          />
          {sourceFailures > 0
            ? `${sourceFailures} source${sourceFailures === 1 ? '' : 's'} unavailable`
            : refreshedLabel
              ? `Sources read ${refreshedLabel}`
              : 'Reading sources…'}
        </span>
        <span style={{ color: '#E0DCD4' }}>·</span>
        {profileGapCount > 0 ? (
          <CrumbButton
            label={`${profileGapCount} profile gap${profileGapCount === 1 ? '' : 's'}`}
            strong
            onClick={onDataHealth}
          />
        ) : null}
        <CrumbButton label={syncLabel} onClick={onSync} />
      </div>

      {/* ── Identity block (§5.2) ─────────────────────────────────────────── */}
      {/* Same reasoning as the breadcrumb bar above: horizontal padding moved
          to .cap-pf-client__identity in client-crm.css so it re-centers at
          1440px (with a 32px floor) instead of the shell's escaped 1280px
          cap, and drops to 16px at 779px. */}
      <div className="cap-pf-client__identity" style={{ background: '#ffffff', borderBottom: '1px solid #E8E5DF' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          {/* 48px dark tile */}
          <span
            aria-hidden
            className={client.logoUrl ? 'cap-pf-identity-tile' : 'cap-pf-identity-tile cap-pf-identity-tile--dark'}
            style={{ color: '#ffffff', fontSize: 15, fontWeight: 600, letterSpacing: '.02em' }}
          >
            {client.logoUrl ? <img src={client.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsFor(client.name)}
          </span>

          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h1 className="cap-pf-client-name">
                {client.name}
              </h1>
              <span
                className="cap-pf-status-pill"
                style={{ background: st, border: `1px solid ${sr}`, color: sf }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sd }} />
                {isActive ? 'Active client' : (client.status ?? 'Unknown status')}
              </span>
            </div>

            {/* Focus row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', marginRight: 2 }}>
                Focus
              </span>
              {chips.map((chip) => (
                <span key={chip} className="cap-pf-focus-chip">
                  {chip}
                </span>
              ))}
              {canEditFocus ? <AddFocusButton client={client} existing={chips} /> : null}
            </div>
          </div>

          {/* Right cluster */}
          <div className="cap-pf-identity-right" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 16 }}>
            <AccountOwnerControl clientId={client.id} canAssign={canEditFocus} />
            <MeriActionsMenu busy={fillBusy} fillLabel={fillLabel} onFillWithMeri={onFillWithMeri} />
            <OverflowMenu client={client} onDataHealth={onDataHealth} canArchive={canArchive} onArchive={onArchive} />
          </div>
        </div>

        {/* ── Six-tab strip (§2.8 / §5.3) ─────────────────────────────────── */}
        <TabStrip tab={tab} onNavigate={onNavigate} />
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      {/*
       * Previously two nested divs: an outer full-bleed 32px-padding spacer
       * and an inner `maxWidth: 1360` centering box. That 1360 was already a
       * no-op — the shell capped `.uui-content` at 1280px, so nothing this
       * route rendered ever reached 1360 to begin with. Now that the shell's
       * cap is escaped (client-crm.css, `.uui-content:has(.cap-pf-client)`),
       * the max-width takes real effect, so it is collapsed into one node and
       * bumped to 1440 to match the sitewide Dashboard/Strategies convention
       * (dashboard.css / strategies.css `.st-canvas`). Padding + the 779px
       * mobile step live in `.cap-pf-client__body` (client-crm.css).
       */}
      <div className="cap-pf-client__body">{children}</div>
    </div>
  );
}

/* ── small shell pieces ───────────────────────────────────────────────────── */

function Sep() {
  return <span style={{ color: '#E0DCD4', fontSize: 13 }}>/</span>;
}

function CrumbButton({ label, strong = false, onClick }: { label: string; strong?: boolean; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '.03em',
        textTransform: 'uppercase',
        color: strong ? (hover ? '#0E141C' : '#101828') : hover ? '#101828' : '#667085',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function AccountOwnerControl({ clientId, canAssign }: { clientId: string; canAssign: boolean }) {
  const owner = useClientAccountOwner(clientId, canAssign);
  const currentMissing =
    owner.owner != null && !owner.options.some((option) => option.id === owner.owner?.id);
  const display = owner.isLoading ? 'Loading…' : owner.ownerLabel ?? 'Unassigned';

  return (
    <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
        Account owner
      </span>
      {canAssign ? (
        <select
          aria-label="Account owner"
          value={owner.assignment?.accountOwnerUserId ?? ''}
          disabled={owner.isLoading || owner.isAssigning}
          onChange={(event) => owner.setOwner(event.target.value || null)}
          title={owner.error instanceof Error ? owner.error.message : undefined}
          className={owner.error ? 'cap-pf-account-owner-select cap-pf-account-owner-select--error' : 'cap-pf-account-owner-select'}
          style={{ padding: '0 24px 0 8px', fontWeight: 600, cursor: owner.isLoading || owner.isAssigning ? 'wait' : 'pointer' }}
        >
          <option value="">Unassigned</option>
          {currentMissing && owner.owner ? (
            <option value={owner.owner.id}>{`${owner.ownerLabel ?? owner.owner.email} (inactive)`}</option>
          ) : null}
          {owner.options.map((option) => {
            const name = [option.firstName, option.lastName].filter(Boolean).join(' ').trim() || option.email;
            return <option key={option.id} value={option.id}>{name}</option>;
          })}
        </select>
      ) : (
        <span
          title={owner.error instanceof Error ? owner.error.message : undefined}
          style={{ fontSize: 14, fontWeight: 600, color: owner.ownerLabel ? '#344054' : '#98A2B3', whiteSpace: 'nowrap' }}
        >
          {owner.error ? 'Unavailable' : display}
        </span>
      )}
    </label>
  );
}

/**
 * Item 10 (wire-audit "3 Compose extend"): add a focus tag for real.
 *
 * Focus chips read `intakeData.portfolio` + `intakeData.tags`; new ones are
 * written to `tags`, since `portfolio` is the strategy/programme a client sits
 * in rather than a free-form label. **`PUT /api/clients/:id` REPLACES the whole
 * `intakeData` blob** (`intakeData: input.intakeData ?? {}` in the service), so
 * this sends the existing blob back with `tags` extended — never `{tags}`
 * alone, which would silently wipe every other intake field.
 *
 * The API gates that PUT at `user_admin`, so the button only renders for users
 * who can actually save; showing an input that always 403s would be worse than
 * not showing it.
 */
function AddFocusButton({ client, existing }: { client: Client; existing: string[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const save = useMutation({
    mutationFn: async (tag: string) => {
      const intake = (client.intakeData ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(intake.tags) ? (intake.tags as unknown[]).map(String) : [];
      return (
        await api.put<Client>(`/api/clients/${client.id}`, {
          intakeData: { ...intake, tags: [...tags, tag] },
        })
      ).data;
    },
    onSuccess: (updated) => {
      qc.setQueryData(['client', client.id], updated);
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['client', client.id] });
      setValue('');
      setOpen(false);
    },
  });

  const trimmed = value.trim();
  const duplicate = existing.some((chip) => chip.toLowerCase() === trimmed.toLowerCase());
  const submit = () => {
    if (!trimmed || duplicate || save.isPending) return;
    save.mutate(trimmed);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 26,
          padding: '0 10px',
          borderRadius: 8,
          border: '1px solid #E0DCD4',
          color: hover ? '#344054' : '#475467',
          background: hover ? '#FAF9F6' : 'transparent',
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <UIcon name="Plus" size={14} />
        Add
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        ref={inputRef}
        value={value}
        maxLength={60}
        aria-label="New focus tag"
        placeholder="e.g. Autonomy"
        disabled={save.isPending}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') {
            setValue('');
            setOpen(false);
          }
        }}
        className={duplicate ? 'cap-pf-add-focus-input cap-pf-add-focus-input--duplicate' : 'cap-pf-add-focus-input'}
        style={{ height: 26, width: 148, padding: '0 8px', outline: 'none' }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!trimmed || duplicate || save.isPending}
        style={{
          height: 26,
          padding: '0 10px',
          borderRadius: 8,
          background: !trimmed || duplicate ? '#F2F0EB' : GRADIENT_DARK,
          color: !trimmed || duplicate ? '#98A2B3' : '#ffffff',
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {duplicate ? (
        <span style={{ fontSize: 12, color: '#B42318', whiteSpace: 'nowrap' }}>Already a focus</span>
      ) : null}
      {save.isError ? (
        <span style={{ fontSize: 12, color: '#B42318', whiteSpace: 'nowrap' }}>
          {save.error instanceof Error ? save.error.message : 'Could not save'}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One Meri entry point on the record (replaces the plain "Fill with Meri"
 * button). Fill still opens the same review drawer via the same `onClick`
 * prop and still writes nothing until the caller applies it.
 *
 * "Send Meri to Meetings" is drawn from the design handoff, but there is no
 * per-client auto-join-meetings preference anywhere in the schema — Meri's
 * notetaker is wired per-meeting today (`apps/api/src/engagement/notetaker`),
 * not as a standing "join every meeting with this client" setting. Rendering
 * it as a working action would show a false success message for something
 * that does not happen, so it stays disabled with a "Coming soon" tag until a
 * real preference exists to back it — same treatment STATES.md already
 * anticipates for the Coalitions rail item.
 */
function MeriActionsMenu({ busy, fillLabel, onFillWithMeri }: { busy: boolean; fillLabel: string; onFillWithMeri: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 14px 0 13px',
          borderRadius: 8,
          backgroundImage: GRADIENT_DARK,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(16,24,40,.12)',
          color: '#ffffff',
          fontSize: 14,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <UIcon name="Stars02" size={18} color="#ffffff" />
        Meri Actions
        <span style={{ display: 'flex', opacity: 0.7, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms cubic-bezier(.2,0,0,1)' }}>
          <UIcon name="ChevronDown" size={16} color="#ffffff" />
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Meri Actions"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 45,
            width: 344,
            padding: 6,
            borderRadius: 12,
            background: '#ffffff',
            border: '1px solid #E4E7EC',
            boxShadow: '0 18px 44px -14px rgba(16,24,40,.28),0 2px 6px rgba(16,24,40,.05)',
          }}
        >
          <MeriActionItem
            icon="Stars02"
            label={busy ? 'Analyzing…' : fillLabel}
            detail="Meri proposes field values from connected sources. Nothing is written until you review each one."
            onSelect={() => {
              setOpen(false);
              onFillWithMeri();
            }}
          />
          <MeriActionItem
            icon="Calendar2"
            label="Send Meri to Meetings"
            detail="Meri joins every meeting with this client as a notetaker, automatically."
            disabled
            disabledReason="Coming soon"
          />
        </div>
      ) : null}
    </div>
  );
}

function MeriActionItem({
  icon,
  label,
  detail,
  onSelect,
  disabled = false,
  disabledReason,
}: {
  icon: string;
  label: string;
  detail: string;
  onSelect?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'flex-start',
        gap: 12,
        padding: '11px 10px',
        borderRadius: 9,
        textAlign: 'left',
        background: hover && !disabled ? '#F7F8FA' : 'transparent',
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, background: '#F2F4F7', color: '#344054' }}>
        <UIcon name={icon} size={16} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#101828' }}>{label}</span>
          {disabled && disabledReason ? (
            <span style={{ flex: '0 0 auto', height: 18, padding: '0 6px', borderRadius: 9999, background: '#F2F0EB', color: '#667085', fontSize: 10, fontWeight: 600, letterSpacing: '.02em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center' }}>
              {disabledReason}
            </span>
          ) : null}
        </span>
        <span style={{ display: 'block', marginTop: 3, fontSize: 12, lineHeight: '17px', color: '#667085', textWrap: 'pretty' }}>{detail}</span>
      </span>
    </button>
  );
}

function TabStrip({ tab, onNavigate }: { tab: CrmSurface; onNavigate: (t: CrmSurface) => void }) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = CRM_TAB_LABELS.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next == null) return;
    event.preventDefault();
    const target = CRM_TAB_LABELS[next];
    if (!target) return;
    tabRefs.current[next]?.focus();
    onNavigate(target.key);
  };

  return (
    <div role="tablist" aria-label="Client sections" style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 18 }}>
      {CRM_TAB_LABELS.map((t, index) => {
        const selected = tab === t.key;
        return (
          <TabButton
            key={t.key}
            tabKey={t.key}
            refCb={(node) => {
              tabRefs.current[index] = node;
            }}
            selected={selected}
            label={t.label}
            onClick={() => onNavigate(t.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
          />
        );
      })}
    </div>
  );
}

function TabButton({
  selected,
  label,
  onClick,
  onKeyDown,
  refCb,
  tabKey,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  refCb: (node: HTMLButtonElement | null) => void;
  tabKey: string;
}) {
  return (
    <button
      ref={refCb}
      type="button"
      role="tab"
      id={`cap-pf-tab-${tabKey}`}
      aria-selected={selected}
      aria-controls={`cap-pf-panel-${tabKey}`}
      tabIndex={selected ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="cap-pf-tab-btn"
    >
      {label}
    </button>
  );
}

/* ── Overflow menu (§5.2) ─────────────────────────────────────────────────── */

function OverflowMenu({
  client,
  onDataHealth,
  canArchive,
  onArchive,
}: {
  client: Client;
  onDataHealth: () => void;
  canArchive?: boolean;
  onArchive?: () => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /**
   * Wire-audit "3 Compose extend" item 5: Export client profile. There is no
   * server-side export-pack endpoint, so the export composes from the two
   * existing endpoints already called by the profile (client record +
   * intelligence profile) into a downloadable JSON file. The data is real —
   * no fixture is generated. A dedicated PDF/printable pack would be a new
   * capability (L); this composition closes the UNWIRED menu item honestly.
   */
  const exportProfile = async () => {
    setExporting(true);
    try {
      const [clientRec, intelProfile] = await Promise.all([
        api.get<Client>(`/api/clients/${client.id}`),
        api.get(`/api/intelligence/client-profile/${client.id}`).catch(() => null),
      ]);
      const payload = {
        exportedAt: new Date().toISOString(),
        client: clientRec.data,
        intelligence: intelProfile?.data ?? null,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${client.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}-profile.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch {
      // Keep the menu open so the user sees it didn't work; the error is
      // transient (network/permissions) and doesn't need a persistent banner.
    } finally {
      setExporting(false);
    }
  };

  const items: Array<{ label: string; danger?: boolean; onSelect: () => void }> = [
    {
      // Item 18 (wire-audit "2 Wire existing APIs"): opens the real Meriv3
      // workspace scoped to this client. The prompt is required — Meri's own
      // `readContextRequest()` drops a clientId that arrives without one — so
      // it carries the client by name rather than being left blank.
      label: 'Ask Meri about this client',
      onSelect: () => {
        setOpen(false);
        openMeriWorkspaceWithContext({
          prompt: `What should I know about ${client.name} right now?`,
          clientId: client.id,
        });
      },
    },
    { label: 'Profile & source health', onSelect: () => { setOpen(false); onDataHealth(); } },
    { label: exporting ? 'Exporting…' : 'Export client profile', onSelect: exportProfile },
  ];

  // Item 9: only offered to users the API would actually let archive
  // (DELETE /api/clients/:id is @Roles('standard_user')). The confirm dialog
  // and the write itself live in ClientCrmPage.
  if (canArchive && onArchive) {
    items.push({
      label: 'Archive client',
      danger: true,
      onSelect: () => {
        setOpen(false);
        onArchive();
      },
    });
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <MenuTrigger open={open} onClick={() => setOpen((v) => !v)} name={client.name} />
      {open ? (
        <div
          role="menu"
          className="cap-pf-overflow-menu"
          style={{ padding: 6, animation: 'capPfFade .12s ease' }}
        >
          {items.map((item) => (
            <MenuItem key={item.label} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MenuTrigger({ open, onClick, name }: { open: boolean; onClick: () => void; name: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={`More actions for ${name}`}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 40,
        borderRadius: 8,
        border: '1px solid #E0DCD4',
        color: '#475467',
        background: hover ? '#FAF9F6' : 'transparent',
      }}
    >
      <UIcon name="DotsHorizontal" size={20} />
    </button>
  );
}

function MenuItem({ item }: { item: { label: string; danger?: boolean; onSelect: () => void } }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={item.onSelect}
      className={item.danger ? 'cap-pf-menu-item cap-pf-menu-item--danger' : 'cap-pf-menu-item'}
    >
      {item.label}
    </button>
  );
}
