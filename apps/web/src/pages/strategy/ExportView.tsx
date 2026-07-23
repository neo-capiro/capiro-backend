/*
 * Export overlay (EXP-1..5) — ported from the prototype sp-app ExportView.
 * Renders a branded, static-header preview sheet (a second StrategyTimeline
 * instance with `staticHeader` + optional `crop`) that IS the capture target, so
 * the preview matches the downloaded asset (EXP-5). PNG via html2canvas@2x, PDF
 * via jsPDF (one wide page). Both libs are BUNDLED deps, DYNAMICALLY imported so
 * they land in a lazy chunk (D16 + pitfall #12: no CDN, keep the route light).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { Icon, iconBtn } from './strategy-ui.js';
import { StrategyTimeline } from './StrategyTimeline.js';
import { NODE_KIND_META, STRATEGY_TYPE_LABEL } from './constants.js';
import type { FiscalCalendar } from './fiscal.js';
import type { FirmPhase, ReferenceRow, StrategyDetail } from './types.js';

/** slugify a strategy title for the download filename (D16). */
function slug(title: string): string {
  const s = (title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'strategy-timeline';
}

function triggerDownload(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function ExportView({
  strategy,
  clientName,
  calendar,
  layers,
  congress,
  ppbeLanes,
  ppbeCurrentPhases,
  firmPhases,
  onClose,
}: {
  strategy: StrategyDetail;
  clientName: string;
  calendar: FiscalCalendar;
  layers: { ppbe: boolean; congress: boolean };
  congress: ReferenceRow[];
  ppbeLanes: ReferenceRow[];
  ppbeCurrentPhases: ReferenceRow[];
  firmPhases: FirmPhase[];
  onClose: () => void;
}) {
  const quarters = calendar.quarters;
  const lastQ = quarters.length - 1;
  const curQ = Math.max(0, Math.min(lastQ, Math.floor(calendar.todayQ)));

  const [scope, setScope] = useState<'entire' | 'range'>('range');
  const [fromQ, setFromQ] = useState(curQ);
  const [toQ, setToQ] = useState(Math.min(lastQ, curQ + 2));
  const [fmt, setFmt] = useState<'png' | 'pdf'>('png');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [scale, setScale] = useState(1);

  const sheetRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const crop = scope === 'range' ? { fromM: fromQ * 3, toM: (toQ + 1) * 3 } : null;

  // Fit the natural-width sheet into the available preview frame (preview only;
  // reset to 'none' during capture).
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const frame = frameRef.current;
    if (!sheet || !frame) return;
    const natural = sheet.scrollWidth;
    const avail = frame.clientWidth - 4;
    setScale(natural > avail ? Math.max(0.25, avail / natural) : 1);
  }, [scope, fromQ, toQ, layers.ppbe, layers.congress]);

  const rangeLabel =
    scope === 'range'
      ? `${quarters[fromQ]!.fy} ${quarters[fromQ]!.q} – ${quarters[toQ]!.fy} ${quarters[toQ]!.q}`
      : null;
  const generated = calendar.now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  async function capture() {
    const el = sheetRef.current!;
    const html2canvas = (await import('html2canvas')).default;
    const prev = el.style.transform;
    el.style.transform = 'none';
    // Fonts (Hanken Grotesk / JetBrains Mono) load async — wait so metrics don't
    // fall back to a system font mid-capture.
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      return await html2canvas(el, {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
        windowWidth: el.scrollWidth + 80,
      });
    } finally {
      el.style.transform = prev;
    }
  }

  async function download() {
    setBusy(true);
    setErr(false);
    try {
      const canvas = await capture();
      const filename = slug(strategy.title);
      if (fmt === 'png') {
        triggerDownload(canvas.toDataURL('image/png'), `${filename}.png`);
      } else {
        const { jsPDF } = await import('jspdf');
        const w = canvas.width * 0.5;
        const h = canvas.height * 0.5;
        const pdf = new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h] });
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, w, h);
        pdf.save(`${filename}.pdf`);
      }
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  const seg = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '8px 12px',
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
    fontFamily: 'var(--font-sans)',
    background: active ? 'var(--bg-surface)' : 'transparent',
    color: active ? 'var(--ink-1)' : 'var(--ink-3)',
    boxShadow: active ? '0 1px 3px rgba(12,26,56,0.12)' : 'none',
  });
  const segWrap: React.CSSProperties = {
    display: 'flex',
    gap: 4,
    background: 'var(--bg-sunken)',
    borderRadius: 10,
    padding: 4,
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(12,26,56,0.5)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* EXP-1 dark header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '16px 24px',
          background: 'var(--bg-dark)',
          color: 'var(--ink-on-dark)',
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: 'var(--accent)',
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
          }}
        >
          <Icon name="upload" size={17} color="#fff" />
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>Export timeline</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-on-dark-2)' }}>
            Download a shareable, full-resolution asset of the plan.
          </div>
        </div>
        <button onClick={onClose} style={{ ...iconBtn }} aria-label="Close export">
          <Icon name="x" size={18} color="var(--ink-on-dark-2)" />
        </button>
      </div>

      {/* body: control card + preview */}
      <div style={{ flex: 1, display: 'flex', gap: 24, padding: 24, overflow: 'auto', minHeight: 0 }}>
        {/* control card */}
        <div
          style={{
            width: 320,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-1)',
            borderRadius: 14,
            padding: 20,
            alignSelf: 'flex-start',
          }}
        >
          <div>
            <span style={fieldLabel}>What to export</span>
            <div style={segWrap}>
              <button style={seg(scope === 'entire')} onClick={() => setScope('entire')}>
                Entire timeline
              </button>
              <button style={seg(scope === 'range')} onClick={() => setScope('range')}>
                Date range
              </button>
            </div>
          </div>

          {scope === 'range' && (
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <span style={fieldLabel}>From</span>
                <select
                  value={fromQ}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setFromQ(v);
                    if (v > toQ) setToQ(v);
                  }}
                  style={selectStyle}
                >
                  {quarters.map((q, i) => (
                    <option key={i} value={i}>
                      {q.fy} {q.q}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <span style={fieldLabel}>To</span>
                <select
                  value={toQ}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setToQ(v);
                    if (v < fromQ) setFromQ(v);
                  }}
                  style={selectStyle}
                >
                  {quarters.map((q, i) => (
                    <option key={i} value={i}>
                      {q.fy} {q.q}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div>
            <span style={fieldLabel}>Format</span>
            <div style={segWrap}>
              <button style={seg(fmt === 'png')} onClick={() => setFmt('png')}>
                PNG image
              </button>
              <button style={seg(fmt === 'pdf')} onClick={() => setFmt('pdf')}>
                PDF document
              </button>
            </div>
          </div>

          <button
            onClick={download}
            disabled={busy}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '11px 16px',
              borderRadius: 10,
              border: 'none',
              background: busy ? 'var(--ink-3)' : 'var(--accent)',
              color: '#fff',
              fontSize: 'var(--text-base)',
              fontWeight: 700,
              fontFamily: 'var(--font-sans)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            <Icon name="download" size={15} color="#fff" />
            {busy ? 'Preparing…' : `Download ${fmt.toUpperCase()}`}
          </button>

          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', lineHeight: 1.5 }}>
            {scope === 'range'
              ? `Exports ${rangeLabel} at full resolution (${fmt === 'png' ? '2× PNG' : 'print-ready PDF'}).`
              : `Exports the full three-fiscal-year window (${fmt === 'png' ? '2× PNG' : 'print-ready PDF'}).`}
          </div>
          {err && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--critical)', fontWeight: 600, lineHeight: 1.5 }}>
              Couldn't generate the file — check your connection and try again.
            </div>
          )}
        </div>

        {/* preview frame */}
        <div ref={frameRef} style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
          <div
            ref={sheetRef}
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top center',
              background: '#ffffff',
              border: '1px solid var(--border-1)',
              borderRadius: 12,
              padding: 24,
              width: 'max-content',
              boxShadow: '0 12px 40px rgba(12,26,56,0.25)',
            }}
          >
            {/* EXP-5 branded header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 24,
                marginBottom: 16,
                paddingBottom: 14,
                borderBottom: '2px solid var(--border-strong)',
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-2xs)',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    color: 'var(--accent)',
                    textTransform: 'uppercase',
                    marginBottom: 4,
                  }}
                >
                  {clientName} · {STRATEGY_TYPE_LABEL[strategy.type]}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink-1)', letterSpacing: '-0.02em' }}>
                  {strategy.title}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      display: 'grid',
                      placeItems: 'center',
                    }}
                  >
                    <Icon name="star" size={13} color="#fff" />
                  </span>
                  <span style={{ fontSize: 'var(--text-base)', fontWeight: 800, color: 'var(--ink-1)' }}>Capiro</span>
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
                  Strategy timeline · Generated {generated}
                </div>
                {rangeLabel && (
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
                    Range · {rangeLabel}
                  </div>
                )}
              </div>
            </div>

            {/* step-type legend */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
              {(Object.keys(NODE_KIND_META) as Array<keyof typeof NODE_KIND_META>).map((k) => (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      background: NODE_KIND_META[k].color,
                      color: '#fff',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 10,
                      fontWeight: 800,
                    }}
                  >
                    {NODE_KIND_META[k].letter}
                  </span>
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-2)', fontWeight: 600 }}>
                    {NODE_KIND_META[k].label}
                  </span>
                </span>
              ))}
            </div>

            {/* the cropped, static-header timeline — the capture target */}
            <StrategyTimeline
              calendar={calendar}
              nodes={strategy.nodes}
              congress={congress}
              ppbeLanes={ppbeLanes}
              ppbeCurrentPhases={ppbeCurrentPhases}
              firmPhases={firmPhases}
              layers={layers}
              selectedId={null}
              onSelectNode={() => {}}
              staticHeader
              crop={crop}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = {
  fontSize: 'var(--text-2xs)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--ink-4)',
  marginBottom: 6,
  display: 'block',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid var(--border-2)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink-1)',
  background: 'var(--bg-surface)',
  boxSizing: 'border-box',
};
