import { useMutation, useQuery } from '@tanstack/react-query';
import type { BillingSummary } from '@capiro/shared';
import { useApi } from './use-api.js';

/**
 * Minimal billing posture — safe for EVERY role (no costs, prices, or payment
 * info). Powers the BillingGate paywall, trial banner, and slot counters.
 */
export interface BillingState {
  billingEnabled: boolean;
  status: BillingSummary['status'];
  slots: number;
  usedSlots: number;
  trialEndsAt: string | null;
  onboardingFlowVersion: number | null;
}

export function useBillingState() {
  const api = useApi();
  return useQuery<BillingState>({
    queryKey: ['billing', 'state'],
    queryFn: async () => (await api.get<BillingState>('/api/billing/state')).data,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Full tenant billing detail (plan, slots, LLM usage, payment posture). Gated
 * server-side to billing admins (user_admin + billing_admin) and capiro_admin —
 * everyone else 403s (billing is entirely hidden from non-billing-admins).
 */
export function useBilling() {
  const api = useApi();
  return useQuery<BillingSummary>({
    queryKey: ['billing', 'summary'],
    queryFn: async () => (await api.get<BillingSummary>('/api/billing/summary')).data,
    staleTime: 30_000,
    retry: false,
  });
}

// Billing MUTATIONS live on onboard-api (the single Stripe writer, onboarding
// v1). Same-origin path — the ALB forwards /onboard-api/* to that service.

/** Open Stripe Checkout for `quantity` slots (+ optional promo). Redirects on success. */
export function useCheckout() {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { quantity: number; promoCode?: string }) => {
      const { url } = (await api.post<{ url: string }>('/onboard-api/billing/checkout', input))
        .data;
      return url;
    },
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });
}

/** Open the Stripe Customer Portal (manage payment, change slots, invoices). */
export function usePortal() {
  const api = useApi();
  return useMutation({
    mutationFn: async () => {
      const { url } = (await api.post<{ url: string }>('/onboard-api/billing/portal', {})).data;
      return url;
    },
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });
}
