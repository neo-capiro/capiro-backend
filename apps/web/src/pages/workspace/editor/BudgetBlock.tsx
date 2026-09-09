/**
 * Budget block (ported from the prototype `BudgetBlock`, asset_14). Renders the
 * auto-populated budget identifiers (Account / PE / BA / R-1 / UPL), the funding
 * history pills, and the human-set ask (Amount / PB / Delta) which writes
 * `cfg.ask`.
 *
 * Data source (binding decision): the structured R-1/UPL validation pipeline is
 * not wired yet, so identifiers are read from optional `cfg.budget` fields when
 * present and otherwise fall back to an explicit unknown ("—"). Funding-history
 * pills only render values that are actually present on the draft (ask or
 * optional `cfg.budget.fundingHistory`); they never invent FY amounts.
 *
 * F04: never claim "Auto-populated … N of M validated" unless real identifier
 * values are present. A blank scaffold must look blank, not validated.
 */
import type { WsAsk, WsConfig } from '../types.js';
import { Icon } from '../kit.js';

export interface BudgetIdentifiers {
  account?: string;
  pe?: string;
  ba?: string;
  r1?: string;
  upl?: string;
  /**
   * Optional prior-year / structured funding lines when a real source has
   * populated them. Absent or empty means "unknown" — never prototype defaults.
   */
  fundingHistory?: Array<{ label: string; value: string }>;
}

interface FundRow {
  y: string;
  v: string;
  known: boolean;
}

const ID_FIELDS: Array<[string, keyof BudgetIdentifiers]> = [
  ['Account', 'account'],
  ['Program element (PE)', 'pe'],
  ['Budget activity', 'ba'],
  ['R-1 line item', 'r1'],
  ['UPL / UFR listing', 'upl'],
];

/** True when a string carries a real operator-visible value (not blank/placeholder). */
export function hasBudgetValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (!t) return false;
  // Common empty placeholders that must not count as populated data.
  if (t === '—' || t === '-' || t === '–' || t === 'n/a' || t === 'N/A') return false;
  return true;
}

/** Count of the five structured identifier fields that actually have values. */
export function countPopulatedIdentifiers(budget?: BudgetIdentifiers | null): number {
  const b = budget ?? {};
  return (['account', 'pe', 'ba', 'r1', 'upl'] as const).filter((k) =>
    hasBudgetValue(b[k]),
  ).length;
}

export interface BudgetProvenanceSummary {
  /** How many of the five identifier slots have real values. */
  populated: number;
  total: number;
  /** True when any identifier is populated (auto-populate claim is allowed). */
  hasAnyIdentifier: boolean;
  /**
   * Operator-facing status line. Never claims R-1/UPL validation when zero
   * identifiers are present.
   */
  statusText: string;
  /** Short label for the section pill (Auto-populated vs Needs data). */
  pillLabel: 'Auto-populated' | 'Needs data';
}

/**
 * Build the honest provenance line for the budget block header.
 * Live F04 artifact had empty Account/PE/BA/R-1/UPL + empty ask, yet the UI
 * hard-coded "Auto-populated from FY27 R-1 & Navy UPL, 5 of 6 validated".
 */
export function describeBudgetProvenance(
  budget?: BudgetIdentifiers | null,
): BudgetProvenanceSummary {
  const populated = countPopulatedIdentifiers(budget);
  const total = 5;
  if (populated === 0) {
    return {
      populated,
      total,
      hasAnyIdentifier: false,
      statusText:
        'Funding identifiers not yet linked — Account, PE, Budget activity, R-1, and UPL are unknown until a real source is attached',
      pillLabel: 'Needs data',
    };
  }
  return {
    populated,
    total,
    hasAnyIdentifier: true,
    statusText: `Populated from draft budget data · ${populated} of ${total} identifiers present`,
    pillLabel: 'Auto-populated',
  };
}

/**
 * Funding-history rows shown above The ask.
 * Only includes lines with real values. Never invents FY25/FY26/FY27/Request
 * dollar amounts (those were prototype placeholders that contradicted a $14M
 * plus-up step note on the live July artifact).
 */
export function fundingHistoryRows(
  ask: WsAsk,
  budget?: BudgetIdentifiers | null,
): FundRow[] {
  const rows: FundRow[] = [];
  const history = budget?.fundingHistory ?? [];
  for (const row of history) {
    if (hasBudgetValue(row?.label) && hasBudgetValue(row?.value)) {
      rows.push({ y: row.label.trim(), v: row.value.trim(), known: true });
    }
  }
  if (hasBudgetValue(ask?.pb)) {
    rows.push({ y: 'FY PB', v: String(ask.pb).trim(), known: true });
  }
  if (hasBudgetValue(ask?.amount)) {
    rows.push({ y: 'Request', v: String(ask.amount).trim(), known: true });
  }
  if (hasBudgetValue(ask?.delta)) {
    rows.push({ y: 'Delta', v: String(ask.delta).trim(), known: true });
  }
  return rows;
}

