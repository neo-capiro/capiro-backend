import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Pill, Tile, Avatar, UIcon, GRADIENT_DARK, GRADIENT_DARK_HOVER } from './portfolio-primitives.js';
import { SOURCES, LEVELS } from './portfolio-fixtures.js';

/**
 * Portfolio prototype overlays (spec §12). Two shells (drawer §2.16, modal
 * §2.17) + the toast (§2.18). Focus is trapped, Escape and scrim close a clean
 * overlay, the shell behind stays visible. Geometry is transcribed from the
 * prototype's inline styles (lines 1792–2141 of the DOM dump).
 */

/* ── Drawer shell (§2.16) ────────────────────────────────────────────────── */

export function PfDrawer({
  eyebrow,
  title,
  sub,
  onClose,
  footer,
  width = 560,
  narrow = false,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
  narrow?: boolean;
  children: ReactNode;
}) {
  useEscape(onClose);
  const w = narrow ? 480 : width;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : eyebrow}>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(12,17,29,.55)', animation: 'capPfFade .16s ease' }}
      />
      <aside
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: w,
          maxWidth: '92vw',
          background: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-8px 0 24px -4px rgba(16,24,40,.14)',
          animation: 'capPfSlideIn .2s ease',
        }}
      >
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', gap: 12, padding: '24px 28px 18px', borderBottom: '1px solid #EAECF0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{eyebrow}</div>
            <h2 style={{ margin: '8px 0 0', fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828', textWrap: 'pretty' }}>{title}</h2>
            {sub ? <div style={{ marginTop: 4, fontSize: 15, color: '#475467', textWrap: 'pretty' }}>{sub}</div> : null}
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 28px 28px' }}>{children}</div>
        {footer ? (
          <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px', borderTop: '1px solid #EAECF0', background: '#ffffff' }}>
            <span style={{ flex: 1 }} />
            {footer}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/* ── Modal shell (§2.17) ─────────────────────────────────────────────────── */

export function PfModal({
  eyebrow,
  title,
  sub,
  onClose,
  footer,
  footerLeft,
  maxWidth = 720,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  footerLeft?: ReactNode;
  maxWidth?: number;
  children: ReactNode;
}) {
  useEscape(onClose);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : eyebrow}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(12,17,29,.55)', animation: 'capPfFade .16s ease' }} />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth,
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          borderRadius: 14,
          boxShadow: '0px 20px 24px -4px rgba(16,24,40,.14),0px 8px 8px -4px rgba(16,24,40,.04)',
          animation: 'capPfPop .18s ease',
          overflow: 'hidden',
        }}
      >
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', gap: 12, padding: '24px 28px 16px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{eyebrow}</div>
            <h2 style={{ margin: '8px 0 0', fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>{title}</h2>
            {sub ? <p style={{ margin: '6px 0 0', fontSize: 15, lineHeight: '22px', color: '#475467', textWrap: 'pretty' }}>{sub}</p> : null}
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 28px 20px' }}>{children}</div>
        {footer || footerLeft ? (
          <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px', borderTop: '1px solid #EAECF0', flexWrap: 'wrap' }}>
            {footerLeft}
            <span style={{ flex: 1 }} />
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── Toast (§2.18) — dark pill, bottom-centre, 2400ms ───────────────────── */

export function PfToast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 18px',
        borderRadius: 10,
        background: GRADIENT_DARK,
        color: '#ffffff',
        boxShadow: '0px 12px 16px -4px rgba(16,24,40,.18)',
        animation: 'capPfPop .18s ease',
        fontSize: 14,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#12B76A' }} />
      {message}
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────────── */

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function CloseButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 8,
        color: hover ? '#101828' : '#667085',
        background: hover ? '#F9FAFB' : 'transparent',
        boxShadow: 'inset 0 0 0 1px #EAECF0',
      }}
    >
      <UIcon name="XClose" size={16} />
    </button>
  );
}

function PrimaryFooterBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
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
        height: 40,
        padding: '0 16px',
        borderRadius: 8,
        background: hover ? GRADIENT_DARK_HOVER : GRADIENT_DARK,
        color: '#ffffff',
        fontSize: 14,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        boxShadow: '0px 1px 2px rgba(16,24,40,.05)',
      }}
    >
      {children}
    </button>
  );
}

function GhostFooterBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
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
        height: 40,
        padding: '0 16px',
        borderRadius: 8,
        color: hover ? '#101828' : '#475467',
        background: hover ? '#F9FAFB' : 'transparent',
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

function UpperLink({ children, danger = false, onClick }: { children: ReactNode; danger?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ fontSize: 13, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase', color: danger ? '#B42318' : '#101828' }}
    >
      {children}
    </button>
  );
}

function SubPanel({ title, action, borderTop = false, children }: { title: ReactNode; action?: ReactNode; borderTop?: boolean; children: ReactNode }) {
  return (
    <div style={borderTop ? { paddingTop: 20, borderTop: '1px solid #EAECF0' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: '#101828' }}>{title}</h3>
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </div>
  );
}

function ReadField({ label, value, truncate = false }: { label: string; value: ReactNode; truncate?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>{label}</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 44,
          marginTop: 6,
          padding: '0 14px',
          borderRadius: 8,
          background: '#F9FAFB',
          boxShadow: 'inset 0 0 0 1px #EAECF0',
          fontSize: 14,
          color: '#101828',
          ...(truncate ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
        }}
      >
        {value}
      </div>
    </div>
  );
}

function DrawerStack({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>{children}</div>;
}

/* ═══════════════════════════ §12.1 Person drawer ════════════════════════════ */

export interface PersonRecord {
  level: string;
  levelFull: string;
  init: string;
  name: string;
  title: string;
  meta: string;
  email: string;
  phone: string;
  location: string;
  reports: string;
  placement: 'Manual override' | 'Auto-placed';
  note: string;
}

export function PersonDrawer({ person, onClose }: { person: PersonRecord; onClose: () => void }) {
  return (
    <PfDrawer
      eyebrow="Client organization"
      title={person.name}
      sub={person.title}
      onClose={onClose}
      footer={
        <>
          <GhostFooterBtn onClick={onClose}>Cancel</GhostFooterBtn>
          <PrimaryFooterBtn onClick={onClose}>Save changes</PrimaryFooterBtn>
        </>
      }
    >
      <DrawerStack>
        {/* placement card */}
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 14,
            borderRadius: 10,
            background: '#F2F4F7',
            boxShadow: 'inset 0 0 0 1.5px #101828',
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{person.level}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar initials={person.init} size={32} dark />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#101828' }}>{person.name}</span>
              <span style={{ display: 'block', fontSize: 13, color: '#475467' }}>{person.title}</span>
            </span>
          </span>
          <span style={{ fontSize: 12, color: '#667085' }}>{person.meta}</span>
        </span>

        <SubPanel title="Contact details" action={<UpperLink>Edit</UpperLink>}>
          <div style={{ marginTop: 14 }}>
            <ReadField label="Email" value={person.email} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
            <ReadField label="Phone" value={person.phone} />
            <ReadField label="Location" value={person.location} />
          </div>
        </SubPanel>

        <SubPanel title="Hierarchy placement" action={<UpperLink>Change</UpperLink>} borderTop>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
            <ReadField label="Level" value={person.levelFull} />
            <ReadField label="Reports to" value={person.reports} />
          </div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              marginTop: 12,
              padding: '0 10px 0 8px',
              borderRadius: 9999,
              background: '#F2F4F7',
              boxShadow: 'inset 0 0 0 1px #D0D5DD',
              color: '#101828',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: GRADIENT_DARK }} />
            {person.placement}
          </span>
        </SubPanel>

        <SubPanel title="Notes" borderTop>
          <p style={{ margin: '12px 0 0', padding: 14, borderRadius: 8, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0', fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
            {person.note}
          </p>
        </SubPanel>
      </DrawerStack>
    </PfDrawer>
  );
}

/* ═══════════════════════════ §12.2 Target drawer ════════════════════════════ */

export interface TargetRecord {
  kind: 'person' | 'org';
  init: string;
  name: string;
  role: string;
  disposition: string;
  dispTone: 'success' | 'warning' | 'gray' | 'brand' | 'error' | 'blue';
  confirm: string;
  strategy: string;
  ask: string;
  next: string;
  why: Array<[string, string]>;
}

export function TargetDrawer({ target, onClose }: { target: TargetRecord; onClose: () => void }) {
  return (
    <PfDrawer
      eyebrow="Government relationship"
      title={target.name}
      sub={target.role}
      onClose={onClose}
      footer={
        <>
          <GhostFooterBtn onClick={onClose}>Open Strategy</GhostFooterBtn>
          <PrimaryFooterBtn onClick={onClose}>Create brief</PrimaryFooterBtn>
        </>
      }
    >
      <DrawerStack>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200, display: 'flex', gap: 10, padding: 12, borderRadius: 10, background: '#ffffff', boxShadow: 'inset 0 0 0 1.5px #101828' }}>
            <Tile initials={target.init} size={32} dark round={target.kind === 'person'} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: GRADIENT_DARK }} />
                {target.disposition}
              </span>
              <span style={{ display: 'block', marginTop: 3, fontSize: 14, fontWeight: 600, color: '#101828' }}>{target.name}</span>
              <span style={{ display: 'block', fontSize: 13, color: '#475467' }}>{target.role}</span>
              <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: '#667085' }}>{target.confirm}</span>
            </span>
          </span>
          <Pill tone="brand" size="lg">Active strategy target</Pill>
        </div>

        <SubPanel title="Target context" action={<UpperLink>Edit</UpperLink>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
            <ReadField label="Linked strategy" value={target.strategy} />
            <ReadField label="Current ask" value={target.ask} />
            <ReadField label="Next action" value={target.next} />
          </div>
        </SubPanel>

        <SubPanel title="Why this target" borderTop>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
            {target.why.map(([label, value]) => (
              <span key={label} style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '11px 0', borderBottom: '1px solid #F2F4F7' }}>
                <span style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, width: 118, fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: GRADIENT_DARK }} />
                  {label}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828', textWrap: 'pretty' }}>{value}</span>
              </span>
            ))}
          </div>
        </SubPanel>
      </DrawerStack>
    </PfDrawer>
  );
}

