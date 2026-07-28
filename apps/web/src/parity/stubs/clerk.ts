/*
 * Phase 7 parity harness — the only two Clerk surfaces the Strategy Planner
 * touches. Aliased in vite.parity.config.ts; never part of a product build.
 */
export function useUser() {
  return {
    isLoaded: true,
    isSignedIn: true,
    user: { id: 'user_parity', firstName: 'Neo', lastName: 'Martinez' },
  };
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true,
    orgId: 'org_parity',
    getToken: async () => 'parity-token',
  };
}
