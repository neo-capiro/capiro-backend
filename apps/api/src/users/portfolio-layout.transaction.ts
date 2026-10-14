import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ApplicationAuthorityIdentityProof } from '../auth/application-authority.js';
import { applicationAuthorityIdentityReceipt } from '../auth/application-authority.js';
import { fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import {
  decodeSavedPortfolioLayout, normalizePortfolioLayoutCatalog, planPortfolioLayoutRead,
  planPortfolioLayoutWrite, portfolioLayoutReceipt, type PortfolioLayoutInput,
  type PortfolioLayoutReceipt, type SavedPortfolioLayout,
} from './portfolio-layout.helpers.js';

type Tx = Prisma.TransactionClient;
type Owner = { tenantId: string; userId: string };
const rowColumns = `tenant_id::text AS "tenantId", user_id::text AS "userId", version,
  client_order AS "clientOrder", updated_at AS "updatedAt"`;

/** The existing request owner remains the authority decision, including impersonation. */
export async function recheckPortfolioLayoutAuthority(proof: ApplicationAuthorityIdentityProof, owner: Owner): Promise<void> {
  const current = applicationAuthorityIdentityReceipt(await proof.recheckCurrent());
  if (current.principal.tenantId !== owner.tenantId || current.principal.actorId !== owner.userId ||
      current.identityRevision !== proof.identityRevision || current.expiresAtMs !== proof.expiresAtMs) {
    throw new ForbiddenException('Application authority unavailable');
  }
}

export function assertPortfolioLayoutAuthority(proof: ApplicationAuthorityIdentityProof, owner: Owner): void {
  const current = applicationAuthorityIdentityReceipt(proof);
  if (current.principal.tenantId !== owner.tenantId || current.principal.actorId !== owner.userId) {
    throw new ForbiddenException('Application authority unavailable');
  }
}

/** Lock supersets stabilize the canonical proof; none of these rows grant access. */
async function lockAuthorityFacts(tx: Tx, owner: Owner): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${owner.tenantId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.current_user', ${owner.userId}, true)`;
  await tx.$queryRawUnsafe(`SELECT id FROM users WHERE id = $1::uuid FOR SHARE`, owner.userId);
  const memberships = await tx.$queryRawUnsafe<Array<{ tenantId: string }>>(
    `SELECT tenant_id::text AS "tenantId" FROM tenant_memberships
     WHERE user_id = $1::uuid ORDER BY tenant_id, id FOR SHARE`, owner.userId,
  );
  const tenants = [...new Set([owner.tenantId, ...memberships.map((row) => row.tenantId)])].sort();
  await tx.$queryRawUnsafe(`SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`, tenants);
  await tx.$queryRawUnsafe(`SELECT id FROM impersonation_sessions
    WHERE actor_user_id = $1::uuid AND tenant_id = $2::uuid ORDER BY id FOR SHARE`, owner.userId, owner.tenantId);
}

/** Full nonarchived statuses, native actor UUID and the existing ethical-wall helper. */
async function readVisibleCatalog(tx: Tx, owner: Owner): Promise<string[]> {
  // Match the canonical wall roster writer's client-before-grant lock order.
  const clients = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id::text FROM clients WHERE tenant_id = $1::uuid AND status::text <> 'archived'
     ORDER BY id FOR SHARE`, owner.tenantId,
  );
  await tx.$queryRawUnsafe(`SELECT a.id FROM client_memory_access a
    JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1::uuid AND a.user_id = $2::uuid AND c.status::text <> 'archived'
    ORDER BY a.client_id, a.id FOR SHARE OF a`, owner.tenantId, owner.userId);
  const denied = new Set(await fetchDeniedClientIds(tx, owner.tenantId, owner.userId));
  return normalizePortfolioLayoutCatalog(clients.filter((row) => !denied.has(row.id)).map((row) => row.id));
}

function conflict(): never {
  throw new ConflictException({ code: 'PORTFOLIO_LAYOUT_VERSION_CONFLICT', message: 'Saved layout changed. Reload before saving.' });
}

/** Called once in the existing Prisma owner's Serializable transaction; never retries. */
export async function transactPortfolioLayout(
  tx: Tx, owner: Owner, proof: ApplicationAuthorityIdentityProof, input?: PortfolioLayoutInput,
): Promise<PortfolioLayoutReceipt> {
  // Separate native tenant/user compound key; mutex never grants resource authority.
  await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    `capiro:portfolio-layout:v1:${owner.tenantId}:${owner.userId}`);
  await lockAuthorityFacts(tx, owner);
  await recheckPortfolioLayoutAuthority(proof, owner);
  const catalog = await readVisibleCatalog(tx, owner);
  const rows = await tx.$queryRawUnsafe<unknown[]>(`SELECT ${rowColumns} FROM user_portfolio_layouts
    WHERE tenant_id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, owner.tenantId, owner.userId);
  if (rows.length > 1) throw new ServiceUnavailableException('Saved layout is unavailable');
  let saved: SavedPortfolioLayout | null = rows.length ? decodeSavedPortfolioLayout(rows[0], owner.tenantId, owner.userId) : null;
  const plan = input ? planPortfolioLayoutWrite(saved, input, catalog) : planPortfolioLayoutRead(saved, catalog);
  if (input || (saved && 'changed' in plan && plan.changed)) {
    const changed = saved
      ? await tx.$queryRawUnsafe<unknown[]>(`UPDATE user_portfolio_layouts
          SET client_order = $3::uuid[], version = $4, updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND version = $5 RETURNING ${rowColumns}`,
          owner.tenantId, owner.userId, plan.clientOrder, plan.version, saved.version)
      : await tx.$queryRawUnsafe<unknown[]>(`INSERT INTO user_portfolio_layouts
          (tenant_id, user_id, client_order, version) VALUES ($1::uuid, $2::uuid, $3::uuid[], $4)
          ON CONFLICT (tenant_id, user_id) DO NOTHING RETURNING ${rowColumns}`,
          owner.tenantId, owner.userId, plan.clientOrder, plan.version);
    if (changed.length !== 1) conflict();
    saved = decodeSavedPortfolioLayout(changed[0], owner.tenantId, owner.userId);
    if (saved.version !== plan.version || saved.clientOrder.length !== plan.clientOrder.length ||
        saved.clientOrder.some((id, index) => id !== plan.clientOrder[index])) {
      throw new ServiceUnavailableException('Saved layout is unavailable');
    }
  }
  await recheckPortfolioLayoutAuthority(proof, owner);
  return portfolioLayoutReceipt(owner.tenantId, owner.userId, saved, catalog);
}

/** Only a connector's explicit confirmed-abort code becomes a save conflict. */
export function portfolioLayoutFailure(error: unknown, writing: boolean): never {
  if (error instanceof ForbiddenException || error instanceof ConflictException || error instanceof ServiceUnavailableException) throw error;
  const native = error as { code?: unknown; meta?: { code?: unknown } } | null;
  if (writing && (native?.code === 'P2034' ||
      (native?.code === 'P2010' && ['40001', '40P01'].includes(native.meta?.code as string)))) conflict();
  // Includes unknown commit outcomes: no automatic callback or request replay.
  throw new ServiceUnavailableException({ code: 'PORTFOLIO_LAYOUT_UNAVAILABLE', message: 'Saved layout is unavailable. Reload before saving.' });
}
