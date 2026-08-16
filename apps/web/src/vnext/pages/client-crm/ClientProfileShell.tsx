import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { UIcon, PfButton, GRADIENT_DARK, GRADIENT_DARK_HOVER, PILL } from './portfolio-primitives.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import { CRM_TAB_LABELS, type CrmSurface, type CrmView } from './client-crm-routing.js';

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
  /** Rendered tab body. */
  children: ReactNode;
}

/** Focus chips come from the client's own intake vocabulary. */
function focusChipsFor(client: Client): string[] {
  const intake = (client.intakeData ?? {}) as Record<string, unknown>;
  const portfolio = Array.isArray(intake.portfolio) ? (intake.portfolio as string[]) : [];
  const tags = Array.isArray(intake.tags) ? (intake.tags as string[]) : [];
  return [...portfolio, ...tags].map((e) => String(e).trim()).filter(Boolean).slice(0, 4);
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 44,
          padding: '0 32px',
          background: '#ffffff',
          borderBottom: '1px solid #EAECF0',
          flexWrap: 'nowrap',
          overflow: 'hidden',
        }}
      >
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
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#475467', whiteSpace: 'nowrap' }}>
          <span className="cap-pf-anim-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: '#12B76A' }} />
          Intel refreshed 2h ago
        </span>
        <span style={{ color: '#D0D5DD' }}>·</span>
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
      <div style={{ background: '#ffffff', borderBottom: '1px solid #EAECF0', padding: '20px 32px 0' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          {/* 48px dark tile */}
          <span
            aria-hidden
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 48,
              height: 48,
              borderRadius: 10,
              background: client.logoUrl ? '#F2F4F7' : GRADIENT_DARK,
              color: '#ffffff',
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '.02em',
              overflow: 'hidden',
            }}
          >
            {client.logoUrl ? <img src={client.logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initialsFor(client.name)}
          </span>

          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>
                {client.name}
              </h1>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 24,
                  padding: '0 10px 0 8px',
                  borderRadius: 9999,
                  background: st,
                  boxShadow: `inset 0 0 0 1px ${sr}`,
                  color: sf,
                  fontSize: 12,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
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
                <span
                  key={chip}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 8,
                    background: '#F9FAFB',
                    boxShadow: 'inset 0 0 0 1px #EAECF0',
                    color: '#344054',
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {chip}
                </span>
              ))}
              <AddFocusButton />
            </div>
          </div>

          {/* Right cluster */}
          <div className="cap-pf-identity-right" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
              <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
                Account owner
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap' }}>Sarah Martinez</span>
            </span>
            <FillButton busy={fillBusy} label={fillLabel} onClick={onFillWithMeri} />
            <OverflowMenu client={client} onDataHealth={onDataHealth} />
          </div>
        </div>

        {/* ── Six-tab strip (§2.8 / §5.3) ─────────────────────────────────── */}
        <TabStrip tab={tab} onNavigate={onNavigate} />
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, padding: '28px 32px 44px' }}>
        <div style={{ maxWidth: 1360, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── small shell pieces ───────────────────────────────────────────────────── */

function Sep() {
  return <span style={{ color: '#D0D5DD', fontSize: 13 }}>/</span>;
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

function AddFocusButton() {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 26,
        padding: '0 10px',
        borderRadius: 8,
        boxShadow: 'inset 0 0 0 1px #D0D5DD',
        color: hover ? '#344054' : '#475467',
        background: hover ? '#F9FAFB' : 'transparent',
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

function FillButton({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
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
      {busy ? 'Analyzing…' : label}
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
  const [hover, setHover] = useState(false);
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        padding: '10px 14px 14px',
        fontSize: 15,
        fontWeight: 600,
        color: selected ? '#101828' : hover ? '#101828' : '#475467',
        boxShadow: selected ? 'inset 0 -2px 0 #101828' : 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

/* ── Overflow menu (§5.2) ─────────────────────────────────────────────────── */

function OverflowMenu({ client, onDataHealth }: { client: Client; onDataHealth: () => void }) {
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

  const items: Array<{ label: string; danger?: boolean; onSelect: () => void }> = [
    { label: 'Ask Meri about this client', onSelect: () => setOpen(false) },
    { label: 'Profile & source health', onSelect: () => { setOpen(false); onDataHealth(); } },
    { label: 'Export client profile', onSelect: () => setOpen(false) },
    { label: 'Archive client', danger: true, onSelect: () => setOpen(false) },
  ];

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <MenuTrigger open={open} onClick={() => setOpen((v) => !v)} name={client.name} />
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 48,
            zIndex: 35,
            width: 248,
            background: '#ffffff',
            borderRadius: 12,
            boxShadow: '0 0 0 1px #EAECF0,0px 12px 16px -4px rgba(16,24,40,.08)',
            padding: 6,
            animation: 'capPfFade .12s ease',
          }}
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
        boxShadow: 'inset 0 0 0 1px #D0D5DD',
        color: '#475467',
        background: hover ? '#F9FAFB' : 'transparent',
      }}
    >
      <UIcon name="DotsHorizontal" size={20} />
    </button>
  );
}

function MenuItem({ item }: { item: { label: string; danger?: boolean; onSelect: () => void } }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={item.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'block',
        width: '100%',
        padding: '9px 12px',
        borderRadius: 8,
        fontSize: 14,
        color: item.danger ? '#B42318' : '#101828',
        background: hover ? '#F9FAFB' : 'transparent',
        textTransform: 'none',
        letterSpacing: 0,
        fontWeight: 400,
      }}
    >
      {item.label}
    </button>
  );
}
