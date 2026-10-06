import type { MeResponse } from '../../../lib/me.js';

/**
 * The only tenant that can open Business Development. Every other tenant sees
 * the Portfolio → Business Development entry greyed out, even when its own
 * `businessDevelopment` flag is on.
 */
export const BUSINESS_DEVELOPMENT_TENANT_SLUG = 'capiro-internal';

/**
 * Whether the signed-in tenant can open Business Development: it must be
 * `capiro-internal` AND have the tenant flag exactly true. Missing, loading or
 * errored /me fails closed. The API still guards every route on the flag.
 */
export function businessDevelopmentAvailable(me: MeResponse | undefined): me is MeResponse {
  return (
    me?.tenant.slug === BUSINESS_DEVELOPMENT_TENANT_SLUG &&
    me.features.businessDevelopment === true
  );
}