export function BudgetBlock({
  ask,
  budget,
  onAsk,
  onToast,
}: {
  ask: WsAsk;
  budget?: BudgetIdentifiers;
  onAsk: (key: keyof WsAsk, value: string) => void;
  onToast: (msg: string) => void;
}) {
  const b = budget ?? {};
  const provenance = describeBudgetProvenance(b);
  const ids: Array<[string, string, boolean]> = ID_FIELDS.map(([label, key]) => {
    const raw = b[key];
    const known = hasBudgetValue(raw);
    return [label, known ? String(raw).trim() : '—', known];
  });

  const fund = fundingHistoryRows(ask, b);
  const hasFund = fund.length > 0;

  return (
    <div className="card" style={{ padding: 13, boxShadow: 'none', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
        <Icon
          name={provenance.hasAnyIdentifier ? 'Sparkles' : 'AlertTriangle'}
          size={13}
          style={{ color: provenance.hasAnyIdentifier ? 'var(--accent)' : 'var(--ink-3)' }}
        />
        <span style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{provenance.statusText}</span>
        <a
          onClick={() =>
            onToast(
              provenance.hasAnyIdentifier
                ? 'Re-sync: live R-1 / UPL validation arrives in a later phase'
                : 'No linked R-1 / UPL source yet — identifiers stay unknown until budget data is attached',
            )
          }
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: 'var(--accent)',
            fontWeight: 600,
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          Re-sync
        </a>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
        {ids.map((r, i) => (
          <div
            key={r[0]}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              padding: '6px 0',
              borderTop: i > 1 ? '1px solid var(--border-1)' : 'none',
            }}
          >
            <span style={{ color: 'var(--ink-3)', flex: 1 }}>{r[0]}</span>
            <span
              className="num"
              style={{
                fontWeight: 600,
                color: r[2] ? 'var(--ink-1)' : 'var(--ink-4)',
              }}
            >
              {r[1]}
            </span>
            {/* Green success dots only when the field actually has a value. */}
            <span
              className={r[2] ? 'dot success' : 'dot'}
              title={r[2] ? 'Present on draft' : 'Unknown — not linked'}
              style={r[2] ? undefined : { opacity: 0.35 }}
            />
          </div>
        ))}
      </div>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 11 }}
      >
        {hasFund ? (
          fund.map((f, i) => (
            <span
              key={`${f.y}-${i}`}
              className="num"
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 6,
                border: '1px solid var(--border-1)',
                background: f.y === 'Request' ? 'var(--accent-soft)' : 'var(--bg-surface-2)',
                color: f.y === 'Request' ? 'var(--accent-ink)' : 'var(--ink-2)',
                fontWeight: f.y === 'Request' ? 600 : 400,
              }}
            >
              {f.y} {f.v}
            </span>
          ))
        ) : (
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            No funding history on this draft yet. Prior-year enacted lines and request amounts stay
            blank until set on The ask or linked from budget data — they are not estimated.
          </span>
        )}
      </div>

      {/* Human-set ask — primary entry point. Writes cfg.ask. */}
      <div style={{ marginTop: 13, paddingTop: 12, borderTop: '1px solid var(--border-1)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--ink-2)',
            marginBottom: 10,
          }}
        >
          <Icon name="Lock" size={12} style={{ color: 'var(--ink-4)' }} />
          The ask
          <span style={{ fontWeight: 400, color: 'var(--ink-3)' }}>
            — set by you, lobbyist sign-off required
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {(
            [
              ['Amount', 'amount'],
              ['PB', 'pb'],
              ['Delta', 'delta'],
            ] as Array<[string, keyof WsAsk]>
          ).map(([label, key]) => (
            <div key={key}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'var(--ink-3)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 5,
                }}
              >
                {label}
              </div>
              <input
                value={ask[key] || ''}
                onChange={(e) => onAsk(key, e.target.value)}
                placeholder="—"
                className="field num"
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  fontSize: 13,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  background: 'var(--bg-surface)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Resolve budget identifiers from the config (optional structured field). */
export function budgetFrom(cfg: WsConfig): BudgetIdentifiers {
  const raw = (cfg.budget as BudgetIdentifiers | undefined) ?? {};
  return {
    account: raw.account,
    pe: raw.pe,
    ba: raw.ba,
    r1: raw.r1,
    upl: raw.upl,
    fundingHistory: Array.isArray(raw.fundingHistory) ? raw.fundingHistory : undefined,
  };
}
