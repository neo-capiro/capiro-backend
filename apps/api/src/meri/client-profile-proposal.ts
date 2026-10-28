import { effectiveClientSlots } from '@capiro/shared';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CLIENT_PROFILE_PREFLIGHT_KEY,
  createClientInput,
} from './client-record-action.contract.js';

/**
 * Preparation evidence recorded on a generated create_client proposal. Deliberately
 * bounded: a duplicate is reported as an enum, never as an id or a name, so a
 * precheck can report that a client exists without disclosing one the caller
 * cannot see.
 */
export const clientProfilePreflightSchema = z
  .object({
    duplicate: z.enum(['clear', 'possible', 'unknown']),
    capacity: z.enum(['allowed', 'denied', 'unknown']),
  })
  .strict();
export type ClientProfilePreflight = z.infer<typeof clientProfilePreflightSchema>;

/** The capacity rule the atomic apply owner applies, as read-only facts. */
export type ClientProfileCapacityFacts =
  | { state: 'exempt' }
  | { state: 'limited'; limit: number; used: number }
  | { state: 'unavailable' };

export function clientProfilePreflightVerdict(facts: {
  existingClientNamed: boolean | null;
  capacity: ClientProfileCapacityFacts;
}): ClientProfilePreflight {
  return {
    duplicate:
      facts.existingClientNamed === null
        ? 'unknown'
        : facts.existingClientNamed
          ? 'possible'
          : 'clear',
    capacity:
      facts.capacity.state === 'exempt'
        ? 'allowed'
        : facts.capacity.state === 'unavailable'
          ? 'unknown'
          : facts.capacity.used < facts.capacity.limit
            ? 'allowed'
            : 'denied',
  };
}

/** The preflight a stored proposal recorded. Null for every non-create action and
 * for rows written before the field existed. */
export function readClientProfilePreflight(preview: unknown): ClientProfilePreflight | null {
  const parsed = clientProfilePreflightSchema.safeParse(
    (preview as Record<string, unknown> | null)?.[CLIENT_PROFILE_PREFLIGHT_KEY],
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Informational duplicate/capacity precheck for a generated create_client
 * proposal. It takes no lock, reserves nothing, implies no approval, writes
 * nothing and starts no generation: the atomic duplicate and capacity checks at
 * apply remain the only authority, and this verdict is never consulted there.
 * A precheck that cannot read the current state is reported as unknown rather
 * than as a clear preflight.
 */
export async function readCreateClientPreflight(
  prisma: PrismaService,
  tenantId: string,
  tool: string,
  input: Record<string, unknown>,
  billingEnforced: boolean,
): Promise<ClientProfilePreflight | null> {
  if (tool !== 'create_client') return null;
  const parsed = createClientInput.safeParse(input);
  if (!parsed.success) return null;
  const name = parsed.data.name;
  try {
    const facts: { existingClientNamed: boolean | null; capacity: ClientProfileCapacityFacts } =
      await prisma.withTenant(
        tenantId,
        async (tx) => {
          const existing = await tx.client.findFirst({
            where: {
              tenantId,
              name: { equals: name, mode: 'insensitive' },
              status: { not: 'archived' },
            },
            select: { id: true },
          });
          const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { billingStatus: true, clientSlots: true },
          });
          if (!tenant)
            return {
              existingClientNamed: existing !== null,
              capacity: { state: 'unavailable' as const },
            };
          if (!billingEnforced || tenant.billingStatus === 'comped')
            return {
              existingClientNamed: existing !== null,
              capacity: { state: 'exempt' as const },
            };
          const used = await tx.client.count({
            where: { tenantId, status: { not: 'archived' } },
          });
          return {
            existingClientNamed: existing !== null,
            capacity: {
              state: 'limited' as const,
              limit: effectiveClientSlots(tenant.billingStatus, tenant.clientSlots),
              used,
            },
          };
        },
        { readOnly: true },
      );
    return clientProfilePreflightVerdict(facts);
  } catch {
    return { duplicate: 'unknown', capacity: 'unknown' };
  }
}
