import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Card,
  CardHead,
  Eyebrow,
  PfButton,
  PfEmptyState,
  PfSkeleton,
  Pill,
  PILL,
  TabPageHead,
  Tile,
  type PillTone,
} from '../portfolio-primitives.js';
import { TARGETS } from '../portfolio-fixtures.js';
import { formatDateShort, humanizeEnumToken } from '../../../lib/labels.js';
import { initialsFor } from '../../../adapters/legacy/useClientCrmOverviewModel.js';
import { useApi } from '../../../../lib/use-api.js';
import {
  addClientTarget,
  getClientTargets,
  getOfficeRecommendations,
  refreshOfficeRecommendations,
  type ClientTarget,
  type OfficeRecommendation,
  type OfficeRecommendationsResult,
  type TargetDirectory,
} from '../../../../pages/clients/targets-api.js';
import { profileHref } from '../../../../pages/clients/targets-normalize.js';
import { TargetDrawer, type TargetRecord } from '../portfolio-overlays.js';
import { AddRelationshipModal } from '../AddRelationshipModal.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import './relationships-gov-tab.css';

/**
 * Relationships / Government sub-tab (spec §8.2).
 *
 * Current targets and the relationships table bind to the real targets backend
 * (`pages/clients/targets-api.ts`) — the same `['client-targets', clientId]`
 * cache entry the canonical TargetsTab uses, so an edit in either surface is
 * seen by the other. The design's TARGETS fixture still renders while the
 * query is loading, keeping the surface pixel-reviewable (the convention this
 * file family already follows — see WorkTab §9). On a genuine fetch error the
 * panel says so honestly instead — it used to fall back to the same fixture
 * on error, which showed three invented targets under a real client's name.
 *
 * The design's second "All government relationships" table is gone: it paged
 * the same targets the Current targets panel above already lists.
 *
 * The side rail is the office recommender from app Targets ("Suggested by Meri"),
 * not the retired relationship-network card. Same query keys and mutations as
 * `TargetsTab` so add/refresh stay cache-coherent across surfaces.
 */

const DISPOSITION_TONE: Record<string, PillTone> = {
  Supportive: 'success',
  Neutral: 'gray',
  Opposed: 'error',
};

const DIRECTORY_LABEL: Record<TargetDirectory, string> = {
  congress: 'Member of Congress',
  state: 'State legislator',
  staff: 'Committee Staff',
};

const targetName = (t: ClientTarget) => t.memberName ?? t.memberId;

function targetRole(t: ClientTarget): string {
  const parts = [t.chamber, t.committee].filter(Boolean);
  return parts.length ? parts.join(' · ') : DIRECTORY_LABEL[t.sourceDirectory];
}

/** Real `ClientTarget` → the drawer's record. Only fields with a real column
 *  are supplied; the drawer omits the rest rather than inventing them. */
function toTargetRecord(t: ClientTarget): TargetRecord {
  return {
    kind: 'person',
    init: initialsFor(targetName(t)),
    name: targetName(t),
    role: targetRole(t),
    tier: t.tier,
    addedAt: t.addedAt,
    addedVia: t.source,
    facilities: (t.representedFacilities ?? []).map((f) => f.name),
    profileHref: profileHref(t.sourceDirectory, t.memberId),
  };
}

