import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { UIcon, PILL } from './portfolio-primitives.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { readClientFundingPriorities } from '../../../pages/clients/client-registrations.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import { sectorLabel } from '../../lib/labels.js';
import { openMeriWorkspaceWithContext } from '../../../components/chat/meri-window.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import type { CrmSurface, CrmView } from './client-crm-routing.js';
import { useClientAccountOwner } from './useClientAccountOwner.js';
import { ClientRecordDirectory } from './ClientRecordDirectory.js';
import { RecordDrawer } from './RecordDrawer.js';
import { ManageAccountTeamModal } from './ManageAccountTeamModal.js';
import { clientTeamKey, getClientTeam, teamMemberLabel } from './client-team-api.js';
import { ClientNotetakerAction } from './ClientNotetakerAction.js';
import { ClientBudgetWatches } from './ClientBudgetWatches.js';
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
 * Portfolio prototype client shell. Wraps every /clients?clientId= route body:
 * back/freshness bar → identity block → seven-row record directory + one
 * active record surface. The shared AppShellUui owns the global top bar and
 * rail; this shell owns everything below it inside the client route.
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
  onEditProfile?: () => void;
  /** Item 10: the client PUT behind a focus tag is gated at user_admin. */
  canEditFocus?: boolean;
  /** The one active record surface. */
  children: ReactNode;
  /**
   * The right-side `RecordDrawer` body for Relationships/Work/Files/
   * Capabilities, computed by the caller (it knows which `ClientCrmXxxProto`
   * to render). `null`/`undefined` closes the drawer.
   */
  drawerContent?: ReactNode;
  drawerTitle?: string;
  drawerSub?: string;
  onCloseDrawer?: () => void;
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
  view,
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
  onEditProfile,
  canEditFocus = false,
  children,
  drawerContent,
  drawerTitle,
  drawerSub,
  onCloseDrawer,
}: ProfileShellProps) {
  const chips = focusChipsFor(client);
  const fundingPriorities = readClientFundingPriorities(client);
  const isActive = (client.status ?? '').toLowerCase() === 'active';
  const statusTone = isActive ? 'success' : (client.status ?? '').toLowerCase() === 'at risk' ? 'warning' : 'gray';
  const [st, sr, sf, sd] = PILL[statusTone];
  const bp = usePfBreakpoints();
  const navigate = useNavigate();
  // Item 11 freshness dot tone: amber beats green beats the not-yet-loaded gray.
  const freshnessState = sourceFailures > 0 ? 'warn' : refreshedLabel ? 'ok' : 'pending';

  return (
    <div
      className="cap-pf cap-pf-client"
      data-pf-narrow={bp.narrow ? '1' : undefined}
      data-pf-tight={bp.tight ? '1' : undefined}
      data-pf-collapsed={bp.collapsed ? '1' : undefined}
    >
      {/* ── Back + freshness bar ──────────────────────────────────────────── */}
      <div className="cap-pf-client__crumbs cap-pf-breadcrumb-bar">
        <CrumbButton label="All clients" back onClick={() => navigate('/clients')} />
        <span className="cap-pf-breadcrumb-spacer" />
        {/* Fetch status for the six profile sections checked by the health drawer. */}
        <span className="cap-pf-breadcrumb-freshness" title="Profile section fetch status. Intelligence sources and upstream data freshness are not included.">
          <span
            className={`cap-pf-freshness-dot cap-pf-freshness-dot--${freshnessState}${sourceFailures === 0 ? ' cap-pf-anim-pulse' : ''}`}
          />
          {sourceFailures > 0
            ? `${sourceFailures} profile section${sourceFailures === 1 ? '' : 's'} unavailable`
            : refreshedLabel
              ? `Profile sections read ${refreshedLabel}`
              : 'Reading profile sections…'}
        </span>
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
      <div className="cap-pf-client__identity">
        <div className="cap-pf-identity-row">
          {/* 56px dark tile */}
          <span
            aria-hidden
            className={client.logoUrl ? 'cap-pf-identity-tile' : 'cap-pf-identity-tile cap-pf-identity-tile--dark'}
          >
            {client.logoUrl ? <img src={client.logoUrl} alt="" className="cap-pf-identity-tile__img" /> : initialsFor(client.name)}
          </span>

          <div className="cap-pf-identity-main">
            <div className="cap-pf-identity-name-row">
              <h1 className="cap-pf-client-name">
                {client.name}
              </h1>
              <span
                className="cap-pf-status-pill"
                style={{ background: st, border: `1px solid ${sr}`, color: sf }}
              >
                <span className="cap-pf-status-pill__dot" style={{ background: sd }} />
                {isActive ? 'Active client' : (client.status ?? 'Unknown status')}
              </span>
            </div>

            {client.description || client.productDescription ? (
              <p className="cap-pf-client-description">
                {client.description || client.productDescription}
              </p>
            ) : null}

            {fundingPriorities.length > 0 ? (
              <div className="cap-pf-funding-priorities">
                <span className="cap-pf-funding-priorities__label">Funding priorities</span>
                <ul aria-label="Funding priorities">
                  {fundingPriorities.slice(0, 3).map((priority) => (
                    <li key={priority}>{priority}</li>
                  ))}
                </ul>
                {fundingPriorities.length > 3 ? (
                  <details>
                    <summary>
                      Show {fundingPriorities.length - 3} more {fundingPriorities.length === 4 ? 'priority' : 'priorities'}
                    </summary>
                    <ul aria-label="Additional funding priorities">
                      {fundingPriorities.slice(3).map((priority) => (
                        <li key={priority}>{priority}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}

            {/* Focus row */}
            <div className="cap-pf-identity-focus-row">
              {chips.map((chip) => (
                <span key={chip} className="cap-pf-focus-chip">
                  {chip}
                </span>
              ))}
              {canEditFocus ? <AddFocusButton client={client} existing={chips} /> : null}
            </div>
          </div>

          {/* Right cluster */}
          <div className="cap-pf-identity-right">
            <div className="cap-pf-identity-actions">
              <MeriActionsMenu key={client.id} client={client} busy={fillBusy} fillLabel={fillLabel} onFillWithMeri={onFillWithMeri} />
              <OverflowMenu
                client={client}
                onDataHealth={onDataHealth}
                onEditProfile={onEditProfile}
                canArchive={canArchive}
                onArchive={onArchive}
              />
            </div>
            <AccountSummaryCard client={client} canAssign={canEditFocus} />
          </div>
        </div>
      </div>

      {/* ── Body: prototype directory + one active record surface ───────── */}
      <div className="cap-pf-client__body">
        <div className="cap-pf-grid-record">
          <ClientRecordDirectory tab={tab} view={view} onNavigate={onNavigate} />
          <div className="cap-pf-client-sections">{children}</div>
        </div>
        <ClientBudgetWatches clientId={client.id} />
      </div>

      {drawerContent != null ? (
        <RecordDrawer
          eyebrow={client.name}
          title={drawerTitle ?? ''}
          sub={drawerSub}
          onClose={() => onCloseDrawer?.()}
        >
          {drawerContent}
        </RecordDrawer>
      ) : null}
    </div>
  );
}

/* ── small shell pieces ───────────────────────────────────────────────────── */

function CrumbButton({ label, strong = false, back = false, onClick }: { label: string; strong?: boolean; back?: boolean; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={strong || hover ? 'cap-pf-crumb-btn cap-pf-crumb-btn--active' : 'cap-pf-crumb-btn'}
    >
      {back ? <UIcon name="ChevronLeft" size={16} /> : null}
      {label}
    </button>
  );
}

function AccountSummaryCard({ client, canAssign }: { client: Client; canAssign: boolean }) {
  const api = useApi();
  const owner = useClientAccountOwner(client.id, canAssign);
  const team = useQuery({
    queryKey: clientTeamKey(client.id),
    queryFn: () => getClientTeam(api, client.id),
  });
  const [managing, setManaging] = useState(false);
  const currentMissing =
    owner.owner != null && !owner.options.some((option) => option.id === owner.owner?.id);
  const display = owner.isLoading ? 'Loading…' : owner.ownerLabel ?? 'Unassigned';
  const roster = team.data ?? [];

  return (
    <>
      <div className="cap-pf-account-card">
        <span className="cap-pf-account-card__label">Owner</span>
        <span className="cap-pf-account-card__value">
          <span className="cap-pf-account-avatar" aria-hidden>{initialsFor(display)}</span>
          {canAssign ? (
            <select
              aria-label="Account owner"
              value={owner.assignment?.accountOwnerUserId ?? ''}
              disabled={owner.isLoading || owner.isAssigning}
              onChange={(event) => owner.setOwner(event.target.value || null)}
              title={owner.error instanceof Error ? owner.error.message : undefined}
              className={owner.error ? 'cap-pf-account-owner-select cap-pf-account-owner-select--error' : 'cap-pf-account-owner-select'}
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
              className={owner.ownerLabel ? 'cap-pf-account-owner-display cap-pf-account-owner-display--set' : 'cap-pf-account-owner-display'}
            >
              {owner.error ? 'Unavailable' : display}
            </span>
          )}
        </span>

        <span className="cap-pf-account-card__label">Team</span>
        <span className="cap-pf-account-card__value cap-pf-account-card__team">
          <span className="cap-pf-account-team-avatars">
            {roster.slice(0, 3).map((member) => {
              const label = teamMemberLabel(member);
              return <span key={member.userId} className="cap-pf-account-avatar" title={label}>{initialsFor(label)}</span>;
            })}
            {team.isLoading ? <span className="cap-pf-account-card__muted">Loading…</span> : null}
            {team.isError ? <span className="cap-pf-account-card__muted">Unavailable</span> : null}
          </span>
          {canAssign ? (
            <button type="button" className="cap-pf-account-manage" onClick={() => setManaging(true)}>Manage</button>
          ) : null}
        </span>

        <span className="cap-pf-account-card__label">Since</span>
        <span className="cap-pf-account-card__since">{formatAccountSince(client.createdAt)}</span>
      </div>
      {managing ? (
        <ManageAccountTeamModal open clientId={client.id} clientName={client.name} onClose={() => setManaging(false)} />
      ) : null}
    </>
  );
}

/**
 * `client.createdAt` is a full timestamp, but a date-only `YYYY-MM-DD` string
 * can also arrive here (e.g. when a caller passes an intake date such as
 * `engagementStartDate`). `new Date('2026-01-12')` is UTC midnight, which
 * renders as the previous day anywhere behind UTC — the live header showed
 * "Jan 11, 2026" for the 2026-01-12 seed in America/New_York. Anchor the
 * date-only form to local noon so the calendar day survives every timezone;
 * full timestamps still parse normally.
 */
function formatAccountSince(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
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
        className={hover ? 'cap-pf-add-focus-trigger cap-pf-add-focus-trigger--hover' : 'cap-pf-add-focus-trigger'}
      >
        <UIcon name="Plus" size={14} />
        Add focus
      </button>
    );
  }

  return (
    <span className="cap-pf-add-focus-open">
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
      />
      <button
        type="button"
        onClick={submit}
        disabled={!trimmed || duplicate || save.isPending}
        className={!trimmed || duplicate ? 'cap-pf-add-focus-save cap-pf-add-focus-save--disabled' : 'cap-pf-add-focus-save'}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {duplicate ? (
        <span className="cap-pf-add-focus-error">Already a focus</span>
      ) : null}
      {save.isError ? (
        <span className="cap-pf-add-focus-error">
          {save.error instanceof Error ? save.error.message : 'Could not save'}
        </span>
      ) : null}
    </span>
  );
}

/** Client-scoped Meri actions share one menu. */
function MeriActionsMenu({ client, busy, fillLabel, onFillWithMeri }: { client: Client; busy: boolean; fillLabel: string; onFillWithMeri: () => void }) {
  const toast = useCapiroToast();
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || dialogOpen) return undefined;
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
  }, [open, dialogOpen]);

  return (
    <div ref={wrapRef} className="cap-pf-menu-anchor">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="cap-pf-meri-actions-trigger"
      >
        <UIcon name="Stars02" size={18} />
        Meri Actions
        <span className={open ? 'cap-pf-meri-actions-chevron cap-pf-meri-actions-chevron--open' : 'cap-pf-meri-actions-chevron'}>
          <UIcon name="ChevronDown" size={16} />
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Meri Actions"
          className="cap-pf-meri-actions-menu"
        >
          <MeriActionItem
            icon="Stars02"
            label="Ask Meri about this client"
            detail="Open Meri with this client in context."
            onSelect={() => {
              setOpen(false);
              void (async () => {
                const prompt = `What should I know about ${client.name} right now?`;
                let copied = false;
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(prompt);
                    copied = true;
                  }
                } catch {
                  copied = false;
                }
                const popup = openMeriWorkspaceWithContext({ prompt, clientId: client.id });
                if (!popup) {
                  toast.error(
                    copied
                      ? 'The Meri window was blocked. The prompt is copied to your clipboard.'
                      : 'The Meri window was blocked. Allow pop-ups for Capiro and try again.',
                  );
                  return;
                }
                toast.success('Meri opened with this client in context.');
              })();
            }}
          />
          <MeriActionItem
            icon="Stars02"
            label={busy ? 'Analyzing…' : fillLabel}
            detail="Meri proposes field values from connected sources. Nothing is written until you review each one."
            onSelect={() => {
              setOpen(false);
              onFillWithMeri();
            }}
          />
          <ClientNotetakerAction client={client} onDialogChange={setDialogOpen} />
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
      className={hover && !disabled ? 'cap-pf-meri-action-item cap-pf-meri-action-item--hover' : 'cap-pf-meri-action-item'}
    >
      <span className="cap-pf-meri-action-icon">
        <UIcon name={icon} size={16} />
      </span>
      <span className="cap-pf-meri-action-body">
        <span className="cap-pf-meri-action-label-row">
          <span className="cap-pf-meri-action-label">{label}</span>
          {disabled && disabledReason ? (
            <span className="cap-pf-meri-action-badge">
              {disabledReason}
            </span>
          ) : null}
        </span>
        <span className="cap-pf-meri-action-detail">{detail}</span>
      </span>
    </button>
  );
}

