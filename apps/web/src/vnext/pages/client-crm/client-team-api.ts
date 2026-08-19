import type { AxiosInstance } from 'axios';

/**
 * Client account team — the firm's own users assigned to a client.
 *
 * Mirrors apps/api/src/clients/client-team.controller.ts, mounted at
 * `/api/clients/:clientId/team`.
 *
 * The roster the server returns MERGES two sources: the account owner (the
 * `clients.account_owner_user_id` column, flagged `isOwner`) and the
 * `client_team_members` rows. The owner is not stored twice, so `isOwner` rows
 * carry `id: null` and cannot be removed through this API — reassigning the
 * owner is `/api/client-account-owners/:clientId`.
 *
 * `userId` goes in the body on add and as a query parameter on delete, matching
 * the targets API's convention for member-scoped deletes.
 */

export interface ClientTeamMember {
  /** Membership row id; null for the account owner (a `clients` column). */
  id: string | null;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Free text, e.g. "Lead lobbyist"; null = on the team, no stated role. */
  role: string | null;
  isOwner: boolean;
  addedAt: string | null;
}

/** Display name, falling back to the email when no name is recorded. */
export function teamMemberLabel(member: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return name || member.email;
}

export function clientTeamKey(clientId: string): readonly [string, string] {
  return ['client-team', clientId] as const;
}

export async function getClientTeam(
  api: AxiosInstance,
  clientId: string,
): Promise<ClientTeamMember[]> {
  return (await api.get<ClientTeamMember[]>(`/api/clients/${encodeURIComponent(clientId)}/team`)).data;
}

/**
 * Add a user to the account team, or update the role of someone already on it
 * (the server upserts on (tenant, client, user)). Returns the whole refreshed
 * roster, so callers do not need a follow-up read.
 */
export async function addClientTeamMember(
  api: AxiosInstance,
  clientId: string,
  userId: string,
  role: string | null,
): Promise<ClientTeamMember[]> {
  return (
    await api.post<ClientTeamMember[]>(`/api/clients/${encodeURIComponent(clientId)}/team`, {
      userId,
      // Omit rather than send '' — the DTO's @IsOptional() skips only
      // null/undefined, so an empty string would fail validation.
      ...(role ? { role } : {}),
    })
  ).data;
}

export async function removeClientTeamMember(
  api: AxiosInstance,
  clientId: string,
  userId: string,
): Promise<ClientTeamMember[]> {
  return (
    await api.delete<ClientTeamMember[]>(`/api/clients/${encodeURIComponent(clientId)}/team`, {
      params: { userId },
    })
  ).data;
}
