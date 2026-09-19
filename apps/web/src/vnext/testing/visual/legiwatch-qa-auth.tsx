import type { ReactNode } from 'react';

const auth = {
  isLoaded: true,
  isSignedIn: true,
  userId: 'qa-user',
  sessionId: 'qa-session',
  orgId: 'qa-org',
  getToken: async () => 'qa-token',
  has: () => true,
};
const user = {
  isLoaded: true,
  isSignedIn: true,
  user: { id: 'qa-user', fullName: 'LegiWatch QA', firstName: 'QA', lastName: 'Harness' },
};
const clerk = { signOut: async () => undefined, openUserProfile: () => undefined };

export const useAuth = () => auth;
export const useUser = () => user;
export const useClerk = () => clerk;
export const useSignUp = () => ({ isLoaded: true });
export const SignIn = () => null;
export const SignUp = () => null;
export function ClerkProvider({ children }: { children: ReactNode }) {
  return children;
}
