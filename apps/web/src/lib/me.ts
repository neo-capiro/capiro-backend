import { useQuery } from '@tanstack/react-query';
import type { TenantRole } from '@capiro/shared';
import { useApi } from './use-api.js';

export interface MeResponse {
  user: {
    id: string;
    clerkUserId: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    title: string | null;
    // Append-by-default preference + whether a signature exists. The signature
    // HTML itself is loaded on demand via GET /api/me/email-signature.
    emailSignatureEnabled: boolean;
    hasEmailSignature: boolean;
    /** Onboarding v1 (Flow 2B.4): the first-login tour was finished/skipped. */
    tourCompleted: boolean;
  };
  tenant: { id: string; slug: string; name: string };
  role: TenantRole;
  /**
   * Billing permission (onboarding v1 "Super Admin"): true for capiro_admin
   * and for user_admins whose membership carries billing_admin. Drives the
   * Billing/AI-usage tab visibility and every purchase/upgrade CTA.
   */
  billingAdmin: boolean;
  /**
   * Per-tenant feature flags the client needs to route/render. `meetingsV2`
   * gates the redesigned Engagement → Meetings module (Day/Month/List, sharing,
   * Library, Documents integration); default false until flipped per tenant.
   */
  features: {
    meetingsV2: boolean;
  };
}

export function useMe() {
  const api = useApi();
  return useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: async () => (await api.get<MeResponse>('/api/me')).data,
    staleTime: 30_000,
    retry: false,
  });
}
