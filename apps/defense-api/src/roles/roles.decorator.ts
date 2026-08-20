import { SetMetadata } from '@nestjs/common';

export type DefenseRole = 'capiro_admin' | 'user_admin' | 'standard_user' | 'client_portal_user';

export const ROLES_KEY = 'defense:roles';

/** Local @Roles() decorator, distinct from @capiro/auth's exported Roles
 * (which the defense-member-resolver imports for its own purposes elsewhere
 * is not the case here — this module intentionally defines its own metadata
 * key so RolesGuard's contract stays self-contained to defense-api). */
export const Roles = (...roles: DefenseRole[]) => SetMetadata(ROLES_KEY, roles);
