import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isTenantAdmin, type TenantRole } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CompiledWatchlist } from '../watchlist/watchlist-compiler.js';
import type { TermRoute } from '../watchlist/term-routing.js';
import { TrackerWatchlistRead } from './tracker-watchlist-read.js';
import { TrackerWatchlistWrite } from './tracker-watchlist-write.js';
import { TrackerWatchlistPreferences } from './tracker-watchlist-preferences.js';
import { TrackerWatchlistCompiled } from './tracker-watchlist-compiled.js';
import type {
  TrackerTermInput,
  TrackerTopicInput,
  PutWatchlistInput,
  WatchlistView,
  WatchlistRevisionView,
  PutAlertPrefsInput,
} from './tracker-watchlist.contracts.js';
export type {
  TrackerTermInput,
  TrackerTopicInput,
  PutWatchlistInput,
  WatchlistView,
  WatchlistRevisionView,
  PutAlertPrefsInput,
} from './tracker-watchlist.contracts.js';

/**
 * Synthetic topic label for hearing-native FLAT terms (topicId NULL) folded into
 * the unified editor (P5). The old WatchlistsTab wrote flat terms straight onto a
 * watchlist row; the unified editor now owns them, so getWatchlist surfaces them
 * under this topic (rather than orphaning them) and putWatchlist re-persists them
 * from the same-named topic. Prefixed to avoid colliding with a real tag label.
 */
export const HEARING_TERMS_TOPIC_LABEL = 'Hearing terms';

/**
 * §4.3 / §5.1 criterion 3: the synthetic label is RESERVED as a name a user may
 * type — but it must stay acceptable when it is the legitimate fold-back of this
 * row's flat terms, or a topic that already carries it. Rejecting it
 * unconditionally destroys data: getWatchlist folds `topicId IS NULL` rows under
 * exactly this label and putWatchlist re-persists them from it, so a blanket
 * rejection means step 8 never writes them and step 10 then clears the flat rows.
 */
