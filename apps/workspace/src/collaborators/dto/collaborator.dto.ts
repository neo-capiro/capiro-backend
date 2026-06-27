import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';

// Assignable roles (the synthetic "owner" is never assignable via the API).
const ASSIGNABLE_ROLES = ['editor', 'reviewer', 'commenter', 'viewer'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * Invite a collaborator. Exactly one identity is provided by the caller:
 *  - `subjectId` — an internal teammate the web app resolved to a Clerk user
 *    (via useTenantMembers / GET /api/tenant-members) → joins as `active`.
 *  - `email`     — an external client SME (raw email) → joins as `pending`.
 * `name` is the optional denormalized display name for the access list.
 */
export class InviteCollaboratorDto {
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() name?: string;
  @IsIn(ASSIGNABLE_ROLES) role!: AssignableRole;
}

/** Change a collaborator's role (owner-only; the Owner row is synthetic). */
export class UpdateCollaboratorDto {
  @IsIn(ASSIGNABLE_ROLES) role!: AssignableRole;
}
