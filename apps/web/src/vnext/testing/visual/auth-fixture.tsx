import type { ReactNode } from 'react';

// Offline, signed-out state for the visual entry points only. This module is
// selected by vite.visual.config.ts; it never produces an authentication token.
const auth = {
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  sessionId: null,
  orgId: null,
  getToken: async () => null,
  has: () => false,
};
const user = { isLoaded: true, isSignedIn: false, user: null };
const unsupported = () => {
  throw new Error('Interactive authentication is unavailable in visual fixtures');
};
const clerk = { signOut: unsupported, openUserProfile: unsupported };

export const useAuth = () => auth;
export const useUser = () => user;
export const useClerk = () => clerk;
export const useSignUp = unsupported;
export const SignIn = unsupported;
export const SignUp = unsupported;
export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}