export function ClientCrmGovernmentProto({ client, drawer = false }: { client: Client; drawer?: boolean }) {
  const api = useApi();
  const navigate = useNavigate();
  const [drawerTarget, setDrawerTarget] = useState<ClientTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Same query key as the canonical TargetsTab — one shared cache entry (§10).
  const targetsQ = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', client.id],
    queryFn: () => getClientTargets(api, client.id),
    staleTime: 60_000,
  });
  const realTargets = targetsQ.isSuccess ? targetsQ.data : null;

  /**
   * Item 11: the real create flow is a debounced tri-directory search +
   * `addClientTarget`. This used to navigate to `?tab=targets` on the reasoning
   * that the antd TargetsTab owned that flow and `src/vnext` must stay
   * antd-free — but on os.capiro.ai that navigation is a NO-OP:
   * `client-crm-routing`'s LEGACY_TABS maps `tab=targets` back to
   * `relationships/government`, the view already on screen. So the button did
   * nothing. `AddRelationshipModal` is that same flow, native to vNext, on the
   * same endpoints and the same `['client-targets', clientId]` cache entry.
   */
  const openAddRelationship = () => setAddOpen(true);

  return (
    <div className={`cap-pf-anim-rise rel-gov-root${drawer ? ' rel-gov-root--drawer' : ''}`}>
      {drawer ? (
        <GovernmentRelationshipsDrawer
          targets={realTargets}
          loading={targetsQ.isPending}
          error={targetsQ.isError}
          onRetry={() => void targetsQ.refetch()}
          onOpen={setDrawerTarget}
          onAdd={openAddRelationship}
        />
      ) : (
        <>
      <TabPageHead
        title="Government relationships"
        sub="Current targets from Strategies, plus the broader offices and officials connected to this client."
        actions={
          <PfButton variant="primary" onClick={openAddRelationship}>
            Add relationship
          </PfButton>
        }
      />

      {/* Loading keeps the fixture on screen (pixel-reviewable); a genuine
          fetch error gets its own honest state instead of the fixture, same
          "never fabricate on a real error" standard as the rest of this
          file — see the recommendations rail's own error state below. */}
      {targetsQ.isError ? (
        <CurrentTargetsErrorState
          message={targetsQ.error instanceof Error ? targetsQ.error.message : undefined}
          onRetry={() => void targetsQ.refetch()}
        />
      ) : realTargets ? (
        <RealCurrentTargetsPanel targets={realTargets} onOpen={setDrawerTarget} />
      ) : (
        <CurrentTargetsPanel />
      )}

      {/* The "All government relationships" table was a second render of the
          same `['client-targets', clientId]` rows the Current targets panel
          above already shows — one client's targets listed twice on one
          screen. Only the recommender rail stays beside them. */}
      <TargetRecommendationsCard client={client} targets={realTargets ?? []} />
        </>
      )}

      <AddRelationshipModal open={addOpen} clientId={client.id} onClose={() => setAddOpen(false)} />

      {drawerTarget ? (
        <TargetDrawer
          target={toTargetRecord(drawerTarget)}
          onClose={() => setDrawerTarget(null)}
          onOpenProfile={() => navigate(profileHref(drawerTarget.sourceDirectory, drawerTarget.memberId))}
        />
      ) : null}
    </div>
  );
}

function GovernmentRelationshipsDrawer({
  targets,
  loading,
  error,
  onRetry,
  onOpen,
  onAdd,
}: {
  targets: ClientTarget[] | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpen: (target: ClientTarget) => void;
  onAdd: () => void;
}) {
  const congressional = (targets ?? []).filter((target) => target.sourceDirectory !== 'staff');
  const staff = (targets ?? []).filter((target) => target.sourceDirectory === 'staff');

  return (
    <div className="rel-gov-drawer">
      <RelationshipTable
        title="Congressional targets"
        targets={congressional}
        loading={loading}
        error={error}
        onRetry={onRetry}
        onOpen={onOpen}
        action={<button type="button" onClick={onAdd}>Add relationship</button>}
      />
      <RelationshipTable
        title="Committee staff"
        targets={staff}
        loading={loading}
        error={error}
        onRetry={onRetry}
        onOpen={onOpen}
      />
      <p className="rel-gov-drawer__note">
        Targets come from the client&apos;s active strategies. Committee staff are Directory records already attached to those offices; no staffer is inferred onto an office.
      </p>
    </div>
  );
}