export function isReservedTopicLabel(label: string): boolean {
  return label.trim().toLowerCase() === HEARING_TERMS_TOPIC_LABEL.toLowerCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gate J (MP-02, Neo-confirmed 2026-07-27): the dated grace-window cutover
 * for requiring `expectedVersion` on `putWatchlist`. The shipped web client
 * already always sends it (`intel-tracker-api.ts:340`); this only ever
 * catches a stale cached bundle or a hand-rolled request. Before this date,
 * an absent `expectedVersion` is accepted and logged (unchanged); from this
 * date on, it 428s. Do not backdate this without re-confirming — it is a
 * behavior change to a live write path.
 */
const EXPECTED_VERSION_REQUIRED_FROM = new Date('2026-08-10T00:00:00Z');

/**
 * Default alert triggers seeded on a new subscriber pref (kept in sync with
 * apps/api tracker.types.DEFAULT_TRIGGERS). LegiWatch B deliberately turns
 * `fiscalNote` + `sponsorMomentum` default-ON now that emitters exist for them
 * (they were defined-but-dead before); `newMatch` and the text-changed→`amendment`
 * key were already default-on. `deadline` (Phase 1 M2.3) joins the same way —
 * the emitter now exists. Existing subscribers pick these up via the
 * idempotent `backfill-default-triggers` verb (they were never deliverable, so
 * appending them can't clobber a deliberate opt-out).
 */
export const DEFAULT_TRIGGERS: readonly string[] = [
  'newMatch',
  'amendment',
  'hearing',
  'committeeVote',
  'floorVote',
  'enactedFailed',
  'fiscalNote',
  'sponsorMomentum',
  'companion',
  'deadline',
];

const read = new TrackerWatchlistRead({
  uuid: UUID_RE,
  hearingLabel: () => HEARING_TERMS_TOPIC_LABEL,
});
const write = new TrackerWatchlistWrite({
  requiredFrom: EXPECTED_VERSION_REQUIRED_FROM,
  hearingLabel: () => HEARING_TERMS_TOPIC_LABEL,
  reservedLabel: isReservedTopicLabel,
});
const preferences = new TrackerWatchlistPreferences(() => DEFAULT_TRIGGERS);
const compiled = new TrackerWatchlistCompiled();

@Injectable()
export class TrackerWatchlistService {
  private readonly logger = new Logger(TrackerWatchlistService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param opts.withUserNames resolve `updatedBy` to a display name. OFF by default
   *   because `getCompiled` → `compiledTopics` calls this on the recommendations hot
   *   path, and attribution is only ever rendered by the Configure panel — so the
   *   extra `users` lookup is paid by the one caller that needs it.
   */
  async getWatchlist(
    tenantId: string,
    clientId: string,
    opts: { withUserNames?: boolean } = {},
  ): Promise<WatchlistView> {
    return read.getWatchlist(this, tenantId, clientId, opts);
  }

  /**
   * The sector-derived issue area for a never-configured client (P6, legacy
   * carryover from apps/api getWatchlist which auto-selected
   * issueAreaForSector(client.sectorTag)). Tenant-scoped read (intel-api has no
   * RLS) via withSystem; returns [] on any miss. Read-only — never written.
   */
  private async getSectorSuggestion(tenantId: string, clientId: string): Promise<string[]> {
    return read.getSectorSuggestion(this, tenantId, clientId);
  }

  /**
   * Upsert the watchlist head + reconcile its topics/terms atomically, keyed on
   * LABEL (P0-03 item 5, P1-02).
   *
   * Replaces the original delete-all-then-recreate: it cascade-deleted every
   * topic and re-created each one with a FRESH cuid on every autosave, so no
   * topic id was ever stable across two saves, a rename was indistinguishable
   * from a delete+create, and every term row's `createdAt` reset 600ms after any
   * keystroke. `(watchlistId, label)` is now a real unique index (migration
   * 20260726120000), which is what makes a per-topic upsert possible.
   *
   * Order is load bearing: renames BEFORE creates/deletes (so an id survives a
   * rename), per-topic term replacement (so an untouched topic keeps its rows),
   * deletes computed from the POST-rename index (so a renamed topic is never
   * deleted, §4.6), and the flat-term clear LAST (§4.1 / boundary §2.4.1 — the
   * folded "Hearing terms" rows have only just been re-persisted as topic rows).
   *
   * Idempotent: two identical calls leave identical rows AND identical topic ids.
   */
  async putWatchlist(
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutWatchlistInput,
  ): Promise<WatchlistView> {
    return write.putWatchlist(this, tenantId, clientId, userId, input);
  }

  /**
   * P1-02 permission gate: only a tenant ADMIN may edit firm-wide targeting.
   *
   * Targeting is shared — one analyst's autosave rewrites what every colleague's
   * recommendations and alerts are scored against — so "can view" and "can edit
   * firm-wide targeting" must not be the same permission. Per-user surfaces are
   * deliberately NOT gated: `intel_alert_preference` is keyed by (userId, clientId),
   * so a user editing their own alert prefs cannot affect anyone else, and tracking a
   * bill is additive and reversible.
   *
   * Reads the AUTHORITATIVE role from `tenant_memberships` rather than the Clerk
   * `org_role` claim on the request: the claim carries Clerk's own vocabulary
   * (`org:admin`), the membership row carries Capiro's (`user_admin` /
   * `capiro_admin` / `standard_user`) which `isTenantAdmin` is defined over, and the
   * claim may be absent depending on the JWT template. One extra query on a write
   * path is a fair price for matching what apps/api would decide.
   *
   * FAIL-CLOSED on an indeterminate identity (no membership row) — Gate J
   * (MP-03, Neo-confirmed 2026-07-27, MASTER §7.3). Previously fail-open, on
   * the reasoning that this protects config integrity between colleagues, not
   * a tenant boundary (cross-tenant access is already blocked by
   * `assertClientInTenant` plus RLS). That is still true, but it left a real
   * hole: `TenantGuard` requires an ACTIVE membership via a near-superset
   * query, so the one live window this fires in is
   * `org-tenant-resolver.service.ts`'s 30-second positive-membership cache
   * serving a stale "active" after the row is deleted — in that window a
   * just-removed non-admin could rewrite firm-wide targeting. Do NOT touch
   * `org-tenant-resolver.service.ts` or its cache TTL here — it is
   * auth-adjacent and any change to it is a separate, Neo-gated decision.
   */
  private async assertCanEditTargeting(tenantId: string, clerkUserId: string): Promise<void> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ role: string }>>(
        `SELECT m.role::text AS role
           FROM tenant_memberships m
           JOIN users u ON u.id = m.user_id
          WHERE u.clerk_user_id = $1 AND m.tenant_id = $2::uuid
          LIMIT 1`,
        clerkUserId,
        tenantId,
      ),
    );
    const role = rows[0]?.role;
    if (!role) {
      // The "repair path": this is deliberately an ERROR (not warn) with
      // enough to investigate, and a distinct code (not the generic
      // TARGETING_EDIT_FORBIDDEN below) with a message that separates the
      // two real causes — retry past the 30s cache window, or an admin needs
      // to repair a missing/stale local `users`/`tenant_memberships` row —
      // rather than a bypass that hides either from ever surfacing.
      this.logger.error(
        `putWatchlist: no tenant_memberships row for this caller — denying the edit ` +
          `(fail-closed) tenant=${tenantId}. A retry after ~30s resolves a stale positive- ` +
          `membership-cache read; a repeat past that window means this caller's local ` +
          `users/tenant_memberships row is missing or stale and needs an admin to repair it.`,
      );
      throw new ForbiddenException({
        code: 'TARGETING_MEMBERSHIP_UNRESOLVED',
        message:
          'We could not verify your membership in this workspace. Please refresh and try again; ' +
          'if this keeps happening, ask an admin to check your account.',
      });
    }
    if (!isTenantAdmin(role as TenantRole)) {
      throw new ForbiddenException({
        code: 'TARGETING_EDIT_FORBIDDEN',
        message:
          'Targeting is shared with your whole firm, so only an admin can change it. Ask an admin to update it for you.',
      });
    }
  }

  /**
   * Clerk user id → display name (P1-02 e-8 follow-up). `withSystem` because
   * `users` is not tenant-scoped in intel-api's schema and this service has no
   * Prisma model for it — the same raw-SQL pattern `assertClientInTenant` uses.
   *
   * Read-only and best-effort: any miss returns null and the UI falls back to the
   * timestamp alone. Deliberately returns a NAME or nothing — never the id, and
   * never the email (which would leak an address into shared firm-wide UI).
   */
  private async resolveUserName(clerkUserId: string | null): Promise<string | null> {
    return read.resolveUserName(this, clerkUserId);
  }

  /**
   * The shared-targeting change log, newest first (P1-02). Capped at 20 — this is
   * a "who touched this recently" affordance in the Configure panel, not an audit
   * export. `assertClientInTenant` first: the table's rows carry tenant_id but the
   * route takes a client id from the URL.
   */
  async getRevisions(tenantId: string, clientId: string): Promise<WatchlistRevisionView[]> {
    return read.getRevisions(this, tenantId, clientId);
  }

  async getAlertPrefs(tenantId: string, clientId: string, userId: string) {
    return preferences.getAlertPrefs(this, tenantId, clientId, userId);
  }

  /**
   * Legacy `assertClient` port: 404 unless `clientId` is a client of the
   * caller's tenant. `intel_*` carries FORCE ROW LEVEL SECURITY
   * (`20260706010000_intel_full_rls_hold`) scoped to `tenant_id`, but `clients`
   * is an apps/api-owned table read here via `withSystem` (outside the RLS
   * session), and (userId, clientId) — the pref unique key — carries no
   * tenant, so every pref WRITE must first prove the client belongs to the
   * caller (cross-tenant review finding, PR-1).
   */
  async assertClientInTenant(tenantId: string, clientId: string): Promise<void> {
    if (!UUID_RE.test(clientId)) throw new NotFoundException('Client not found');
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM clients WHERE id = $1::uuid AND tenant_id = $2::uuid',
        clientId,
        tenantId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Client not found');
  }

  /**
   * Gate J (HP-06): 404 unless `alertId` belongs to BOTH this tenant and this
   * client. Generalizes the one place this predicate was previously inlined
   * correctly — `alert-packet.service.ts`'s `build()` — so every alert-bearing
   * route can share it instead of re-deriving it (or omitting it, as routes
   * 2-5 in J_INTEGRITY.md §1.1 did). 404, not 403 (MASTER §6/edge case 2): a
   * miss must not confirm that another client's alert exists. Does not special-
   * case `_all` — callers pass a real alertId here, and `_all` is only ever a
   * clientId, never an alertId (MASTER §6.3).
   */
  async assertAlertInClient(tenantId: string, clientId: string, alertId: string): Promise<void> {
    const alert = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findFirst({ where: { id: alertId, tenantId, clientId }, select: { id: true } }),
    );
    if (!alert) throw new NotFoundException('Alert not found');
  }

  /**
   * Gate J (HP-06) b-1/b-2: 404 unless `userId` is a member of this tenant.
   * `assignedTo` on work-state is a DB `users.id` UUID — confirmed by reading
   * `tenant-admin.service.ts:143` (`userId: m.user.id`), the SAME id
   * `GET /api/tenant-admin/team` returns and the Assign picker
   * (`TrackerFeedPanel.tsx`'s `<select>`) sends back. This is DELIBERATELY the
   * opposite id-space from `trackedBy`, which is a Clerk id — the exact trap
   * Gate H hit and got right for `trackedBy` (tracker-components.tsx:292-296);
   * getting `assignedTo` wrong here would repeat it in the other direction.
   * `withSystem`: `tenant_memberships`/`users` are apps/api-owned FORCE-RLS
   * tables, the same cross-schema-read posture as `assertClientInTenant`. No
   * status filter, matching `listTeam()` (`tenant-admin.service.ts:130-153`)
   * exactly — the roster the picker offers has none either, so this never
   * rejects an id the UI let someone pick.
   */
  async assertTenantMember(tenantId: string, userId: string): Promise<void> {
    if (!UUID_RE.test(userId)) throw new NotFoundException('User not found');
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT m.id::text AS id FROM tenant_memberships m JOIN users u ON u.id = m.user_id ' +
          'WHERE u.id = $1::uuid AND m.tenant_id = $2::uuid LIMIT 1',
        userId,
        tenantId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('User not found');
  }

  /**
   * The upsert's update-branch guard: the unique key is tenant-free, so a row
   * created under ANOTHER tenant (same user in two orgs) must read as absent —
   * mirrors getAlertPrefs's `row.tenantId === tenantId` read guard.
   */
  private async assertPrefRowTenant(
    tenantId: string,
    clientId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.findUnique({
        where: { userId_clientId: { userId, clientId } },
        select: { tenantId: true },
      }),
    );
    if (existing && existing.tenantId !== tenantId) throw new NotFoundException('Client not found');
  }

  async putAlertPrefs(
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutAlertPrefsInput,
  ) {
    return preferences.putAlertPrefs(this, tenantId, clientId, userId, input);
  }

  /**
   * Mark a verified phone on the user's pref (P1.1, called after OTP confirm —
   * ported from apps/api tracker.service.markPhoneVerified). The confirm flow
   * is the ONLY path that grants `smsPhoneVerified` (putAlertPrefs can revoke it),
   * preserving the legacy consent contract. Client-ownership + row-tenant
   * guards mirror legacy's assertClient (cross-tenant review finding, PR-1).
   */
  async markPhoneVerified(
    tenantId: string,
    clientId: string,
    userId: string,
    phone: string,
  ): Promise<void> {
    return preferences.markPhoneVerified(this, tenantId, clientId, userId, phone);
  }

  async getCompiled(
    tenantId: string,
    clientId: string,
  ): Promise<CompiledWatchlist & { jurisdictions: string[]; termSurfaces: Record<string, TermRoute['surfaces']> }> {
    return compiled.getCompiled(this, tenantId, clientId);
  }

  /**
   * Facility-derived jurisdiction hint for a client (S5.1) — the exact
   * suggestedIssueAreas precedent (getSectorSuggestion above): read-only,
   * never written, absent once the client has explicitly configured
   * jurisdictions. withSystem because client_facilities is an apps/api-owned
   * table intel-api has no Prisma model for, not because intel_* lacks RLS.
   */
  async suggestedJurisdictions(tenantId: string, clientId: string): Promise<string[]> {
    return read.suggestedJurisdictions(this, tenantId, clientId);
  }
}
