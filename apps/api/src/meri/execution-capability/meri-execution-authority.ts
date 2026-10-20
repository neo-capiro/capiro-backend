import { Logger, type Provider } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createCoreKmsSigner,
  readCoreEd25519KeyConfig,
  type CoreEd25519KeyConfig,
} from '../../auth/core-ed25519-kms-config.js';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import type { MeriExecutionTrust } from './meri-execution-capability.js';

/**
 * Server-side wiring shared by Core's execution issuance route and its
 * `create_task` receiver (D016 #9). One KMS `ECC_NIST_EDWARDS25519` key, pure
 * Ed25519, created only in the deployment packet. Without the four
 * `MERI_EXECUTION_SIGNER_*` values both routes answer 503 and nothing is
 * issued or received; a partial or invalid set is logged and treated the same.
 */
export const MERI_EXECUTION_KEY_CONFIG = Symbol('MERI_EXECUTION_KEY_CONFIG');
export const MERI_EXECUTION_SIGNER = Symbol('MERI_EXECUTION_SIGNER');

export const meriExecutionKeyConfigProvider: Provider = {
  provide: MERI_EXECUTION_KEY_CONFIG,
  useFactory: (): CoreEd25519KeyConfig | null => {
    try {
      return readCoreEd25519KeyConfig(process.env, 'MERI_EXECUTION_SIGNER');
    } catch (error) {
      new Logger('MeriExecutionAuthority').error(`execution signer disabled: ${(error as Error).message}`);
      return null;
    }
  },
};

export const meriExecutionSignerProvider: Provider = {
  provide: MERI_EXECUTION_SIGNER,
  useFactory: (config: CoreEd25519KeyConfig | null): CoreEd25519Signer | null => (config ? createCoreKmsSigner(config) : null),
  inject: [MERI_EXECUTION_KEY_CONFIG],
};

/** The pinned trust for Core's own verifier: exactly the configured key. */
export function meriExecutionTrust(config: CoreEd25519KeyConfig, nowMs: number): MeriExecutionTrust {
  return { issuer: config.issuer, keys: Object.freeze({ [config.kid]: config.publicKey }), nowMs };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Serializes issuance and receipt for one (tenant, proposal) on the caller's
 * transaction. The namespace keeps it apart from unrelated advisory locks; a
 * hash collision can only over-serialize.
 */
export async function lockMeriExecutionProposal(tx: Prisma.TransactionClient, tenantId: string, proposalId: string): Promise<void> {
  if (!UUID.test(tenantId) || !UUID.test(proposalId)) throw new Error('invalid execution lock key');
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(
    hashtextextended('capiro-meri-execution:' || ${tenantId}::text || ':' || ${proposalId}::text, 0::bigint))::text AS locked`;
}

/**
 * True when every client id is a lowercase UUID naming an existing,
 * non-archived client of the tenant that the actor may see now: an unwalled
 * client, or a walled one with the actor's `client_memory_access` grant (the
 * same predicate as `fetchAccessibleClientRevisionsForClerkActor`). An empty
 * list is true. Runs on the caller's transaction.
 */
export async function meriExecutionClientsVisible(
  tx: Prisma.TransactionClient, tenantId: string, actorId: string, clientIds: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(clientIds)];
  if (ids.length === 0) return true;
  if (ids.length > 100 || ids.some((id) => !UUID.test(id)) || !UUID.test(tenantId) || !UUID.test(actorId)) return false;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id::text AS id FROM clients c
     WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ANY(${ids}::uuid[]) AND c.status::text <> 'archived'
       AND (NOT c.memory_wall OR EXISTS (
         SELECT 1 FROM client_memory_access a
          WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id AND a.user_id = ${actorId}::uuid))`;
  return Array.isArray(rows) && rows.length === ids.length && rows.every((r) => ids.includes(r.id));
}

/** The database clock on the caller's transaction (the effect-boundary recheck). */
export async function meriExecutionDbNow(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ db_now: Date }>>`SELECT clock_timestamp() AS db_now`;
  const at = Array.isArray(rows) && rows[0]?.db_now instanceof Date ? rows[0].db_now.getTime() : NaN;
  if (!Number.isSafeInteger(at)) throw new Error('database clock unavailable');
  return at;
}