function RelationshipTable({
  title,
  targets,
  loading,
  error,
  onRetry,
  onOpen,
  action,
}: {
  title: string;
  targets: ClientTarget[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpen: (target: ClientTarget) => void;
  action?: ReactNode;
}) {
  return (
    <section className="rel-gov-drawer__section">
      <div className="rel-gov-drawer__section-title">
        <span>{title}</span>
        <small>{targets.length} record{targets.length === 1 ? '' : 's'}</small>
        {action}
      </div>
      <div className="rel-gov-drawer__scroll">
        <div className="rel-gov-drawer__table">
          <div className="rel-gov-drawer__head" aria-hidden>
            <span>Name</span><span>Type</span><span>Jurisdiction</span><span>Office</span><span>Target</span>
          </div>
          {loading ? (
            <div className="rel-gov-drawer__state" aria-busy="true">Loading relationships…</div>
          ) : error ? (
            <div className="rel-gov-drawer__state rel-gov-drawer__state--error">
              Relationships could not be loaded. <button type="button" onClick={onRetry}>Retry</button>
            </div>
          ) : targets.length === 0 ? (
            <div className="rel-gov-drawer__state">No {title.toLowerCase()} recorded yet.</div>
          ) : (
            targets.map((target) => (
              <button key={target.id} type="button" className="rel-gov-drawer__row" onClick={() => onOpen(target)}>
                <span className="rel-gov-drawer__person">
                  <Avatar initials={initialsFor(targetName(target))} size={32} />
                  <strong>{targetName(target)}</strong>
                </span>
                <span>{DIRECTORY_LABEL[target.sourceDirectory]}</span>
                <span>{[target.state, target.chamber].filter(Boolean).join(' · ') || '—'}</span>
                <span>{target.committee ?? '—'}</span>
                <span className="rel-gov-drawer__tier">
                  <Pill tone={target.tier === 1 ? 'brand' : 'gray'} dotless>
                    {target.tier ? `Tier ${target.tier}` : 'Current'}
                  </Pill>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/* ── Current targets — real (items 12 + 13) ───────────────────────────────── */

function RealCurrentTargetsPanel({
  targets,
  onOpen,
}: {
  targets: ClientTarget[];
  onOpen: (t: ClientTarget) => void;
}) {
  // Tiered targets first (1 is highest), untiered last; stable by name after.
  const ordered = useMemo(
    () =>
      [...targets].sort((a, b) => {
        const at = a.tier ?? 99;
        const bt = b.tier ?? 99;
        if (at !== bt) return at - bt;
        return targetName(a).localeCompare(targetName(b));
      }),
    [targets],
  );

  return (
    <section className="rel-gov-panel">
      <div className="rel-gov-panel-head">
        <h3 className="rel-gov-panel-title">Current targets</h3>
        <span className="rel-gov-spacer" />
        <Eyebrow>
          {ordered.length} target{ordered.length === 1 ? '' : 's'}
        </Eyebrow>
      </div>

      {ordered.length === 0 ? (
        <div className="rel-gov-panel-empty">
          {/* The page header already carries the one "Add relationship" button —
              a second one here was a duplicate call to the same action. */}
          <p className="rel-gov-empty-msg">No government targets yet — add one from the header.</p>
        </div>
      ) : (
        <div className="cap-pf-grid-targets">
          {ordered.slice(0, 6).map((t, i) => (
            <RealTargetCard key={t.id} target={t} slot={`Target 0${i + 1}`} onOpen={() => onOpen(t)} />
          ))}
        </div>
      )}
    </section>
  );
}

function RealTargetCard({
  target: t,
  slot,
  onOpen,
}: {
  target: ClientTarget;
  slot: string;
  onOpen: () => void;
}) {
  return (
    <div className="rel-gov-card">
      <Eyebrow tight>{slot}</Eyebrow>

      <div className="rel-gov-card-top">
        <button type="button" onClick={onOpen} className="rel-gov-card-link rel-gov-card-link--interactive">
          <Tile initials={initialsFor(targetName(t))} size={40} dark round />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="rel-gov-card-eyebrow">{DIRECTORY_LABEL[t.sourceDirectory]}</span>
            <span className="rel-gov-card-name">{targetName(t)}</span>
            <span className="rel-gov-card-role">{targetRole(t)}</span>
            {t.party || t.state ? (
              <span className="rel-gov-card-submeta">{[t.party, t.state].filter(Boolean).join(' · ')}</span>
            ) : null}
          </span>
        </button>
        <span className="rel-gov-card-tier">
          <Pill tone={t.tier === 1 ? 'brand' : 'gray'} size="lg">
            {t.tier == null ? 'Untiered' : `Tier ${t.tier}`}
          </Pill>
        </span>
      </div>

      <div className="rel-gov-card-fields">
        <TargetField
          label="Represents"
          value={
            t.representedFacilities?.length
              ? t.representedFacilities.map((f) => f.name).join(', ')
              : 'No facility in this district'
          }
        />
        {/* Unknown source tokens are humanized, not silently collapsed to
            "Manual"; the date carries its year when it is not the current one. */}
        <TargetField
          label="Added"
          value={`${t.source === 'meri' ? 'Meri' : humanizeEnumToken(t.source)} · ${formatDateShort(t.addedAt) ?? '—'}`}
        />
      </div>

      <PfButton variant="link" style={{ alignSelf: 'flex-end' }} onClick={onOpen}>
        Open target →
      </PfButton>
    </div>
  );
}

/* ── Current targets (tinted panel) — design fixture ──────────────────────── */

function CurrentTargetsPanel() {
  return (
    <section className="rel-gov-panel">
      <div className="rel-gov-panel-head">
        <h3 className="rel-gov-panel-title">Current targets</h3>
        <span className="rel-gov-spacer" />
        <Eyebrow>3 active · from Strategies</Eyebrow>
      </div>

      <div className="cap-pf-grid-targets">
        {TARGETS.map((t, i) => (
          <TargetCard key={t.id} target={t} slot={`Target 0${i + 1}`} />
        ))}
      </div>
    </section>
  );
}

/**
 * Honest error state for the Current targets panel — same tinted-section
 * shell as the fixture/real panels above, but with the recommendations
 * rail's already-established "couldn't load / Try again" voice (§ below)
 * instead of a second, differently-worded error surface.
 */
function CurrentTargetsErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <section className="rel-gov-panel">
      <div className="rel-gov-panel-head">
        <h3 className="rel-gov-panel-title">Current targets</h3>
      </div>
      <PfEmptyState
        title="Couldn't load current targets"
        hint={message ?? 'Try again, or confirm this client has targets set in Strategies.'}
        action={
          <PfButton variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </PfButton>
        }
      />
    </section>
  );
}

function TargetCard({ target: t, slot }: { target: (typeof TARGETS)[number]; slot: string }) {
  const tone = DISPOSITION_TONE[t.disposition] ?? 'gray';
  const [, , dispFg, dispDot] = PILL[tone];
  return (
    <div className="rel-gov-card">
      <Eyebrow tight>{slot}</Eyebrow>

      <div className="rel-gov-card-top">
        <TargetMiniCard target={t} dispFg={dispFg} dispDot={dispDot} />
        <span className="rel-gov-card-tier">
          <Pill tone="gray" size="lg">
            {t.date}
          </Pill>
        </span>
      </div>

      <div className="rel-gov-card-fields">
        <TargetField label="Linked strategy" value={t.strategy} />
        <TargetField label="Current ask" value={t.ask} />
      </div>

      <PfButton variant="link" style={{ alignSelf: 'flex-end' }}>
        Open target →
      </PfButton>
    </div>
  );
}

/** Fixture-only mini card. Non-interactive on purpose: the design's people
 *  are not records, so a button here promised a drawer that never opened. */
function TargetMiniCard({
  target: t,
  dispFg,
  dispDot,
}: {
  target: (typeof TARGETS)[number];
  dispFg: string;
  dispDot: string;
}) {
  return (
    <span className="rel-gov-card-link">
      <Tile initials={t.init} size={40} dark round={t.kind === 'person'} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="rel-gov-card-eyebrow" style={{ color: dispFg }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: dispDot }} aria-hidden />
          {t.disposition}
        </span>
        <span className="rel-gov-card-name">{t.name}</span>
        <span className="rel-gov-card-role">{t.role}</span>
        <span className="rel-gov-card-submeta">{t.confirm}</span>
      </span>
    </span>
  );
}

function TargetField({ label, value }: { label: string; value: string }) {
  return (
    <span className="rel-gov-field">
      <span className="rel-gov-field-label">{label}</span>
      <span className="rel-gov-field-value">{value}</span>
    </span>
  );
}

/* ── Target recommendations (office recommender / Suggested by Meri) ─────── */

/** Compact "updated X ago" — same cadence as legacy TargetsTab. */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const PARTY_TONE: Record<string, PillTone> = {
  R: 'error',
  D: 'blue',
  I: 'gray',
};

/**
 * Side rail: office recommendations from
 * GET/POST `/api/clients/:id/target-recommendations`. Same cache keys as
 * TargetsTab so a refresh from the client shell or an add here is shared.
 * Styled with portfolio Card / PfButton / Pill primitives (UUI gray + dark
 * gradient primary) — not the legacy antd meri-panel classes.
 */
function TargetRecommendationsCard({
  client,
  targets,
}: {
  client: Client;
  targets: ClientTarget[];
}) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clientId = client.id;

  const recsQ = useQuery<OfficeRecommendationsResult>({
    queryKey: ['client-target-recommendations', clientId],
    queryFn: () => getOfficeRecommendations(api, clientId),
    enabled: Boolean(clientId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshOfficeRecommendations(api, clientId),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['client-target-recommendations', clientId] });
    },
    onSuccess: (data) => {
      qc.setQueryData(['client-target-recommendations', clientId], data);
    },
  });

  const addMutation = useMutation({
    mutationFn: (memberId: string) => addClientTarget(api, clientId, memberId, 'meri', 'congress'),
    onMutate: async (memberId) => {
      await qc.cancelQueries({ queryKey: ['client-targets', clientId] });
      const prev = qc.getQueryData<ClientTarget[]>(['client-targets', clientId]);
      const optimistic: ClientTarget = {
        id: `optimistic-${memberId}`,
        clientId,
        memberId,
        memberName: null,
        sourceDirectory: 'congress',
        party: null,
        state: null,
        chamber: null,
        committee: null,
        tier: null,
        source: 'meri',
        addedByUserId: null,
        addedAt: new Date().toISOString(),
        representedFacilities: null,
      };
      qc.setQueryData<ClientTarget[]>(['client-targets', clientId], [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['client-targets', clientId], ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['client-targets', clientId] });
      void qc.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const suggestions = useMemo(
    () =>
      (recsQ.data?.recommendations ?? [])
        .filter((r): r is OfficeRecommendation => typeof r?.memberId === 'string' && r.memberId.length > 0)
        .slice(0, 6),
    [recsQ.data],
  );

  const addedIds = useMemo(() => new Set(targets.map((t) => t.memberId)), [targets]);
  const computedAt = recsQ.data?.computedAt ?? null;
  const recsLoading = recsQ.isLoading || (recsQ.isFetching && !recsQ.data);
  const refreshing = refreshMutation.isPending;
  const openIntel = () =>
    navigate(`/clients?clientId=${encodeURIComponent(clientId)}&tab=intelligence&view=legislative`);

  return (
    <Card>
      <CardHead
        withDesc
        title="Suggested by Meri"
        description="Ranked by committee jurisdiction over tracked bills, with issue overlap and facility-district nexus when available."
        action={
          <PfButton
            variant="secondary"
            size="sm"
            busy={refreshing}
            disabled={refreshing || recsLoading}
            onClick={() => refreshMutation.mutate()}
            title="Recompute recommendations from the latest tracked bills and facilities"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </PfButton>
        }
      />

      {computedAt && !recsLoading ? (
        <div className="rel-gov-updated">
          Updated {relativeTime(computedAt)}
          <span className="rel-gov-updated-sep"> · top 6 · weighted score</span>
        </div>
      ) : null}

      {recsLoading ? (
        <div className="rel-gov-recs-loading" aria-busy="true" aria-label="Loading recommendations">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rel-gov-recs-loading-row">
              <PfSkeleton width={28} height={28} style={{ borderRadius: 8 }} />
              <div className="rel-gov-recs-loading-text">
                <PfSkeleton width="70%" height={14} />
                <PfSkeleton width="45%" height={12} />
              </div>
              <PfSkeleton width={52} height={28} style={{ borderRadius: 8 }} />
            </div>
          ))}
        </div>
      ) : recsQ.isError || refreshMutation.isError ? (
        <PfEmptyState
          title="Couldn't load recommendations"
          hint="Try again, or confirm tracked bills and facilities are set for this client."
          action={
            <PfButton variant="secondary" size="sm" onClick={() => refreshMutation.mutate()} disabled={refreshing} busy={refreshing}>
              Try again
            </PfButton>
          }
        />
      ) : suggestions.length === 0 ? (
        <PfEmptyState
          title="No Meri suggestions yet"
          hint="Confirm this client's LDA match and add tracked bills in Intelligence, then refresh to get recommendations."
          action={
            <PfButton variant="secondary" size="sm" onClick={openIntel}>
              Open Intelligence
            </PfButton>
          }
        />
      ) : (
        <div role="list" aria-label="Suggested targets">
          {suggestions.map((m, idx) => {
            const added = addedIds.has(m.memberId);
            const adding = addMutation.isPending && addMutation.variables === m.memberId;
            const partyTone = PARTY_TONE[m.party ?? ''] ?? 'gray';
            const partyLabel = [m.party, m.state].filter(Boolean).join('-') || '—';
            return (
              <div
                key={m.memberId}
                role="listitem"
                className={idx === 0 ? 'rel-gov-sugg-row rel-gov-sugg-row--first' : 'rel-gov-sugg-row'}
              >
                <span aria-hidden className="rel-gov-sugg-rank">
                  {idx + 1}
                </span>
                <div className="rel-gov-sugg-content">
                  <button
                    type="button"
                    onClick={() => navigate(profileHref('congress', m.memberId))}
                    className="rel-gov-sugg-office"
                    title={m.office}
                  >
                    {m.office || m.memberId}
                  </button>
                  <div className="rel-gov-sugg-pills">
                    <Pill tone={partyTone} style={{ height: 22 }}>
                      {partyLabel}
                    </Pill>
                    {m.chamber ? <span className="rel-gov-sugg-chamber">{m.chamber}</span> : null}
                    {m.committee ? (
                      <span className="rel-gov-sugg-committee" title={m.committee}>
                        {m.committee}
                      </span>
                    ) : null}
                  </div>
                  <span className="rel-gov-sugg-stats">
                    {m.billCount} tracked bill{m.billCount === 1 ? '' : 's'}
                    <span className="rel-gov-updated-sep"> · </span>
                    score {Number(m.score ?? 0).toFixed(2)}
                  </span>
                </div>
                <div className="rel-gov-sugg-action">
                  {added ? (
                    <Pill tone="success" style={{ height: 28 }}>
                      Added
                    </Pill>
                  ) : (
                    <PfButton
                      variant="secondary"
                      size="sm"
                      busy={adding}
                      disabled={adding || addMutation.isPending}
                      onClick={() => addMutation.mutate(m.memberId)}
                      style={{ height: 32, padding: '0 12px', fontSize: 13 }}
                    >
                      + Add
                    </PfButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rel-gov-footer">
        <PfButton variant="link" onClick={openIntel}>
          View all in Intelligence →
        </PfButton>
      </div>
    </Card>
  );
}