/* ═══════════════════════════ §12.3 Strategy drawer ══════════════════════════ */

export interface StrategyNodeRow {
  mark: string;
  kind: string;
  title: string;
  init: string;
  date: string;
  status: string;
  tone: 'success' | 'warning' | 'gray' | 'brand' | 'error' | 'blue';
}

export function StrategyDrawer({
  nodes,
  onClose,
}: {
  nodes: StrategyNodeRow[];
  onClose: () => void;
}) {
  return (
    <PfDrawer
      eyebrow="Strategy · Appropriations"
      title="FY27 Ground Robotics Funding"
      sub="Securing the FY27 appropriation for the Ground Robotics program line through member engagement and committee positioning."
      onClose={onClose}
      footer={<PrimaryFooterBtn onClick={onClose}>Open full strategy</PrimaryFooterBtn>}
    >
      <DrawerStack>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Pill tone="brand" size="lg">Drafted with Meri</Pill>
          <Pill tone="gray" size="lg" dotless>3 live nodes</Pill>
        </div>

        <SubPanel title="Strategy metadata" action={<UpperLink>Edit</UpperLink>}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
            <ReadField label="Owner" value="Sarah Martinez" />
            <ReadField label="Target date" value="Sep 30, 2026" />
            <ReadField label="Strategy type" value="Appropriations" />
            <ReadField label="Meri context" value="FY27 defense budget · Ground Robotics" truncate />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Strategy readiness</span>
            <span style={{ flex: 1, height: 8, borderRadius: 4, background: '#F2F4F7', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: 8, width: '68%', borderRadius: 4, background: GRADIENT_DARK }} />
            </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>68%</span>
          </div>
        </SubPanel>

        <SubPanel title="Live Strategy nodes" action={<UpperLink>Open timeline</UpperLink>} borderTop>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
            {nodes.map((n) => (
              <span key={n.title} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #F2F4F7' }}>
                <span
                  style={{
                    flex: '0 0 auto',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    background: GRADIENT_DARK,
                    color: '#ffffff',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {n.mark}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{n.kind}</span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: 14, color: '#101828', textWrap: 'pretty' }}>{n.title}</span>
                </span>
                <span style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Avatar initials={n.init} size={22} />
                    <span style={{ fontSize: 13, color: '#475467' }}>{n.date}</span>
                  </span>
                  <Pill tone={n.tone}>{n.status}</Pill>
                </span>
              </span>
            ))}
          </div>
        </SubPanel>

        <div style={{ paddingTop: 20, borderTop: '1px solid #EAECF0' }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Linked context</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Pill tone="brand" size="lg">Target · Rep. Jane Doe</Pill>
            <Pill tone="gray" size="lg" dotless>Workspace · Strategy memo</Pill>
          </div>
        </div>
      </DrawerStack>
    </PfDrawer>
  );
}

/* ═══════════════════════ §12.4 Profile & source health ══════════════════════ */

export function DataHealthDrawer({
  onClose,
  onResolveGap,
}: {
  onClose: () => void;
  onResolveGap?: () => void;
}) {
  return (
    <PfDrawer
      eyebrow="Client data"
      title="Profile & source health"
      sub="What Capiro knows about this client, where it came from, and what is still missing."
      onClose={onClose}
      footer={<PrimaryFooterBtn onClick={onClose}>Sync intelligence</PrimaryFooterBtn>}
    >
      <DrawerStack>
        {/* completeness */}
        <div style={{ padding: 20, borderRadius: 12, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 36, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828', lineHeight: 1.1 }}>92%</span>
            <span style={{ flex: 1 }} />
            <Pill tone="warning" size="lg">1 setup gap</Pill>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Profile complete</div>
          <span style={{ display: 'block', marginTop: 14, height: 8, borderRadius: 4, background: '#EAECF0', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: 8, width: '92%', borderRadius: 4, background: '#12B76A' }} />
          </span>
        </div>

        <SubPanel title="Connected sources" action={<UpperLink>Sync all</UpperLink>}>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
            {SOURCES.map((src) => (
              <span key={src.label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #F2F4F7' }}>
                <span style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: src.ui === 'warning' ? '#F79009' : '#12B76A' }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828' }}>{src.label}</span>
                <Pill tone={src.ui === 'warning' ? 'warning' : 'success'}>{src.status}</Pill>
                <span style={{ flex: '0 0 auto', width: 112, fontSize: 13, color: '#667085', textAlign: 'right' }}>{src.note}</span>
              </span>
            ))}
          </div>
        </SubPanel>

        <SubPanel title="Open setup gap" borderTop>
          <div style={{ marginTop: 12, padding: 16, borderRadius: 10, background: '#FFFAEB', boxShadow: 'inset 0 0 0 1px #FEDF89' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ flex: '0 0 auto', marginTop: 5, width: 8, height: 8, borderRadius: '50%', background: '#F79009' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#93370D', textWrap: 'pretty' }}>Employee count missing for Arlington partner lab</div>
                <div style={{ marginTop: 4, fontSize: 13, lineHeight: '19px', color: '#B54708', textWrap: 'pretty' }}>
                  District Nexus coverage remains 92% until this facility is resolved.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button type="button" onClick={onResolveGap} style={{ fontSize: 14, fontWeight: 600, color: '#93370D' }}>
                Resolve gap →
              </button>
            </div>
          </div>
          <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
            Last sync · Aug 10, 2026 · 2:14 PM
          </div>
        </SubPanel>
      </DrawerStack>
    </PfDrawer>
  );
}

/* ═══════════════════════ §12.5 Configure hierarchy modal ════════════════════ */

export function HierarchyModal({ onClose }: { onClose: () => void }) {
  // LEVELS is an array of [name, keywords] tuples (prototype fixture).
  const rows = LEVELS as Array<[string, string]>;
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map(([name]) => [name, true])));
  return (
    <PfModal
      eyebrow="Client organization"
      title="Configure hierarchy"
      sub="Automatic title-based placement with manual overrides that always win."
      onClose={onClose}
      footerLeft={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 12px 0 10px',
            borderRadius: 9999,
            background: '#F9FAFB',
            boxShadow: 'inset 0 0 0 1px #EAECF0',
            color: '#344054',
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#12B76A' }} />
          92% mapped · 1 title needs review
        </span>
      }
      footer={
        <>
          <GhostFooterBtn onClick={onClose}>Cancel</GhostFooterBtn>
          <PrimaryFooterBtn onClick={onClose}>Save hierarchy</PrimaryFooterBtn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 12, borderTop: '1px solid #EAECF0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <ReadField label="Mode" value="Automatic from titles" />
          <ReadField label="Rule set" value="Corporate standard v3" />
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Visible levels & title keywords</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10 }}>
            {rows.map(([name, keywords]) => {
              const active = on[name] ?? true;
              return (
                <LevelToggleRow
                  key={name}
                  active={active}
                  label={name}
                  keywords={keywords}
                  onToggle={() => setOn((prev) => ({ ...prev, [name]: !active }))}
                />
              );
            })}
          </div>
        </div>
        <div style={{ paddingTop: 16, borderTop: '1px solid #EAECF0' }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Manual overrides</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, padding: '14px 16px', borderRadius: 8, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 180 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#101828' }}>Stephanie Bonk</span>
              <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085' }}>VP title → Executive leadership</span>
            </span>
            <UpperLink danger>Remove override</UpperLink>
          </div>
        </div>
      </div>
    </PfModal>
  );
}

function LevelToggleRow({ active, label, keywords, onToggle }: { active: boolean; label: string; keywords: string; onToggle: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 8, background: hover ? '#F2F4F7' : active ? '#F9FAFB' : 'transparent' }}
    >
      <span
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 5,
          background: active ? GRADIENT_DARK : '#ffffff',
          boxShadow: active ? 'none' : 'inset 0 0 0 1px #D0D5DD',
          color: '#ffffff',
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {active ? '✓' : ''}
      </span>
      <span style={{ flex: '0 0 auto', fontSize: 14, fontWeight: 500, color: active ? '#101828' : '#475467' }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#667085', textAlign: 'right' }}>{keywords}</span>
    </button>
  );
}

/* ═══════════════════════ §12.6 Move to folder modal ═════════════════════════ */

export interface FolderNode {
  label: string;
  depth: number;
  count?: number;
}

export function MoveToFolderModal({
  count,
  folders,
  onClose,
  onMove,
}: {
  count: number;
  folders: FolderNode[];
  onClose: () => void;
  onMove?: (dest: string) => void;
}) {
  const [selected, setSelected] = useState<string>(folders[1]?.label ?? folders[0]?.label ?? '');
  const [query, setQuery] = useState('');
  const shown = folders.filter((f) => f.label.toLowerCase().includes(query.toLowerCase()));
  return (
    <PfModal
      eyebrow="File organization"
      title="Move to folder"
      sub="Choose a destination. Smart links keep pointing at their original object."
      maxWidth={620}
      onClose={onClose}
      footer={
        <>
          <GhostFooterBtn onClick={onClose}>Cancel</GhostFooterBtn>
          <PrimaryFooterBtn onClick={() => onMove?.(selected)}>Move {count} item{count === 1 ? '' : 's'}</PrimaryFooterBtn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 14px', borderRadius: 8, background: '#ffffff', boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)' }}>
          <UIcon name="SearchLg" size={20} color="#667085" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search folders"
            aria-label="Search folders"
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 14, color: '#101828' }}
          />
        </div>
        <div style={{ padding: 8, borderRadius: 10, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0', maxHeight: 280, overflowY: 'auto' }}>
          {shown.map((f) => (
            <FolderRow key={f.label} folder={f} selected={selected === f.label} onSelect={() => setSelected(f.label)} />
          ))}
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Destination</div>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 8,
              height: 32,
              padding: '0 12px 0 10px',
              borderRadius: 9999,
              background: '#F2F4F7',
              boxShadow: 'inset 0 0 0 1px #D0D5DD',
              color: '#101828',
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: GRADIENT_DARK }} />
            {selected}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 16px', borderRadius: 8, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0' }}>
          <span style={{ flex: '0 0 auto', marginTop: 5, width: 6, height: 6, borderRadius: '50%', background: '#667085' }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: '19px', color: '#475467', textWrap: 'pretty' }}>
            No physical copy is created for smart-linked Strategy, meeting, or Outreach artifacts.
          </span>
        </div>
      </div>
    </PfModal>
  );
}

function FolderRow({ folder, selected, onSelect }: { folder: FolderNode; selected: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  const indent = 12 + folder.depth * 16;
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 8,
        padding: `9px 12px 9px ${indent}px`,
        borderRadius: 8,
        background: selected ? '#F2F4F7' : hover ? '#F2F4F7' : 'transparent',
        marginBottom: 2,
      }}
    >
      <span style={{ flex: '0 0 auto', width: 12, fontSize: 11, color: '#98A2B3' }}>{folder.count != null ? '▾' : '·'}</span>
      <span style={{ flex: '0 0 auto', width: 18, height: 14, borderRadius: 3, background: selected ? GRADIENT_DARK : '#D0D5DD' }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: selected ? 600 : 400, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {folder.label}
      </span>
    </button>
  );
}
