import { createHash } from 'node:crypto';

/** Shared by the dormant claim verifier and a future pre-dispatch writer. */
export const MERI_PHASE4_AUTHORIZATION_POLICY_VERSION = 'meri-phase4-policy-v1' as const;
const DOMAIN = 'capiro.meri.phase4.current-authorization/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MeriPhase4AuthorizationMaterialV2 {
  tenantId: string;
  actorId: string;
  role: string;
  policyVersion: string;
  grantVersion: string;
  authorizedClientIds: readonly string[];
  authorizedMailboxConnectionIds: readonly string[];
}

/** The database's per-tenant revision is the grant/revocation generation. */
export function meriPhase4GrantVersionV2(revision: bigint): string {
  if (revision <= 0n || revision > 9_223_372_036_854_775_807n) {
    throw new Error('invalid authority revision');
  }
  return `g2:${revision}`;
}

/** Full SHA-256, domain separated, length-framed and uniquely sorted. */
export function computeMeriPhase4AuthorizationVersionV2(
  material: MeriPhase4AuthorizationMaterialV2,
): string {
  const grantRevision = /^g2:([1-9][0-9]{0,18})$/.exec(material.grantVersion)?.[1];
  if (!UUID.test(material.tenantId) || !UUID.test(material.actorId) ||
      !material.role || material.policyVersion !== MERI_PHASE4_AUTHORIZATION_POLICY_VERSION ||
      !grantRevision || BigInt(grantRevision) > 9_223_372_036_854_775_807n) {
    throw new Error('invalid current authorization material');
  }
  const clients = [...material.authorizedClientIds].sort();
  const mailboxes = [...material.authorizedMailboxConnectionIds].sort();
  for (const ids of [clients, mailboxes]) {
    if (ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) {
      throw new Error('invalid current authorization set');
    }
  }
  const parts = [DOMAIN, material.tenantId, material.actorId, material.role,
    material.policyVersion, material.grantVersion,
    String(clients.length), ...clients, String(mailboxes.length), ...mailboxes];
  const digest = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return `m4a2:${digest.digest('hex')}`;
}
