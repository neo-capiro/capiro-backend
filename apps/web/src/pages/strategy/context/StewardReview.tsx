/*
 * Stage E Steward review (/strategies/context/steward) — the human review
 * surface over the Context Steward's extracted facts (sp_context_fact) and
 * detected disagreements (sp_context_conflict). Three blocks: a per-client
 * health strip (GET /context/health), the conflicts panel (open first, side by
 * side, Resolve-with-note / Dismiss), and the facts table (state filter chips,
 * Reject-without-editing-source on active facts). A ?fact=<id> deep-link (from
 * the NodeRail 'Grounded in' fact chips) highlights + scrolls to that row,
 * auto-switching to its state filter when needed. Gated by /me
 * features.agenticMeri (route-level in StrategyRoutes) — the Steward never
 * mutates strategy nodes, so nothing here touches a plan.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { App } from 'antd';
import { Chip, Icon, Overlay, btnGhost, btnPrimary, chipBtn, iconBtn, lbl } from '../strategy-ui.js';
import {
  useContextConflicts,
  useContextFacts,
  useContextHealth,
  useDismissContextConflict,
  useResolveContextConflict,
  useRejectContextFact,
} from '../api.js';
import { useClientsLite } from '../clients-lite.js';
import { errorMessage } from '../../../lib/error-message.js';
import { templateLabel } from './context-utils.js';
import type {
  ContextConflict,
  ContextConflictFact,
  ContextFact,
  ContextFactState,
} from '../types.js';

const FACT_STATES: readonly ContextFactState[] = ['active', 'stale', 'superseded', 'rejected'];

const FACT_STATE_TONE: Record<ContextFactState, 'success' | 'notable' | 'ink' | 'critical'> = {
  active: 'success',
  stale: 'notable',
  superseded: 'ink',
  rejected: 'critical',
};

const selS: React.CSSProperties = {
  border: '1px solid var(--border-2)',
  borderRadius: 8,
  padding: '7px 11px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink-1)',
  background: 'var(--bg-surface)',
  cursor: 'pointer',
};

const emptyBox: React.CSSProperties = {
  padding: 24,
  textAlign: 'center',
  fontSize: 'var(--text-sm)',
  color: 'var(--ink-3)',
  border: '1px dashed var(--border-2)',
  borderRadius: 12,
};

const sectionHead: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  color: 'var(--ink-1)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const thS: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 'var(--text-2xs)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--ink-4)',
  padding: '8px 10px',
  borderBottom: '1px solid var(--border-1)',
  whiteSpace: 'nowrap',
};

const tdS: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--ink-2)',
  padding: '9px 10px',
  borderBottom: '1px solid var(--border-1)',
  verticalAlign: 'top',
};

export function StewardReview() {
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [searchParams] = useSearchParams();
  const facts = useContextFacts();
  const conflicts = useContextConflicts();
  const clients = useClientsLite();
  const reject = useRejectContextFact();
  const dismiss = useDismissContextConflict();

  const [fc, setFc] = useState('all'); // 'all' | 'firm' | clientId
  const [stateFilter, setStateFilter] = useState<ContextFactState>('active');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<ContextConflict | null>(null);

  const health = useContextHealth(fc !== 'all' && fc !== 'firm' ? fc : null);
  const highlightRowRef = useRef<HTMLTableRowElement | null>(null);

  const clientName = (id: string | null) =>
    id === null ? 'Firm-wide' : (clients.data?.find((c) => c.id === id)?.name ?? 'Client');

  // ?fact=<id> deep-link (NodeRail 'Grounded in' chips): once the facts land,
  // highlight the row and — if it is not in the current state filter —
  // auto-switch to its state. Consumed once per param value so a later manual
  // filter change is not fought.
  const consumedFactParam = useRef<string | null>(null);
  useEffect(() => {
    const p = searchParams.get('fact');
    if (!p || !facts.data || consumedFactParam.current === p) return;
    consumedFactParam.current = p;
    const hit = facts.data.find((f) => f.id === p);
    if (!hit) {
      message.warning('That fact could not be found — it may have been removed.');
      return;
    }
    setHighlightId(hit.id);
    setStateFilter(hit.state);
    setFc('all'); // never let the client filter hide the deep-linked row
  }, [searchParams, facts.data, message]);

  // Scroll the highlighted row into view once it is actually rendered.
  useEffect(() => {
    if (highlightId) {
      highlightRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlightId, stateFilter, fc, facts.data]);

  const clientFilterOptions = useMemo(
    () => [...new Set((facts.data ?? []).map((f) => f.clientId).filter((c): c is string => !!c))],
    [facts.data],
  );
  const hasFirmFacts = (facts.data ?? []).some((f) => f.clientId === null);

  const matchesClient = (clientId: string | null) =>
    fc === 'all' || (fc === 'firm' ? clientId === null : clientId === fc);

  const stateCounts = useMemo(() => {
    const counts = { active: 0, stale: 0, superseded: 0, rejected: 0 } as Record<
      ContextFactState,
      number
    >;
    for (const f of facts.data ?? []) {
      if (matchesClient(f.clientId)) counts[f.state] += 1;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts.data, fc]);

  const visibleFacts = useMemo(
    () => (facts.data ?? []).filter((f) => f.state === stateFilter && matchesClient(f.clientId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts.data, stateFilter, fc],
  );

  // Conflicts: open first, then newest; the client filter rides the conflict's
  // derived clientId (a conflict with no client info always stays visible).
  const visibleConflicts = useMemo(() => {
    const rows = (conflicts.data ?? []).filter((c) =>
      c.clientId === null ? true : matchesClient(c.clientId),
    );
    return rows.sort(
      (a, b) =>
        (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) ||
        (a.createdAt < b.createdAt ? 1 : -1),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts.data, fc]);
  const openCount = visibleConflicts.filter((c) => c.state === 'open').length;

  const onRejectFact = (f: ContextFact) => {
    modal.confirm({
      title: 'Reject this fact?',
      content:
        `“${clipText(f.fact, 160)}” will stop grounding new drafts. The source document is not ` +
        'changed — re-extract after correcting it to bring a fixed version back.',
      okText: 'Reject fact',
      okButtonProps: { danger: true },
      onOk: () =>
        new Promise<void>((resolve, rejectP) => {
          reject.mutate(f.id, {
            onSuccess: () => {
              message.success('Fact rejected.');
              resolve();
            },
            onError: (err) => {
              message.error(errorMessage(err, 'Could not reject the fact.'));
              rejectP(new Error('reject failed'));
            },
          });
        }),
    });
  };

  const onDismissConflict = (c: ContextConflict) => {
    modal.confirm({
      title: 'Dismiss this conflict?',
      content:
        'Both facts stay active and neither is marked controlling — dismiss only when the two ' +
        'statements do not actually disagree.',
      okText: 'Dismiss',
      onOk: () =>
        new Promise<void>((resolve, rejectP) => {
          dismiss.mutate(c.id, {
            onSuccess: () => {
              message.success('Conflict dismissed.');
              resolve();
            },
            onError: (err) => {
              message.error(errorMessage(err, 'Could not dismiss the conflict.'));
              rejectP(new Error('dismiss failed'));
            },
          });
        }),
    });
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-canvas)', height: '100%' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 40px 60px' }}>
        <button
          onClick={() => navigate('/strategies/context')}
          style={{ ...btnGhost, marginBottom: 14 }}
        >
          <Icon name="chevleft" size={14} color="var(--ink-2)" /> Context library
        </button>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <h1
              style={{
                fontSize: 'var(--text-xl)',
                fontWeight: 700,
                color: 'var(--ink-1)',
                letterSpacing: '-0.02em',
                margin: 0,
              }}
            >
              Steward review
            </h1>
            <p
              style={{
                fontSize: 'var(--text-md)',
                color: 'var(--ink-2)',
                marginTop: 4,
                maxWidth: 680,
              }}
            >
              Facts the Context Steward extracted from your context documents, with every
              disagreement it detected. Resolving a conflict or rejecting a fact never edits a
              source document — and the Steward never touches a strategy.
            </p>
          </div>
          <select value={fc} onChange={(e) => setFc(e.target.value)} style={selS}>
            <option value="all">All clients</option>
            {hasFirmFacts && <option value="firm">Firm-wide</option>}
            {clientFilterOptions.map((c) => (
              <option key={c} value={c}>
                {clientName(c)}
              </option>
            ))}
          </select>
        </div>

        {/* ---- per-client health strip -------------------------------------- */}
        <HealthStrip
          selectedClient={fc !== 'all' && fc !== 'firm' ? fc : null}
          clientName={fc !== 'all' && fc !== 'firm' ? clientName(fc) : null}
          health={health}
        />

        {/* ---- conflicts ----------------------------------------------------- */}
        <div style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={sectionHead}>Conflicts</span>
          <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', color: 'var(--ink-4)' }}>
            {openCount} open · {visibleConflicts.length} total
          </span>
        </div>

        {conflicts.isLoading && <div style={emptyBox}>Loading conflicts…</div>}
        {!conflicts.isLoading && conflicts.isError && (
          <div style={{ ...emptyBox, color: 'var(--critical)', borderColor: 'var(--critical)' }}>
            Conflicts could not be loaded. Refresh to try again.
          </div>
        )}
        {conflicts.isSuccess && visibleConflicts.length === 0 && (
          <div style={emptyBox}>No conflicts for this filter — the context agrees with itself.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visibleConflicts.map((c) => (
            <ConflictCard
              key={c.id}
              conflict={c}
              busy={dismiss.isPending}
              onResolve={() => setResolving(c)}
              onDismiss={() => onDismissConflict(c)}
            />
          ))}
        </div>

        {/* ---- facts ---------------------------------------------------------- */}
        <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={sectionHead}>Facts</span>
          <span style={{ flex: 1 }} />
          {FACT_STATES.map((s) => {
            const on = stateFilter === s;
            return (
              <button
                key={s}
                onClick={() => setStateFilter(s)}
                style={{
                  ...chipBtn,
                  border: on ? '1px solid var(--accent)' : '1px solid var(--border-2)',
                  background: on ? 'var(--accent-soft)' : 'var(--bg-surface)',
                  color: on ? 'var(--accent-ink)' : 'var(--ink-2)',
                  fontWeight: on ? 700 : 600,
                }}
              >
                {s} · {stateCounts[s]}
              </button>
            );
          })}
        </div>

        {facts.isLoading && <div style={emptyBox}>Loading facts…</div>}
        {!facts.isLoading && facts.isError && (
          <div style={{ ...emptyBox, color: 'var(--critical)', borderColor: 'var(--critical)' }}>
            The fact ledger could not be loaded — you may not have access, or the request failed.
          </div>
        )}
        {facts.isSuccess && visibleFacts.length === 0 && (
          <div style={emptyBox}>
            {(facts.data?.length ?? 0) > 0
              ? `No ${stateFilter} facts match this filter.`
              : 'No facts yet — open a context document and run Extract facts.'}
          </div>
        )}

        {visibleFacts.length > 0 && (
          <div
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-1)',
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thS}>Fact</th>
                  <th style={thS}>Source doc</th>
                  <th style={thS}>Source ref</th>
                  <th style={thS}>Authority</th>
                  <th style={thS}>As of</th>
                  <th style={thS}>Conf.</th>
                  <th style={thS} />
                </tr>
              </thead>
              <tbody>
                {visibleFacts.map((f) => {
                  const highlighted = f.id === highlightId;
                  return (
                    <tr
                      key={f.id}
                      ref={highlighted ? highlightRowRef : undefined}
                      style={{ background: highlighted ? 'var(--accent-soft)' : 'transparent' }}
                    >
                      <td style={{ ...tdS, color: 'var(--ink-1)', minWidth: 260 }}>
                        {f.fact}
                        {f.citation && (
                          <div
                            style={{
                              marginTop: 4,
                              fontSize: 'var(--text-2xs)',
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--ink-4)',
                            }}
                          >
                            “{clipText(f.citation, 140)}”
                          </div>
                        )}
                      </td>
                      <td style={tdS}>
                        <button
                          onClick={() => f.documentId && navigate(`/strategies/context/${f.documentId}`)}
                          title="Open the source document"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            padding: 0,
                            cursor: f.documentId ? 'pointer' : 'default',
                            fontSize: 'var(--text-xs)',
                            fontFamily: 'var(--font-sans)',
                            color: 'var(--accent-ink)',
                            fontWeight: 600,
                            textAlign: 'left',
                          }}
                        >
                          {f.documentTitle ??
                            (f.templateKey ? templateLabel(f.templateKey) : 'Document')}
                        </button>
                        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 2 }}>
                          {clientName(f.clientId)}
                        </div>
                      </td>
                      <td style={{ ...tdS, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)' }}>
                        {f.sourceRef || '—'}
                      </td>
                      <td style={tdS}>{f.authority ? f.authority.replace(/_/g, ' ') : 'unattributed'}</td>
                      <td style={{ ...tdS, whiteSpace: 'nowrap' }}>
                        {f.asOf ? f.asOf.slice(0, 10) : 'undated'}
                      </td>
                      <td style={{ ...tdS, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                        {f.confidence !== null ? `${Math.round(f.confidence * 100)}%` : '—'}
                      </td>
                      <td style={{ ...tdS, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {f.state === 'active' ? (
                          <button
                            onClick={() => onRejectFact(f)}
                            disabled={reject.isPending}
                            style={{
                              ...chipBtn,
                              color: 'var(--critical)',
                              borderColor: 'var(--critical)',
                            }}
                          >
                            Reject
                          </button>
                        ) : (
                          <Chip tone={FACT_STATE_TONE[f.state]}>{f.state}</Chip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {resolving && (
        <ResolveConflictModal
          conflict={resolving}
          onClose={() => setResolving(null)}
          onResolved={() => {
            setResolving(null);
            message.success('Conflict resolved.');
          }}
        />
      )}
    </div>
  );
}

function clipText(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Per-client health strip: status pill + missing required templates + stale-doc count. */
function HealthStrip({
  selectedClient,
  clientName,
  health,
}: {
  selectedClient: string | null;
  clientName: string | null;
  health: ReturnType<typeof useContextHealth>;
}) {
  if (!selectedClient) {
    return (
      <div
        style={{
          marginTop: 18,
          padding: '10px 15px',
          border: '1px dashed var(--border-2)',
          borderRadius: 10,
          fontSize: 'var(--text-sm)',
          color: 'var(--ink-3)',
        }}
      >
        Pick a client above to see its context health (required templates, staleness, conflicts).
      </div>
    );
  }

  const box: React.CSSProperties = {
    marginTop: 18,
    padding: '11px 15px',
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    fontSize: 'var(--text-sm)',
    border: '1px solid var(--border-1)',
    background: 'var(--bg-surface)',
  };

  if (health.isLoading) {
    return <div style={{ ...box, color: 'var(--ink-3)' }}>Checking context health for {clientName}…</div>;
  }
  if (health.isError || !health.data) {
    return (
      <div style={{ ...box, color: 'var(--critical)', borderColor: 'var(--critical)' }}>
        Context health for {clientName} could not be loaded.
      </div>
    );
  }

  const h = health.data;
  const tone = h.status === 'ok' ? 'success' : h.status === 'degraded' ? 'notable' : 'critical';
  return (
    <div style={box}>
      <Chip tone={tone}>{h.status}</Chip>
      <span style={{ fontWeight: 700, color: 'var(--ink-1)' }}>{clientName}</span>
      <span style={{ color: 'var(--ink-3)' }}>
        {h.missingRequired.length > 0
          ? `Missing required: ${h.missingRequired.map((t) => templateLabel(t)).join(', ')}`
          : 'All required templates present'}
      </span>
      <span style={{ color: 'var(--ink-4)' }}>·</span>
      <span style={{ color: h.staleDocuments > 0 ? 'var(--notable)' : 'var(--ink-3)' }}>
        {h.staleDocuments} stale document{h.staleDocuments === 1 ? '' : 's'}
      </span>
      {h.openMaterialConflicts.length > 0 && (
        <>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span style={{ color: 'var(--critical)', fontWeight: 600 }}>
            {h.openMaterialConflicts.length} open material conflict
            {h.openMaterialConflicts.length === 1 ? '' : 's'}
          </span>
        </>
      )}
    </div>
  );
}

function ConflictFactBox({ label, fact }: { label: string; fact: ContextConflictFact | null }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 9,
        padding: '10px 12px',
      }}
    >
      <div
        style={{
          fontSize: 'var(--text-2xs)',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--ink-4)',
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      {fact ? (
        <>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', lineHeight: 1.5 }}>
            {fact.fact}
          </div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 6 }}>
            {fact.documentTitle ?? 'Unknown document'} ·{' '}
            {fact.authority ? fact.authority.replace(/_/g, ' ') : 'unattributed'} · as of{' '}
            {fact.asOf ? fact.asOf.slice(0, 10) : 'undated'}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
          This fact is no longer available.
        </div>
      )}
    </div>
  );
}

function ConflictCard({
  conflict,
  busy,
  onResolve,
  onDismiss,
}: {
  conflict: ContextConflict;
  busy: boolean;
  onResolve: () => void;
  onDismiss: () => void;
}) {
  const c = conflict;
  const stateTone = c.state === 'open' ? (c.material ? 'critical' : 'notable') : 'ink';
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: `1px solid ${c.state === 'open' && c.material ? 'var(--critical)' : 'var(--border-1)'}`,
        borderRadius: 10,
        padding: '12px 15px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Chip tone={stateTone}>{c.state}</Chip>
        {c.material && <Chip tone="critical">Material</Chip>}
        <span style={{ flex: 1 }} />
        {c.state === 'open' && (
          <>
            <button onClick={onDismiss} disabled={busy} style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--text-xs)' }}>
              Dismiss
            </button>
            <button onClick={onResolve} disabled={busy} style={{ ...btnPrimary, padding: '6px 14px', fontSize: 'var(--text-xs)' }}>
              Resolve
            </button>
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <ConflictFactBox label="Fact A" fact={c.factA} />
        <ConflictFactBox label="Fact B" fact={c.factB} />
      </div>
      {c.state !== 'open' && c.resolutionNote && (
        <div style={{ marginTop: 9, fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
          <b style={{ color: 'var(--ink-2)' }}>Resolution:</b> {c.resolutionNote}
        </div>
      )}
    </div>
  );
}

/**
 * Resolve modal: pick the controlling fact (A/B radio) + a REQUIRED note.
 * POST /context/conflicts/:id/resolve — the losing fact is superseded server
 * side; no source document is edited.
 */
function ResolveConflictModal({
  conflict,
  onClose,
  onResolved,
}: {
  conflict: ContextConflict;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { message } = App.useApp();
  const resolve = useResolveContextConflict();
  const [pick, setPick] = useState<'A' | 'B' | null>(null);
  const [note, setNote] = useState('');

  const controllingFactId =
    pick === 'A' ? conflict.factA?.id || conflict.factAId : pick === 'B' ? conflict.factB?.id || conflict.factBId : '';
  const canSubmit = !!pick && !!controllingFactId && note.trim().length > 0 && !resolve.isPending;

  const submit = () => {
    if (!canSubmit) return;
    resolve.mutate(
      { conflictId: conflict.id, input: { controllingFactId, note: note.trim() } },
      {
        onSuccess: onResolved,
        onError: (err) => message.error(errorMessage(err, 'Could not resolve the conflict.')),
      },
    );
  };

  const option = (key: 'A' | 'B', fact: ContextConflictFact | null) => (
    <label
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        border: `1px solid ${pick === key ? 'var(--accent)' : 'var(--border-2)'}`,
        background: pick === key ? 'var(--accent-soft)' : 'var(--bg-surface)',
        borderRadius: 9,
        padding: '10px 12px',
        cursor: 'pointer',
      }}
    >
      <input
        type="radio"
        name="controlling-fact"
        checked={pick === key}
        onChange={() => setPick(key)}
        style={{ marginTop: 3 }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--ink-1)', lineHeight: 1.5 }}>
          <b>Fact {key}:</b> {fact ? fact.fact : 'This fact is no longer available.'}
        </span>
        {fact && (
          <span style={{ display: 'block', fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 4 }}>
            {fact.documentTitle ?? 'Unknown document'} ·{' '}
            {fact.authority ? fact.authority.replace(/_/g, ' ') : 'unattributed'} · as of{' '}
            {fact.asOf ? fact.asOf.slice(0, 10) : 'undated'}
          </span>
        )}
      </span>
    </label>
  );

  return (
    <Overlay onClose={resolve.isPending ? () => {} : onClose}>
      <div
        style={{
          width: 560,
          background: 'var(--bg-surface)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(12,26,56,0.28)',
        }}
      >
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 'var(--text-2xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--ink-4)',
                fontWeight: 600,
              }}
            >
              STEWARD REVIEW
            </div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--ink-1)', marginTop: 2 }}>
              Resolve this conflict
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={iconBtn} disabled={resolve.isPending}>
            <Icon name="x" size={16} color="var(--ink-3)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          <label style={lbl}>Which fact controls?</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {option('A', conflict.factA)}
            {option('B', conflict.factB)}
          </div>

          <label style={{ ...lbl, marginTop: 18 }}>
            Resolution note{' '}
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--ink-3)' }}>
              · required — why this fact controls
            </span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. The client confirmed the revised ask in the July check-in — the earlier brief is out of date."
            style={{
              width: '100%',
              border: '1px solid var(--border-2)',
              borderRadius: 9,
              padding: '9px 13px',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--ink-1)',
              background: 'var(--bg-surface)',
              boxSizing: 'border-box',
              resize: 'vertical',
              lineHeight: 1.5,
            }}
          />
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-1)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: 'var(--bg-surface-2)',
          }}
        >
          <button onClick={onClose} style={btnGhost} disabled={resolve.isPending}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            title={canSubmit ? '' : 'Pick the controlling fact and add a note first'}
            style={{
              ...btnPrimary,
              opacity: canSubmit ? 1 : 0.45,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            <Icon name="check" size={14} color="#fff" />
            {resolve.isPending ? 'Resolving…' : 'Resolve conflict'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
