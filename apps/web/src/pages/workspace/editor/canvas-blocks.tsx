/**
 * Document-canvas chrome (ported from the prototype, asset_14): Letterhead,
 * image/logo placeholders, and a sample budget table for inserted Table blocks.
 */
import type { WsLetterhead } from '../types.js';
import { Icon } from '../kit.js';

/** Firm letterhead bar at the top of the paper. */
export function Letterhead({
  letterhead,
  firmName,
  firmAddr,
  onToast,
}: {
  letterhead?: WsLetterhead;
  firmName: string;
  firmAddr: string;
  onToast: (msg: string) => void;
}) {
  const lh = letterhead;
  const name = lh?.custom && lh.firmName ? lh.firmName : firmName;
  const addr = lh?.custom && lh.firmAddr ? lh.firmAddr : firmAddr;
  const mark = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '16px 30px',
        borderBottom: '2px solid var(--ink-1)',
        background: 'var(--bg-surface)',
      }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 7,
          background: 'var(--ink-1)',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-serif)',
          fontSize: 16,
          fontWeight: 600,
          flex: 'none',
        }}
      >
        {mark}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: '-0.01em',
          }}
        >
          {name}
        </div>
        <div style={{ fontSize: 9.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
          {addr}
        </div>
      </div>
      {lh?.custom && (
        <span className="pill info" style={{ flex: 'none' }}>
          Custom letterhead
        </span>
      )}
      <button
        className="btn sm btn-ghost"
        style={{ color: 'var(--ink-4)', fontSize: 11 }}
        onClick={() => onToast('Letterhead is set in Setup — edit it there')}
      >
        <Icon name="Pencil" size={11} />
        Letterhead
      </button>
    </div>
  );
}

export function ImagePlaceholder({ label, h = 140, w }: { label: string; h?: number; w?: number }) {
  return (
    <div
      style={{
        width: w || '100%',
        height: h,
        borderRadius: 8,
        border: '1px solid var(--border-1)',
        background:
          'repeating-linear-gradient(135deg, var(--bg-surface-2) 0 10px, var(--bg-sunken) 10px 20px)',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--ink-3)',
          letterSpacing: '0.04em',
          background: 'var(--bg-surface)',
          padding: '4px 9px',
          borderRadius: 5,
          border: '1px solid var(--border-1)',
        }}
      >
        <Icon name="Upload" size={12} />
        {label}
      </span>
    </div>
  );
}

export function SampleTable() {
  const rows = [
    ['FY25 enacted', '$6.0M'],
    ['FY26 enacted', '$8.0M'],
    ['FY27 PB', '$8.0M'],
    ['FY27 request', '$18.0M'],
  ];
  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 12,
        border: '1px solid var(--border-1)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <thead>
        <tr style={{ background: 'var(--bg-surface-2)' }}>
          <th
            style={{
              textAlign: 'left',
              padding: '7px 11px',
              fontWeight: 600,
              borderBottom: '1px solid var(--border-1)',
            }}
          >
            Fiscal line
          </th>
          <th
            style={{
              textAlign: 'right',
              padding: '7px 11px',
              fontWeight: 600,
              borderBottom: '1px solid var(--border-1)',
            }}
          >
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r[0]}>
            <td
              style={{ padding: '7px 11px', borderTop: i ? '1px solid var(--border-1)' : 'none' }}
            >
              {r[0]}
            </td>
            <td
              className="num"
              style={{
                padding: '7px 11px',
                textAlign: 'right',
                borderTop: i ? '1px solid var(--border-1)' : 'none',
                fontWeight: 600,
              }}
            >
              {r[1]}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Render a removable inserted block (photo / logo / table). `variant`
 * distinguishes a platform-pulled table from a custom one (set by the
 * TableTypePicker; both currently render the same exhibit, platform labeled). */
export function InsertedBlock({
  kind,
  variant,
  onRemove,
}: {
  kind: string;
  variant?: string;
  onRemove: () => void;
}) {
  const isTable = kind === 'table' || kind === 'table-platform' || kind === 'table-custom';
  const isPlatform = variant === 'platform' || kind === 'table-platform';
  return (
    <div style={{ position: 'relative', marginTop: 14 }}>
      <button
        onClick={onRemove}
        title="Remove"
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          zIndex: 2,
          width: 22,
          height: 22,
          borderRadius: 6,
          border: '1px solid var(--border-1)',
          background: 'var(--bg-surface)',
          cursor: 'pointer',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-3)',
        }}
      >
        <Icon name="X" size={12} />
      </button>
      {(kind === 'image' || kind === 'photo') && (
        <ImagePlaceholder label="PHOTO / FIGURE" h={150} />
      )}
      {kind === 'logo' && <ImagePlaceholder label="LOGO" h={84} w={150} />}
      {isTable && (
        <>
          {isPlatform && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                marginBottom: 6,
              }}
            >
              <Icon name="Database" size={11} />
              Pulled from platform
            </div>
          )}
          <SampleTable />
        </>
      )}
    </div>
  );
}