/* ── Overflow menu (§5.2) ─────────────────────────────────────────────────── */

function OverflowMenu({
  client,
  onDataHealth,
  onEditProfile,
  canArchive,
  onArchive,
}: {
  client: Client;
  onDataHealth: () => void;
  onEditProfile?: () => void;
  canArchive?: boolean;
  onArchive?: () => void;
}) {
  const api = useApi();
  const toast = useCapiroToast();
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
      const intelligenceEndpoint = `/api/intelligence/client-profile/${client.id}`;
      const [clientRec, intelResult] = await Promise.all([
        api.get<Client>(`/api/clients/${client.id}`),
        api.get(intelligenceEndpoint).then(
          (response) => ({ data: response.data, error: null }),
          (error: unknown) => ({ data: null, error: {
            code: 'source_unavailable',
            message: 'Client intelligence could not be loaded.',
            httpStatus: (error as { response?: { status?: number } } | null)?.response?.status ?? null,
          } }),
        ),
      ]);
      const partial = intelResult.error !== null;
      const payload = {
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        complete: !partial,
        omittedSources: partial ? ['intelligence'] : [],
        sources: {
          client: { status: 'available' },
          intelligence: { status: partial ? 'unavailable' : 'available', endpoint: intelligenceEndpoint, error: intelResult.error },
        },
        client: clientRec.data,
        intelligence: intelResult.data,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${client.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}-profile${partial ? '-partial' : ''}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setOpen(false);
      if (partial) toast.error('Partial JSON export downloaded. Intelligence was unavailable; the file includes the omission and source error.');
      else toast.success('Client profile JSON exported.');
    } catch {
      toast.error('Client profile could not be exported. Please retry.');
    } finally {
      setExporting(false);
    }
  };

  const items: Array<{ label: string; danger?: boolean; onSelect: () => void }> = [
    ...(onEditProfile
      ? [{ label: 'Edit client profile', onSelect: () => { setOpen(false); onEditProfile(); } }]
      : []),
    { label: 'Profile & source health', onSelect: () => { setOpen(false); onDataHealth(); } },
    { label: exporting ? 'Exporting…' : 'Export client profile (JSON)', onSelect: exportProfile },
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
    <div ref={wrapRef} className="cap-pf-menu-anchor">
      <MenuTrigger open={open} onClick={() => setOpen((v) => !v)} name={client.name} />
      {open ? (
        <div
          role="menu"
          className="cap-pf-overflow-menu"
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
      className={hover ? 'cap-pf-menu-trigger cap-pf-menu-trigger--hover' : 'cap-pf-menu-trigger'}
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
