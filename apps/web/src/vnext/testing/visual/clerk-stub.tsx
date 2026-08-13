import type { ReactNode } from 'react';

/**
 * Clerk stub for the Clerk-free vNext visual harness.
 *
 * `vite.harness.config.ts` aliases `@clerk/clerk-react` onto this module, and
 * NOTHING else does — the app's own `vite.config.ts` is untouched, so the
 * production bundle still resolves the real SDK.
 *
 * Why this exists: `AppShellUuiView` renders the real `NotificationBell`
 * (shell/TopBar/index.tsx), which calls `useNotifications()` ->
 * `useApi()` -> Clerk's `useAuth()`. Clerk's `useAuth` throws outside a
 * `ClerkProvider`, so the whole harness tree unmounted and `#root` stayed
 * empty. Mounting a real `ClerkProvider` was rejected: it would need a
 * well-formed publishable key and would reach the network on load, which is
 * exactly what this harness exists to avoid.
 *
 * The stub returns a signed-out, fully-loaded session. `getToken` resolves to
 * null, so the axios client sends no Authorization header, every request 401s
 * and react-query surfaces `isError` — which the bell already renders as its
 * honest "Notifications unavailable" state. Nothing here fabricates data: the
 * harness shows the same unavailable state a real signed-out user would see.
 */

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: false,
    userId: null,
    sessionId: null,
    orgId: null,
    orgRole: null,
    orgSlug: null,
    has: () => false,
    signOut: async () => undefined,
    getToken: async () => null,
  };
}

export function useUser() {
  return { isLoaded: true, isSignedIn: false, user: null };
}

export function useClerk() {
  return {
    loaded: true,
    signOut: async () => undefined,
    openSignIn: () => undefined,
    openUserProfile: () => undefined,
  };
}

export function useSignUp() {
  return { isLoaded: true, signUp: undefined, setActive: async () => undefined };
}

export function ClerkProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/** Auth screens are never mounted by the harness; render nothing if reached. */
export function SignIn() {
  return null;
}

export function SignUp() {
  return null;
}
